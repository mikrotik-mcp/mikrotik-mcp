/**
 * Terminal output of `mikrotik-mcp-service status` and `mikrotik-mcp-upgrade`:
 * the banner, the panels, and the facts they are built from. Pure rendering —
 * no service manager, no network.
 */
import figlet from "figlet";
import { describe, expect, it } from "vite-plus/test";
import {
  BANNER,
  banner,
  panel,
  parseLaunchctl,
  parseSystemd,
  renderStatus,
  uptime,
} from "../scripts/service.ts";
import type { ServiceReport } from "../scripts/service.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (text: string) => text.replace(ANSI, "");

const healthy: ServiceReport = {
  platform: "darwin",
  running: true,
  pid: 4242,
  uptime: "2h 3m",
  installed: "6.13.0",
  serving: "6.13.0",
  latest: "6.13.0",
  tools: 983,
  mcp: "http://127.0.0.1:8000/mcp",
  dashboard: "http://127.0.0.1:9090",
  dashboardUp: true,
  config: "/etc/mikrotik/devices.json",
  devices: { total: 4, enabled: 3 },
  data: "/var/lib/mikrotik-mcp",
  logs: "/var/log/mikrotik-mcp.err",
  commands: "/opt/bun/bin",
  bun: "1.4.4  /opt/bun/bin/bun",
};

describe("banner", () => {
  it("is the same figlet art the server prints at startup", () => {
    // service.ts cannot import figlet (it also runs as a lone copied file), so
    // the art is embedded. This keeps it from drifting from src/cli-logo.ts.
    const art = figlet.textSync("MikroTik MCP", { font: "Small" }).split("\n");
    expect(BANNER).toEqual(art.filter((line) => line.trim() !== ""));
  });

  it("is coloured only when colour is on, and never changes the characters", () => {
    const off = banner("status", false);
    const on = banner("status", true);
    expect(off).not.toMatch(ANSI);
    expect(on).toMatch(ANSI);
    expect(plain(on)).toBe(off);
    expect(off).toContain("Shared service · status");
  });
});

describe("panel", () => {
  it("draws a closed box with aligned labels, whatever the colour setting", () => {
    for (const on of [false, true]) {
      const lines = plain(
        panel(
          "Files",
          [
            ["Config", "/a"],
            ["Logs", "/a/long/path"],
          ],
          on,
        ),
      ).split("\n");
      expect(lines[0]).toMatch(/^ {2}╭─ Files ─+╮$/);
      expect(lines.at(-1)).toMatch(/^ {2}╰─+╯$/);
      expect(new Set(lines.map((line) => line.length)).size).toBe(1);
      expect(lines[1]).toContain("│ Config  /a");
      expect(lines[2]).toContain("│ Logs    /a/long/path");
    }
  });

  it("honours a minimum width so stacked panels line up", () => {
    const narrow = plain(panel("A", [["k", "v"]], false)).split("\n")[0].length;
    const wide = plain(panel("A", [["k", "v"]], false, 40)).split("\n")[0].length;
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBe(40 + 6);
  });
});

describe("facts", () => {
  it.each([
    ["03:04", "3m 4s"],
    ["02:03:04", "2h 3m"],
    ["1-02:03:04", "1d 2h"],
    ["  12:00:59\n", "12h 0m"],
  ])("uptime(%j) = %s", (etime, expected) => {
    expect(uptime(etime)).toBe(expected);
  });
  it("uptime rejects anything that is not ps elapsed time", () => {
    expect(uptime("")).toBeUndefined();
    expect(uptime("yesterday")).toBeUndefined();
  });

  it("reads state and pid from launchctl print", () => {
    const text = "gui/501/dev.usestrict.mikrotik-mcp = {\n\tstate = running\n\tpid = 64562\n}";
    expect(parseLaunchctl(text)).toEqual({ running: true, pid: 64562 });
    expect(parseLaunchctl("\tstate = not running\n")).toEqual({ running: false });
    expect(parseLaunchctl("")).toEqual({ running: false });
  });

  it("reads state and pid from systemctl show", () => {
    expect(parseSystemd("ActiveState=active\nMainPID=812\n")).toEqual({ running: true, pid: 812 });
    expect(parseSystemd("ActiveState=inactive\nMainPID=0\n")).toEqual({ running: false });
    expect(parseSystemd("ActiveState=activating\nMainPID=9\n")).toEqual({ running: false, pid: 9 });
  });
});

describe("status screen", () => {
  it("shows every fact when all is well", () => {
    const out = renderStatus(healthy, false);
    for (const expected of [
      "● running  pid 4242 · up 2h 3m",
      "launchd LaunchAgent",
      "6.13.0 running and installed",
      "6.13.0 · up to date",
      "983 in tools/list",
      "http://127.0.0.1:8000/mcp  ✓ answering",
      "http://127.0.0.1:9090      ✓ answering",
      "/etc/mikrotik/devices.json  4 devices, 3 enabled",
      "/var/log/mikrotik-mcp.err",
      "Everything is in order.",
    ]) {
      expect(out).toContain(expected);
    }
    // The three panels share one width.
    const tops = out.split("\n").filter((line) => line.includes("╭─"));
    expect(tops).toHaveLength(3);
    expect(new Set(tops.map((line) => line.length)).size).toBe(1);
  });

  it("says a restart is needed when the running version is older than the installed one", () => {
    const out = renderStatus({ ...healthy, serving: "6.12.0" }, false);
    expect(out).toContain("6.12.0 running · 6.13.0 installed");
    expect(out).toContain("Apply it: mikrotik-mcp-service restart");
    expect(out).not.toContain("Everything is in order.");
  });

  it("offers the upgrade command when a newer version exists", () => {
    const out = renderStatus({ ...healthy, latest: "6.14.0" }, false);
    expect(out).toContain("6.14.0 available");
    expect(out).toContain("Update available: 6.13.0 → 6.14.0. Run: mikrotik-mcp-upgrade");
  });

  it("does not offer an upgrade for an older or equal registry version", () => {
    expect(renderStatus({ ...healthy, latest: "6.9.9" }, false)).not.toContain("Update available");
    expect(
      renderStatus(
        { ...healthy, installed: "6.13.10", serving: "6.13.10", latest: "6.13.9" },
        false,
      ),
    ).not.toContain("Update available");
  });

  it("reports a stopped service and unknown facts without inventing them", () => {
    const out = renderStatus(
      {
        ...healthy,
        running: false,
        pid: undefined,
        uptime: undefined,
        serving: undefined,
        tools: undefined,
        latest: undefined,
        devices: undefined,
        dashboardUp: false,
      },
      false,
    );
    expect(out).toContain("○ stopped");
    expect(out).toContain("6.13.0 installed");
    expect(out).toContain("could not reach the npm registry");
    expect(out).toContain("✗ no answer");
    expect(out).toContain("The service is not running. Start it: mikrotik-mcp-service restart");
    expect(out).not.toContain("in tools/list");
    expect(out).not.toContain("devices,");
  });

  it("warns when the process runs but MCP does not answer", () => {
    const out = renderStatus({ ...healthy, serving: undefined, tools: undefined }, false);
    expect(out).toContain("● running");
    expect(out).toContain("MCP does not answer yet");
  });

  it("colour changes nothing but the colour", () => {
    expect(plain(renderStatus(healthy, true))).toBe(renderStatus(healthy, false));
  });
});
