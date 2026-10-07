import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  getUmLastConnections,
  umConnectionDate,
} from "../../src/observability/um-last-connections";

const read = vi.hoisted(() => vi.fn());
const access = vi.hoisted(() => vi.fn());
const restore = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: read }));
vi.mock("../../src/core/scoped-access", () => ({ assertDeviceAccess: access }));
vi.mock("../../src/observability/um-report-cache", () => ({
  loadUmReportCache: restore,
  umReportCachePath: () => "private-cache",
}));
const original = getConfig();
beforeEach(() => {
  vi.useFakeTimers();
  setConfig(
    MikrotikConfigSchema.parse({ defaultDevice: "edge", devices: { edge: { host: "192.0.2.1" } } }),
  );
  read.mockReset().mockResolvedValue("[]");
  restore.mockReset().mockResolvedValue(undefined);
  access.mockReset();
});
afterEach(() => {
  setConfig(original);
  vi.useRealTimers();
});
const settle = () => vi.advanceTimersByTimeAsync(0);
const row = (id = "*1", user = "alice", started = "2026-10-05 23:45:56") => ({
  ".id": id,
  user,
  started,
});
const collect = async () => {
  getUmLastConnections("edge");
  await settle();
  return getUmLastConnections("edge");
};
const seed = (rows: ReturnType<typeof row>[]) =>
  restore.mockResolvedValue({
    collectedAt: Date.now() - 1000,
    sources: { sessions: { available: true, rows } },
  });

test("normalizes modern and legacy dates without timezone conversion or invented dates", () => {
  expect(umConnectionDate("2026-10-05 23:45:56")).toBe("2026-10-05 23:45:56");
  expect(umConnectionDate("oct/5/2026 23:45:56")).toBe("2026-10-05 23:45:56");
  expect(umConnectionDate("2026-10-05 23:45:56.123")).toBe("2026-10-05 23:45:56");
  for (const invalid of [
    undefined,
    42,
    "never",
    "",
    "1970-01-01 00:00:00",
    "2026-02-30 01:02:03",
    "feb/30/2026 01:02:03",
    "2026-10-05 25:00:00",
  ])
    expect(umConnectionDate(invalid)).toBeNull();
});

test("coalesces native reads, compares unordered dates and polls only new or unknown records", async () => {
  let finish!: (raw: string) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(getUmLastConnections("edge").status).toBe("pending");
  expect(getUmLastConnections("edge").status).toBe("pending");
  await settle();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][0]).toContain("value=[/user-manager session find]");
  expect(read.mock.calls[0][0]).not.toMatch(/count-only|foreach/);
  expect(read.mock.calls[0][2]).toEqual({ maxMs: 60_000 });
  read.mockResolvedValueOnce(
    JSON.stringify([
      row("*2"),
      row("*1", "alice", "2026-10-04 20:00:00"),
      row("*3", "bob", "never"),
    ]),
  );
  finish('["*1","*2","*3"]');
  await settle();
  expect([...getUmLastConnections("edge").values]).toEqual([["alice", "2026-10-05 23:45:56"]]);
  expect(read.mock.calls[1][0]).toContain("from=*1,*2,*3");
  await vi.advanceTimersByTimeAsync(29_999);
  getUmLastConnections("edge");
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  read
    .mockResolvedValueOnce('["*1","*2","*3","*4"]')
    .mockResolvedValueOnce(
      JSON.stringify([row("*3", "bob"), row("*4", "alice", "2026-10-06 10:00:00")]),
    );
  expect(getUmLastConnections("edge").status).toBe("stale");
  await settle();
  expect(read.mock.calls[3][0]).toContain("from=*3,*4");
  expect([...getUmLastConnections("edge").values]).toEqual([
    ["alice", "2026-10-06 10:00:00"],
    ["bob", "2026-10-05 23:45:56"],
  ]);
});

test("seeds saved dates while live refresh is pending and fetches only new records", async () => {
  seed([row()]);
  let finish!: (raw: string) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect((await collect()).values.get("alice")).toBe("2026-10-05 23:45:56");
  read.mockResolvedValueOnce(JSON.stringify([row("*2", "bob")]));
  finish('["*1","*2"]');
  await settle();
  expect(read.mock.calls[1][0]).toContain("from=*2");
  expect(getUmLastConnections("edge").values.size).toBe(2);
});

