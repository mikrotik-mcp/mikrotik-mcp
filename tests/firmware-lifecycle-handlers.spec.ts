import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { firmwareLifecycleTools } from "../src/tools/firmware-lifecycle";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const original = getConfig();
const ctx: ToolContext = { device: "lab", info: vi.fn(), error: vi.fn() };
const available =
  "channel: stable\ninstalled-version: 7.20\nlatest-version: 7.21\nstatus: New version is available";
const current =
  "channel: stable\ninstalled-version: 7.21\nlatest-version: 7.21\nstatus: System is already up to date";

function tool(name: string) {
  const found = firmwareLifecycleTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing firmware tool: ${name}`);
  return found;
}

beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { lab: { host: "192.0.2.1", port: 22 }, edge: { host: "192.0.2.2", port: 22 } },
      defaultDevice: "lab",
    }),
  );
  command.mockReset();
  command.mockImplementation(async (text) => {
    if (text === "/system resource print")
      return "version: 7.20\narchitecture-name: arm64\nboard-name: lab\nuptime: 1d\ncpu-load: 12\nfree-memory: 536870912\ntotal-memory: 1073741824";
    if (text === "/system package print detail")
      return "0 name=routeros version=7.20 disabled=false";
    if (text === "/system routerboard print")
      return "model: hAP ax3\ncurrent-firmware: 7.20\nupgrade-firmware: 7.21";
    if (text === "/system package update print") return available;
    if (text === "/ip route print count-only") return "3";
    if (text === "/interface print detail")
      return "0 R name=ether1 running=true\n1 name=ether2 running=false";
    if (text === "/ppp active print count-only") return "2";
    if (text.includes("dhcp-server lease print count-only")) return "4";
    return "";
  });
});
afterEach(() => setConfig(original));

test("single and fleet checks read firmware state for the selected routers", async () => {
  const single = await tool("firmware_check").handler({ fleet: false }, ctx);
  expect(single).toContain("7.21");
  expect(command.mock.calls.map(([text]) => text)).toContain(
    "/system package update check-for-updates once",
  );

  command.mockClear();
  const fleet = await tool("firmware_check").handler(
    { fleet: true, devices: ["lab", "edge"] },
    ctx,
  );
  expect(fleet).toContain("lab");
  expect(fleet).toContain("edge");
  expect(
    command.mock.calls.filter(([text]) => text === "/system package update check-for-updates once"),
  ).toHaveLength(2);
});

test("fleet check rejects unknown router names before any device command", async () => {
  expect(await tool("firmware_check").handler({ fleet: true, devices: ["ghost"] }, ctx)).toContain(
    "Unknown device(s): ghost",
  );
  expect(command).not.toHaveBeenCalled();
});

test("firmware stage does not download when no update is available", async () => {
  command.mockImplementation(async (text) =>
    text === "/system package update print" ? current : "",
  );
  const result = await tool("firmware_stage").handler({}, ctx);
  expect(result).toContain("No update available");
  expect(command.mock.calls.map(([text]) => text)).not.toContain("/system package update download");
});

test("firmware stage sets a channel, downloads, and reports post-download status", async () => {
  const result = await tool("firmware_stage").handler({ channel: "stable" }, ctx);
  expect(result).toContain("FIRMWARE STAGED");
  expect(result).toContain("7.21");
  expect(command.mock.calls.map(([text]) => text)).toContain(
    "/system package update set channel=stable",
  );
  expect(command.mock.calls.map(([text]) => text)).toContain("/system package update download");
});

test("firmware stage aborts after channel or download failure", async () => {
  command.mockImplementation(async (text) =>
    text.includes("set channel=") ? "failure: denied" : "",
  );
  expect(await tool("firmware_stage").handler({ channel: "stable" }, ctx)).toContain(
    "Failed to set channel",
  );
  expect(command.mock.calls.map(([text]) => text)).not.toContain("/system package update download");
  command.mockImplementation(async (text) =>
    text === "/system package update print"
      ? available
      : text.endsWith("update download")
        ? "failure: disk full"
        : "",
  );
  expect(await tool("firmware_stage").handler({}, ctx)).toContain(
    "Failed to download update packages",
  );
});

test("upgrade requires confirmation and an available version", async () => {
  expect(await tool("firmware_upgrade").handler({ confirm: false }, ctx)).toContain(
    "Upgrade not confirmed",
  );
  expect(command).not.toHaveBeenCalled();
  command.mockImplementation(async (text) =>
    text === "/system package update print" ? current : "",
  );
  expect(await tool("firmware_upgrade").handler({ confirm: true }, ctx)).toContain(
    "No update available",
  );
  expect(command.mock.calls.map(([text]) => text)).not.toContain("/system package update install");
});

test("scheduled upgrade captures health and creates one scheduler entry", async () => {
  const result = await tool("firmware_upgrade").handler(
    {
      confirm: true,
      schedule_time: "03:00:00",
      schedule_date: "oct/25/2026",
      upgrade_routerboard: true,
      capture_health: true,
    },
    ctx,
  );
  expect(result).toContain("FIRMWARE UPGRADE SCHEDULED");
  expect(result).toContain("PRE-UPGRADE HEALTH SNAPSHOT");
  const issued = command.mock.calls.map(([text]) => text);
  expect(issued.some((text) => text.includes("/system scheduler remove"))).toBe(true);
  expect(
    issued.some(
      (text) =>
        text.includes("/system scheduler add") &&
        text.includes("03:00:00") &&
        text.includes("oct/25/2026"),
    ),
  ).toBe(true);
  expect(issued).not.toContain("/system package update install");
});

test("immediate upgrade initiates install only after readiness check", async () => {
  const result = await tool("firmware_upgrade").handler(
    { confirm: true, capture_health: false, upgrade_routerboard: true },
    ctx,
  );
  expect(result).toContain("UPGRADE INITIATED");
  const issued = command.mock.calls.map(([text]) => text);
  expect(issued).toContain("/system routerboard upgrade");
  expect(issued).toContain("/system package update install");
  expect(issued.indexOf("/system routerboard upgrade")).toBeLessThan(
    issued.indexOf("/system package update install"),
  );
});

test("post-upgrade status compares versions and reports pending RouterBOARD firmware", async () => {
  const result = await tool("firmware_status").handler(
    { post_check: true, pre_snapshot_version: "7.19" },
    ctx,
  );
  expect(result).toContain("POST-UPGRADE HEALTH SNAPSHOT");
  expect(result).toContain("Version upgraded: 7.19 → 7.20");
  expect(result).toContain("RouterBOARD firmware upgrade available");
  expect(command.mock.calls.map(([text]) => text)).toContain(
    '/system scheduler print detail where name="mcp-firmware-upgrade"',
  );
});
