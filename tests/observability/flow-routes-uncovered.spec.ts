import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { FlowRecord } from "../../src/flows/decode";
import { flowRoutes } from "../../src/observability/flow-routes";

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  drain: vi.fn(),
  query: vi.fn(),
  storeStats: vi.fn(),
  flowStore: vi.fn(),
}));
vi.mock("../../src/flows/collector", () => ({
  getFlowCollector: () => ({ stats: mocks.stats, drain: mocks.drain }),
}));
vi.mock("../../src/tools/traffic-flow", () => ({ flowStore: mocks.flowStore }));

const record: FlowRecord = {
  start: Date.now() - 60_000,
  end: Date.now() - 30_000,
  src: "192.0.2.1",
  dst: "198.51.100.2",
  srcPort: 50000,
  dstPort: 443,
  protocol: 6,
  bytes: 500,
  packets: 5,
  version: 5,
};
async function route(path: string, method = "GET") {
  const url = new URL(path, "http://localhost");
  return flowRoutes(new Request(url, { method }), url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stats.mockReturnValue({ received: 2 });
  mocks.storeStats.mockReturnValue({
    rawRows: 1,
    rollupRows: 0,
    oldestRaw: 1,
    newestRaw: 2,
    evicted: 0,
  });
  mocks.query.mockReturnValue([record]);
  mocks.flowStore.mockResolvedValue({ query: mocks.query, stats: mocks.storeStats });
});

describe("flow dashboard routes", () => {
  test("ignores unrelated paths and rejects writes", async () => {
    expect(await route("/api/other")).toBeNull();
    expect((await route("/api/flows/top", "POST"))?.status).toBe(405);
  });

  test("health reports collector counters even when storage is unavailable", async () => {
    expect(await (await route("/api/flows/health"))?.json()).toMatchObject({
      collector: { received: 2 },
      store: { rawRows: 1 },
    });
    mocks.flowStore.mockRejectedValueOnce(new Error("offline"));
    expect(await (await route("/api/flows/health"))?.json()).toEqual({
      collector: { received: 2 },
      store: null,
    });
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  test("top, conversation, and timeline routes query and aggregate the same records", async () => {
    const top = await (
      await route("/api/flows/top?window=5m&dimension=destination&limit=1&address=192.0.2.1")
    )?.json();
    expect(top.top[0].key).toBe(record.dst);
    expect(top.totals.bytes).toBe(500);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({ address: record.src, limit: 200_000 }),
    );
    const conversations = await (await route("/api/flows/conversations?limit=1"))?.json();
    expect(conversations.conversations[0]).toMatchObject({ src: record.src, dst: record.dst });
    const timeline = await (await route("/api/flows/timeline?window=24h&topN=1"))?.json();
    expect(timeline.bucketMs).toBe(1_440_000);
    expect(timeline.keys).toEqual([record.src]);
    expect(timeline.buckets.length).toBeGreaterThan(0);
    expect(mocks.drain).toHaveBeenCalledTimes(3);
  });

  test("storage failures return a bounded error and unknown paths return 404", async () => {
    mocks.flowStore.mockRejectedValueOnce("unavailable");
    expect(await (await route("/api/flows/top"))?.json()).toEqual({
      error: "unavailable",
      records: [],
    });
    expect((await route("/api/flows/missing"))?.status).toBe(404);
  });
});