test("saved history larger than a wire page seeds without rereading every session", async () => {
  const rows = Array.from({ length: 40_000 }, (_, i) => row(`*${(i + 1).toString(16)}`));
  expect(JSON.stringify(rows).length).toBeGreaterThan(2 * 1024 * 1024);
  seed(rows);
  read.mockResolvedValueOnce(JSON.stringify(rows.map((r) => r[".id"])));
  expect((await collect()).status).toBe("ready");
  expect(read).toHaveBeenCalledTimes(1);
});

test("invalid cached identities do not block a fresh collection", async () => {
  seed([row("malformed")]);
  read.mockResolvedValueOnce('["*1"]').mockResolvedValueOnce(JSON.stringify([row()]));
  expect((await collect()).values.get("alice")).toBe("2026-10-05 23:45:56");
});

test("removes purged history and periodically reconciles reused IDs", async () => {
  seed([row("*1"), row("*2", "alice", "2026-10-06 10:00:00")]);
  read.mockResolvedValueOnce('["*1"]');
  expect((await collect()).values.get("alice")).toBe("2026-10-05 23:45:56");
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  read.mockResolvedValueOnce('["*1"]').mockResolvedValueOnce(JSON.stringify([row("*1", "bob")]));
  expect([...(await collect()).values]).toEqual([["bob", "2026-10-05 23:45:56"]]);
});

test("pages large histories and never publishes partial results", async () => {
  seed([row()]);
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  const rows = Array.from({ length: 2001 }, (_, i) => row(`*${(i + 1).toString(16)}`, "bob"));
  read
    .mockResolvedValueOnce(JSON.stringify(rows.map((r) => r[".id"])))
    .mockResolvedValueOnce(JSON.stringify(rows.slice(0, 2000)))
    .mockResolvedValueOnce("[]");
  const state = await collect();
  expect(read).toHaveBeenCalledTimes(3);
  expect(state.status).toBe("stale");
  expect([...state.values]).toEqual([["alice", "2026-10-05 23:45:56"]]);
});

test("preserves cached dates on failure without retry storms", async () => {
  seed([row()]);
  read.mockResolvedValueOnce('["*1"]');
  await collect();
  await vi.advanceTimersByTimeAsync(30_000);
  read.mockRejectedValueOnce(new Error("offline"));
  const state = await collect();
  expect(state.status).toBe("stale");
  expect(state.values.get("alice")).toBe("2026-10-05 23:45:56");
  getUmLastConnections("edge");
  expect(read).toHaveBeenCalledTimes(2);
});

test("configuration replacements discard old in-flight history and prevent subsequent page reads", async () => {
  let finish!: (raw: string) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await collect();
  setConfig(MikrotikConfigSchema.parse(getConfig()));
  finish('["*1"]');
  await settle();
  expect(read).toHaveBeenCalledTimes(1);
  expect(getUmLastConnections("edge").values.size).toBe(0);
  await settle();
});

test("denied session access never returns cached history or reads the router", async () => {
  seed([row()]);
  read.mockResolvedValueOnce('["*1"]');
  await collect();
  access.mockImplementation(() => {
    throw new Error("denied");
  });
  expect(getUmLastConnections("edge")).toEqual({ status: "unavailable", values: new Map() });
  expect(read).toHaveBeenCalledTimes(1);
});

test.each([
  "failure: not enough permissions",
  '{"truncated":',
  "null",
  "23782\r\n",
  '["*1","*1"]',
  '["*1;:error injected"]',
  '[{"alice":"2026-10-05 23:45:56"}]',
])("invalid identities are unavailable, not invented history: %s", async (raw) => {
  read.mockResolvedValue(raw);
  expect(await collect()).toEqual({
    status: "unavailable",
    values: new Map(),
    collectedAt: undefined,
  });
});

test("rejects oversized histories before issuing page commands", async () => {
  read.mockResolvedValueOnce(
    JSON.stringify(Array.from({ length: 100_001 }, (_, i) => `*${i.toString(16)}`)),
  );
  expect((await collect()).status).toBe("unavailable");
  expect(read).toHaveBeenCalledTimes(1);
});
