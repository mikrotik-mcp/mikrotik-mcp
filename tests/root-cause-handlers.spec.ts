import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { rootCauseTools } from "../src/tools/root-cause";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();
const resource = `uptime: 5d10h58m58s
version: 7.24.5 (stable)
free-memory: 606.4MiB
total-memory: 1024.0MiB
cpu-load: 7%
architecture-name: arm64`;

function handler(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = rootCauseTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing root-cause tool ${name}`);
  return Promise.resolve(tool.handler(args as never, ctx)).then((result) =>
    typeof result === "string" ? result : result.text,
  );
}

beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  command.mockReset();
  command.mockResolvedValue("");
});
afterEach(() => setConfig(initial));

describe("read-only root-cause tool handlers", () => {
  test("resource-only diagnosis parses the RouterOS v7 key/value output and never writes", async () => {
    command.mockImplementation(async (text) => (text === "/system resource print" ? resource : ""));
    const result = await handler("diagnose", { target: "8.8.8.8", dimensions: ["resources"] });
    expect(result).toContain("CPU load: 7%");
    expect(result).toContain("Memory: 41% used");
    expect(command.mock.calls.map(([text]) => text)).toEqual(["/system resource print"]);
  });

  test("active=yes default route is recognized without relying on console flags", async () => {
    command.mockImplementation(async (text) =>
      text === "/ip route print detail"
        ? "0 dst-address=0.0.0.0/0 gateway=192.0.2.1 active=yes distance=1"
        : "",
    );
    const result = await handler("diagnose", { target: "8.8.8.8", dimensions: ["routing"] });
    expect(result).toContain("Default route present");
    expect(result).not.toContain("No default route — device cannot reach the internet");
    expect(command.mock.calls.some(([text]) => text === "/routing bgp peer print detail")).toBe(
      true,
    );
  });

  test("empty route output is treated as missing evidence rather than a missing default route", async () => {
    const result = await handler("diagnose", { target: "8.8.8.8", dimensions: ["routing"] });
    expect(result).toContain("Route data unavailable");
    expect(result).not.toContain("No default route — device cannot reach the internet");
  });

  test("full diagnosis collects all dimensions, parses records, and contains a reported symptom", async () => {
    const responses: Record<string, string> = {
      "/interface print detail": "0 R name=ether1 type=ether mtu=1500 tx-error=0 rx-error=0",
      "/ip route print detail": "0 As dst-address=0.0.0.0/0 gateway=192.0.2.1 distance=1",
      "/ip firewall filter print detail":
        "0 chain=forward action=drop packets=4 bytes=400 dst-address=8.8.8.8",
      "/ip firewall nat print detail": "0 chain=srcnat action=masquerade packets=2 bytes=200",
      "/ip firewall connection print count-only": "2",
      "/ip dhcp-server lease print detail":
        "0 address=192.0.2.5 status=bound host-name=client server=dhcp1",
      "/system resource print": resource,
      ":put [/ip dns get servers]": "1.1.1.1",
      ":put [/ip dns get dynamic-servers]": "",
      ":put [/ip dns get allow-remote-requests]": "no",
      "/ping 8.8.8.8 count=5": "sent=5 received=5 packet-loss=0%",
    };
    command.mockImplementation(async (text) => responses[text] ?? "");
    const result = await handler("diagnose", { target: "8.8.8.8", symptom: "slow" });
    expect(result).toContain('Reported symptom: "slow"');
    expect(result).toContain("Target 8.8.8.8 is reachable (0% loss)");
    expect(result).toContain("Firewall rule #0");
    expect(
      command.mock.calls.some(
        ([text]) => text.includes(" add ") || text.includes(" set ") || text.includes(" remove "),
      ),
    ).toBe(false);
    expect(command.mock.calls.length).toBeGreaterThan(15);
  });

  test("path trace separates a reachable path from no traceroute data", async () => {
    command.mockImplementation(async (text) =>
      text.startsWith("/ping")
        ? "sent=5 received=5 packet-loss=0%"
        : text.startsWith("/ip route")
          ? "0 As dst-address=0.0.0.0/0 gateway=192.0.2.1"
          : "",
    );
    const result = await handler("trace_path", { target: "8.8.8.8", count: 3, use_dns: false });
    expect(result).toContain("End-to-end: REACHABLE");
    expect(result).toContain("Traceroute returned no data");
    expect(result).toContain("Path is healthy");
    expect(command.mock.calls[0][0]).toBe("/tool traceroute 8.8.8.8 count=3 use-dns=no");
  });

  test("event correlation groups real log records and recognizes routing/auth sequences", async () => {
    const logs = [
      '0 time=12:00 topics=interface message="ether1 link down"',
      '1 time=12:01 topics=ospf message="neighbor lost"',
      '2 time=12:02 topics=account message="login failure"',
    ].join("\n");
    command.mockResolvedValue(logs);
    const result = await handler("correlate_events", {
      keyword: "ether1",
      topics: "interface,ospf",
      time_window: "1h",
      limit: 3,
    });
    expect(result).toContain("EVENT CORRELATION");
    expect(result).toContain("Interface link-down events detected");
    expect(result).toContain("Routing protocol events");
    expect(result).toContain("Authentication failures detected");
    expect(command.mock.calls[0][0]).toContain('topics~"interface|ospf"');
  });

  test("fix suggestions are text only: even actionable route fixes never execute a write", async () => {
    command.mockResolvedValueOnce("0 dst-address=192.0.2.0/24 gateway=ether1 active=yes");
    const result = await handler("suggest_fix", { target: "8.8.8.8", dimensions: ["routing"] });
    expect(result).toContain("FIX SUGGESTIONS");
    expect(result).toContain("Missing default route");
    expect(result).toContain("Review each command before applying");
    expect(command.mock.calls.every(([text]) => /print/.test(text))).toBe(true);
  });
});
