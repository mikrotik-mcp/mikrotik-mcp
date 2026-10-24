import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { txnRoutes } from "../../src/observability/txn-routes";

const mocks = vi.hoisted(() => ({
  txnStore: vi.fn(),
  listTxns: vi.fn(),
  getTxn: vi.fn(),
  dropTxn: vi.fn(),
  persistTxn: vi.fn(),
  toRecord: vi.fn(),
  liveTxnUpdates: vi.fn(),
  requestAbort: vi.fn(),
  runTransaction: vi.fn(),
  createDeviceExecutor: vi.fn(),
  createContext: vi.fn(),
}));
vi.mock("../../src/txn/session", () => ({
  txnStore: mocks.txnStore,
  listTxns: mocks.listTxns,
  getTxn: mocks.getTxn,
  dropTxn: mocks.dropTxn,
  persistTxn: mocks.persistTxn,
}));
vi.mock("../../src/txn/store", () => ({ toRecord: mocks.toRecord }));
vi.mock("../../src/observability/txn-hub", () => ({ liveTxnUpdates: mocks.liveTxnUpdates }));
vi.mock("../../src/txn/model", () => ({ requestAbort: mocks.requestAbort }));
vi.mock("../../src/txn/coordinator", () => ({
  runTransaction: mocks.runTransaction,
  createDeviceExecutor: mocks.createDeviceExecutor,
}));
vi.mock("../../src/core/context", () => ({ createContext: mocks.createContext }));

const live = { txn: { id: "live", state: "open" }, ts: 200, label: "current", steps: {} };
const stored = { id: "live", ts: 100, state: "old" };
const store = { list: vi.fn(), get: vi.fn(), events: vi.fn() };
async function route(path: string, method = "GET") {
  const url = new URL(path, "http://localhost");
  return txnRoutes(new Request(url, { method }), url);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.list.mockReturnValue([stored, { id: "history", ts: 50 }]);
  store.get.mockReturnValue(null);
  store.events.mockReturnValue([{ kind: "begin" }]);
  mocks.txnStore.mockResolvedValue(store);
  mocks.listTxns.mockReturnValue([live]);
  mocks.getTxn.mockImplementation((id: string) => (id === "live" ? live : undefined));
  mocks.toRecord.mockImplementation((txn: { id: string }, ts: number) => ({
    id: txn.id,
    ts,
    state: "live",
  }));
  mocks.liveTxnUpdates.mockReturnValue([{ id: "live" }]);
  mocks.requestAbort.mockReturnValue({ id: "live", state: "aborting" });
  mocks.runTransaction.mockResolvedValue({
    txn: { id: "live", state: "aborted" },
    state: "aborted",
    summary: "rolled back",
  });
});

describe("transaction dashboard routes", () => {
  test("merges live records over stored rows and limits newest first", async () => {
    const body = await (await route("/api/txn?limit=1"))?.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0]).toMatchObject({ id: "live", state: "live" });
    expect(store.list).toHaveBeenCalledWith(1);
  });

  test("serves live and historical detail with timeline, and reports unknown IDs", async () => {
    expect(await (await route("/api/txn/live"))?.json()).toMatchObject({
      transaction: { id: "live", state: "live" },
      events: [{ kind: "begin" }],
    });
    store.get.mockReturnValueOnce({ id: "history", ts: 50 });
    expect(await (await route("/api/txn/history"))?.json()).toMatchObject({
      transaction: { id: "history" },
    });
    expect((await route("/api/txn/missing"))?.status).toBe(404);
    expect((await route("/api/txn/a/b/c"))?.status).toBe(404);
    expect((await route("/api/txn/live", "POST"))?.status).toBe(405);
    expect(await route("/api/other")).toBeNull();
  });

  test("store failure still serves live records", async () => {
    mocks.txnStore.mockRejectedValue(new Error("disk unavailable"));
    expect(await (await route("/api/txn"))?.json()).toMatchObject({
      transactions: [{ id: "live" }],
      error: "disk unavailable",
    });
    expect(await (await route("/api/txn/live"))?.json()).toMatchObject({ events: [] });
  });

  test("abort runs a live transaction, persists the result, and drops a terminal entry", async () => {
    expect((await route("/api/txn/missing/abort", "POST"))?.status).toBe(404);
    const response = await route("/api/txn/live/abort", "POST");
    expect(await response?.json()).toMatchObject({ state: "aborted", summary: "rolled back" });
    expect(mocks.requestAbort).toHaveBeenCalledWith(
      expect.objectContaining({ id: "live" }),
      "aborted from the dashboard",
    );
    expect(mocks.persistTxn).toHaveBeenCalledWith(live);
    expect(mocks.dropTxn).toHaveBeenCalledWith("live");
  });
});
