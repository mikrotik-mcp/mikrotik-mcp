import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { configDriftTools } from "../src/tools/config-drift";

const state = vi.hoisted(() => ({
  snapshots: new Map<string, { id: string; body: string; ts: number }>(),
  baseline: null as null | { snapshotId: string; setAt: number },
  safeCalls: [] as string[],
}));
const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({
    insert: (snap: { id: string; body: string; ts: number }) => state.snapshots.set(snap.id, snap),
    get: (id: string) => state.snapshots.get(id) ?? null,
    getBaseline: () => state.baseline,
    setBaseline: (_device: string, snapshotId: string) => {
      state.baseline = { snapshotId, setAt: Date.now() };
    },
  }),
}));
vi.mock("../src/drift/alert", () => ({ noteDriftResult: vi.fn() }));
vi.mock("../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({
    enable: async () => {
      state.safeCalls.push("enable");
      return "Safe Mode enabled";
    },
    execute: async (text: string) => {
      state.safeCalls.push(text);
      return "";
    },
    rollback: async () => {
      state.safeCalls.push("rollback");
    },
    commit: async () => {
      state.safeCalls.push("commit");
      return { ok: true, message: "committed" };
    },
  }),
}));

const original = getConfig();
const ctx: ToolContext = { device: "lab", info: vi.fn(), error: vi.fn() };
const exportText = "/ip ssh\nset strong-crypto=yes\n";
function tool(name: string) {
  const found = configDriftTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown drift tool ${name}`);
  return found;
}
beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { lab: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "lab",
    }),
  );
  state.snapshots.clear();
  state.baseline = null;
  state.safeCalls = [];
  command.mockReset().mockResolvedValue(exportText);
});
afterEach(() => setConfig(original));

test("drift check and promotion refuse missing baselines before router I/O", async () => {
  expect(
    await tool("config_check_drift").handler({ include_logs: false, max_output_lines: 100 }, ctx),
  ).toContain("No golden baseline");
  expect(await tool("config_promote_drift").handler({}, ctx)).toContain("No existing baseline");
  expect(command).not.toHaveBeenCalled();
});

test("baseline capture, drift report and promotion preserve snapshot history", async () => {
  expect(
    await tool("config_set_baseline").handler(
      { label: "approved", terse: true, show_sensitive: false },
      ctx,
    ),
  ).toContain("Golden baseline set");
  const oldId = state.baseline?.snapshotId;
  expect(command.mock.calls.map(([text]) => text)).toContain("/export terse");
  command.mockResolvedValueOnce("/ip ssh\nset strong-crypto=no\n");
  const drift = await tool("config_check_drift").handler(
    { include_logs: false, max_output_lines: 100 },
    ctx,
  );
  expect(drift).toContain("DRIFTED");
  expect(drift).toContain("/ip ssh");
  expect(
    await tool("config_promote_drift").handler({ label: "accepted", notes: "reviewed" }, ctx),
  ).toContain("Drift promoted");
  expect(state.snapshots.has(oldId!)).toBe(true);
});

test("reconcile dry-run applies commands only within mocked Safe Mode and rolls back", async () => {
  await tool("config_set_baseline").handler({ terse: true, show_sensitive: false }, ctx);
  const result = await tool("config_reconcile").handler({ confirm: false }, ctx);
  expect(result).toContain("DRY RUN");
  expect(state.safeCalls[0]).toBe("enable");
  expect(state.safeCalls.at(-1)).toBe("rollback");
  expect(state.safeCalls).not.toContain("commit");
});

test("deleted baseline snapshot is reported rather than silently re-created", async () => {
  state.baseline = { snapshotId: "missing", setAt: 1 };
  expect(
    await tool("config_check_drift").handler({ include_logs: false, max_output_lines: 100 }, ctx),
  ).toContain("has been deleted");
  expect(await tool("config_reconcile").handler({ confirm: false }, ctx)).toContain(
    "has been deleted",
  );
  expect(command).not.toHaveBeenCalled();
});
