/// <reference types="bun" />
/** The start summary: listen URLs, device rows and their text. */
import { expect, test } from "vite-plus/test";

const summary = await import("../src/cli-summary");
// Colour codes start with the escape character; build it so the source has no control character.
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "g");
const plain = (lines: string[]): string[] => lines.map((line) => line.replace(COLOUR, ""));

test("a wildcard bind answers on loopback and on every address of the machine", () => {
  const lan = ["172.28.40.13", "10.0.0.5"];
  expect(summary.listenUrls("0.0.0.0", 8081, "/mcp", lan)).toEqual([
    "http://127.0.0.1:8081/mcp",
    "http://172.28.40.13:8081/mcp",
    "http://10.0.0.5:8081/mcp",
  ]);
  expect(summary.listenUrls("127.0.0.1", 9091, "/", lan)).toEqual(["http://127.0.0.1:9091/"]);
  expect(summary.listenUrls("fd00::1", 80, "/", [])).toEqual(["http://[fd00::1]:80/"]);
});

const devices = {
  edge: { host: "10.0.0.1", port: 22, username: "admin", password: "secret" },
  home: { host: "192.168.88.1", port: 2222, username: "ali", jumpVia: "edge" },
  attic: { mac: "AA:BB:CC:DD:EE:FF", username: "admin" },
  old: { host: "10.0.0.9", port: 22, username: "admin", disabled: true },
  lab: { host: "10.0.0.7", port: 22, username: "admin" },
} as never;
const status = (name: string) =>
  ({
    edge: { reachable: false, checkedAt: 1, latencyMs: null, error: "connect timeout" },
    home: {
      reachable: true,
      checkedAt: 1,
      latencyMs: 41.6,
      identity: "home-ax3",
      version: "7.25.1",
      boardName: "hAP ax3",
      uptime: "2w1d",
    },
    attic: { reachable: null, checkedAt: null, latencyMs: null },
  })[name] as never;

test("each router has a row with its address, its path and its state; the default is first", () => {
  const rows = summary.deviceRows(devices, "home", status);
  expect(rows.map((row) => [row.name, row.address, row.via, row.state, row.detail])).toEqual([
    [
      "home",
      "ali@192.168.88.1:2222",
      "ssh via edge",
      "online",
      "42 ms · home-ax3 · RouterOS 7.25.1 · hAP ax3 · up 2w 1d",
    ],
    ["edge", "admin@10.0.0.1:22", "ssh", "offline", "connect timeout"],
    ["attic", "AA:BB:CC:DD:EE:FF", "mac-telnet", "unknown", "no answer yet"],
    ["old", "admin@10.0.0.9:22", "ssh", "disabled", "turned off in the config"],
    ["lab", "admin@10.0.0.7:22", "ssh", "unknown", "no answer yet"],
  ]);
  const text = plain(summary.deviceLines(rows)).join("\n");
  expect(text).toContain("5 configured · 1 online · 1 offline · 1 disabled · 2 no answer yet");
  expect(text).toContain("home (default)");
  // A password is never part of the summary.
  expect(text).not.toContain("secret");
});

test("an uptime shows its two largest units, apart", () => {
  expect(summary.shortUptime("24w2d20h24m9s")).toBe("24w 2d");
  expect(summary.shortUptime("3d13h59m15s")).toBe("3d 13h");
  expect(summary.shortUptime("45s")).toBe("45s");
  expect(summary.shortUptime("")).toBe("");
});

test("the endpoints say how to reach MCP and the dashboard, and never print the token", () => {
  const cfg = {
    mcp: { transport: "streamable-http", host: "0.0.0.0", port: 8081 },
    dashboard: { enabled: true, host: "127.0.0.1", port: 9091, token: "t0p-secret" },
  } as never;
  const text = plain(summary.endpointLines(cfg, ["172.28.40.13"])).join("\n");
  expect(text).toContain("MCP        http://127.0.0.1:8081/mcp  streamable-http");
  expect(text).toContain("http://172.28.40.13:8081/mcp");
  expect(text).toContain("Dashboard  http://127.0.0.1:9091/  token required");
  expect(text).not.toContain("t0p-secret");
  const stdio = { mcp: { transport: "stdio" }, dashboard: { enabled: false } } as never;
  expect(plain(summary.endpointLines(stdio, [])).join("\n")).toMatch(
    /MCP\s+stdio[\s\S]*Dashboard\s+off/,
  );
});
