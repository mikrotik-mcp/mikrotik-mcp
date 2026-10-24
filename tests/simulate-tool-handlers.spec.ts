import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { simulateTools } from "../src/tools/simulate";

const mocks = vi.hoisted(() => ({ command: vi.fn(), open: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/snapshots/store", () => ({ openSnapshotStore: mocks.open }));

const text =
  "/ip firewall filter\nadd chain=input action=accept src-address=192.0.2.0/24\nadd chain=input action=drop";
const packet = {
  src_address: "192.0.2.10",
  dst_address: "192.0.2.1",
  protocol: "tcp",
  dst_port: 22,
  in_interface: "ether1",
  connection_state: "new",
};
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();
const snapshot = { id: "snap-fixture", device: "fixture", body: text };

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = simulateTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown simulator tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.open.mockResolvedValue({ get: (id: string) => (id === snapshot.id ? snapshot : null) });
  mocks.command.mockResolvedValue(text);
});
afterEach(() => setConfig(initial));

test("inline simulation never reads the device and identifies the supplied source", async () => {
  const result = await call("simulate_packet", { ...packet, config_text: text });
  expect(result).toContain("SIMULATION — supplied text");
  expect(result).toContain("192.0.2.10");
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

test("stored snapshot simulation is local and missing snapshot is reported honestly", async () => {
  expect(await call("simulate_packet", { ...packet, snapshot_id: "missing" })).toContain(
    "No snapshot 'missing'",
  );
  expect(await call("simulate_packet", { ...packet, snapshot_id: "snap-fixture" })).toContain(
    "snapshot snap-fixture",
  );
  expect(mocks.command).not.toHaveBeenCalled();
});

test("live simulation only performs a read-only export and rejects empty output", async () => {
  expect(await call("simulate_packet", packet)).toContain("live config of fixture");
  expect(mocks.command).toHaveBeenCalledWith("/export terse", ctx);
  mocks.command.mockResolvedValueOnce("");
  expect(await call("simulate_packet", packet)).toContain("Failed to read the configuration");
  mocks.command.mockResolvedValueOnce("failure: permission denied");
  expect(await call("simulate_packet", packet)).toContain("permission denied");
});

test("change simulation ignores blank proposals and compares in-memory traces", async () => {
  expect(
    await call("simulate_change", { ...packet, config_text: text, changes: "  \n  " }),
  ).toContain("No changes supplied");
  const report = await call("simulate_change", {
    ...packet,
    config_text: text,
    changes: ["/ip firewall filter", "add chain=input action=drop src-address=192.0.2.10"],
  });
  expect(report).toContain("SIMULATED CHANGE — supplied text");
  expect(report).toContain("BEFORE");
  expect(report).toContain("AFTER");
  expect(report).toContain("Nothing was changed on any device");
  expect(mocks.command).not.toHaveBeenCalled();
});

test("reachability distinguishes no rules from a rule set", async () => {
  expect(await call("explain_rule_reachability", { config_text: "" })).toContain(
    "No firewall filter rules",
  );
  const report = await call("explain_rule_reachability", { config_text: text, chain: "input" });
  expect(report).toContain("REACHABILITY — supplied text");
  expect(mocks.command).not.toHaveBeenCalled();
});

test("packet suite reports each expected verdict without claiming unknown passes", async () => {
  const result = await call("simulate_suite", {
    config_text: text,
    packets: [
      { name: "allowed SSH", ...packet, expect: "accept" },
      { name: "blocked remote", ...packet, src_address: "198.51.100.10", expect: "drop" },
    ],
  });
  expect(result).toContain("PACKET SUITE — supplied text");
  expect(result).toContain("allowed SSH");
  expect(result).toContain("blocked remote");
  expect(result).toMatch(/\d\/2 passed/);
  expect(mocks.command).not.toHaveBeenCalled();
});
