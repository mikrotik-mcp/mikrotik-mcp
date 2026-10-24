import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { configSnapshotTools } from "../src/tools/config-snapshot";

const mocks = vi.hoisted(() => ({ command: vi.fn(), open: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/snapshots/store", () => ({ openSnapshotStore: mocks.open }));

const rows = new Map<string, Record<string, unknown>>();
const store = {
  latest: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  count: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
};
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = configSnapshotTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown snapshot tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.open.mockResolvedValue(store);
  mocks.command.mockResolvedValue("# RouterOS 7.24\n/ip address add address=192.0.2.1/24");
  store.latest.mockImplementation(() => [...rows.values()].at(-1) ?? null);
  store.get.mockImplementation((id) => rows.get(id) ?? null);
  store.list.mockImplementation((_device, limit) => [...rows.values()].slice(-limit));
  store.count.mockImplementation(() => rows.size);
  store.insert.mockImplementation((snapshot) => rows.set(snapshot.id, snapshot));
  store.delete.mockImplementation((ids: string[]) => {
    let removed = 0;
    for (const id of ids) if (rows.delete(id)) removed++;
    return removed;
  });
});
afterEach(() => setConfig(initial));

test("capture saves a host-side snapshot from a read-only RouterOS export", async () => {
  const result = await call("capture_config_snapshot", {
    label: "before-change",
    section: "ip address",
    terse: true,
    show_sensitive: false,
    force: false,
  });
  expect(result).toContain("First snapshot");
  expect(mocks.command).toHaveBeenCalledWith("/ip address export terse", ctx);
  expect(store.insert).toHaveBeenCalledWith(
    expect.objectContaining({ device: "fixture", label: "before-change" }),
  );
  const stored = [...rows.values()][0];
  expect(stored.body).toContain("/ip address add");
  expect(stored.sha).toBeTypeOf("string");
});

test("capture de-duplicates unchanged exports unless force is explicit", async () => {
  await call("capture_config_snapshot", { terse: true, show_sensitive: false, force: false });
  expect(
    await call("capture_config_snapshot", { terse: true, show_sensitive: false, force: false }),
  ).toContain("No configuration change");
  expect(store.insert).toHaveBeenCalledTimes(1);
  expect(
    await call("capture_config_snapshot", { terse: true, show_sensitive: false, force: true }),
  ).toContain("Changed since");
  expect(store.insert).toHaveBeenCalledTimes(2);
});

test("empty and failed device exports are not stored", async () => {
  mocks.command.mockResolvedValueOnce("");
  await expect(
    call("capture_config_snapshot", { terse: true, show_sensitive: false, force: false }),
  ).rejects.toThrow("no usable export");
  mocks.command.mockResolvedValueOnce("failure: denied");
  await expect(
    call("capture_config_snapshot", { terse: true, show_sensitive: false, force: false }),
  ).rejects.toThrow("no usable export");
  expect(store.insert).not.toHaveBeenCalled();
});

test("list and get distinguish absent snapshots, metadata and stored body", async () => {
  expect(await call("list_config_snapshots", { limit: 10 })).toContain(
    "No configuration snapshots",
  );
  expect(await call("get_config_snapshot", { id: "missing", include_body: true })).toContain(
    "not found",
  );
  await call("capture_config_snapshot", { terse: true, show_sensitive: false, force: false });
  const id = String([...rows.keys()][0]);
  expect(await call("list_config_snapshots", { limit: 10 })).toContain(id);
  expect(await call("get_config_snapshot", { id, include_body: false })).toContain(
    "SNAPSHOT METADATA",
  );
  expect(await call("get_config_snapshot", { id, include_body: true })).toContain(
    "--- begin export ---",
  );
});

test("diff resolves latest and live and reports identical versus changed exports", async () => {
  await call("capture_config_snapshot", { terse: true, show_sensitive: false, force: false });
  expect(
    await call("diff_config_snapshots", {
      from: "latest",
      to: "live",
      context_lines: 3,
      max_output_lines: 800,
    }),
  ).toContain("No differences");
  mocks.command.mockResolvedValueOnce("# RouterOS 7.24\n/ip address add address=198.51.100.1/24");
  const changed = await call("diff_config_snapshots", {
    from: "latest",
    to: "live",
    context_lines: 3,
    max_output_lines: 800,
  });
  expect(changed).toContain("+1 added");
  expect(changed).toContain("198.51.100.1/24");
  await expect(
    call("diff_config_snapshots", {
      from: "unknown",
      to: "latest",
      context_lines: 3,
      max_output_lines: 800,
    }),
  ).rejects.toThrow("not found");
});

test("local snapshot deletion reports an exact count without device access", async () => {
  expect(await call("remove_config_snapshot", { ids: ["missing"] })).toContain(
    "No snapshots removed",
  );
  await call("capture_config_snapshot", { terse: true, show_sensitive: false, force: false });
  const id = String([...rows.keys()][0]);
  mocks.command.mockClear();
  expect(await call("remove_config_snapshot", { ids: [id] })).toContain("Removed 1 snapshot");
  expect(rows.size).toBe(0);
  expect(mocks.command).not.toHaveBeenCalled();
});
