import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  createAddressIndexCache,
  searchAddressEntries,
} from "../../ui/observability/routing-address-search";
import type { AddressEntry } from "../../ui/observability/routing-address-search";

const rows = Array.from({ length: 205 }, (_, i) => ({
  ".id": `*${i}`,
  list: "services",
  address: `192.0.${Math.floor(i / 255)}.${i % 255}`,
  comment: i === 204 ? "Google production" : "Office",
}));
function loader() {
  return vi.fn(async (device: string, family: string, offset: number, _signal: AbortSignal) => ({
    device,
    family,
    offset,
    total: rows.length,
    rows: rows.slice(offset, offset + 200),
    nextOffset: offset + 200 < rows.length ? offset + 200 : undefined,
  }));
}
afterEach(() => vi.restoreAllMocks());
test("indexes every page and finds a fuzzy comment beyond the first 200 rows", async () => {
  const load = loader(),
    cache = createAddressIndexCache(load);
  const updates: number[] = [];
  const unsubscribe = cache.subscribe("lab", "ipv4", () =>
    updates.push(cache.get("lab", "ipv4").rows.length),
  );
  await cache.read("lab", "ipv4");
  const index = cache.get("lab", "ipv4");
  expect(index.status).toBe("ready");
  expect(updates).toEqual([0, 200, 205]);
  expect(load.mock.calls.map((c) => c[2])).toEqual([0, 200]);
  expect(
    searchAddressEntries(
      index.rows.map((row) => ({ row, family: "ipv4" })),
      "gogle production",
    ),
  ).toMatchObject([{ row: { ".id": "*204" }, match: "fuzzy" }]);
  await cache.read("lab", "ipv4");
  expect(load).toHaveBeenCalledTimes(2);
  unsubscribe();
});
test("cache separates routers/families and expires after 60 seconds", async () => {
  const time = vi.spyOn(Date, "now").mockReturnValue(1000);
  const load = loader(),
    cache = createAddressIndexCache(load);
  await cache.read("home", "ipv4");
  await cache.read("nl", "ipv4");
  await cache.read("home", "ipv6");
  expect(load).toHaveBeenCalledTimes(6);
  time.mockReturnValue(62000);
  await cache.read("home", "ipv4");
  expect(load).toHaveBeenCalledTimes(8);
});
test("rejects duplicates, changed totals, wrong router and missing pages without claiming completeness", async () => {
  for (const fault of ["duplicate", "total", "router", "cursor"] as const) {
    const base = loader();
    const load = vi.fn(async (...args: Parameters<typeof base>) => {
      const result = await base(...args);
      if (args[2] === 200) {
        if (fault === "duplicate") result.rows[0] = rows[0];
        if (fault === "total") result.total = 204;
        if (fault === "router") result.device = "other";
        if (fault === "cursor") result.nextOffset = 205;
      }
      return result;
    });
    const cache = createAddressIndexCache(load);
    await cache.read("lab", "ipv4");
    expect(cache.get("lab", "ipv4").status).toBe("error");
    expect(cache.get("lab", "ipv4").error).toBeTruthy();
  }
});
test("failed subsequent pages preserve partial results and can be retried", async () => {
  const load = loader();
  load
    .mockImplementationOnce(async (...args) => loader()(...args))
    .mockRejectedValueOnce(new Error("Device disconnected"));
  const cache = createAddressIndexCache(load);
  await cache.read("lab", "ipv4");
  expect(cache.get("lab", "ipv4")).toMatchObject({
    status: "error",
    error: "Device disconnected",
    total: 205,
  });
  expect(cache.get("lab", "ipv4").rows).toHaveLength(200);
  await cache.read("lab", "ipv4", true);
  expect(cache.get("lab", "ipv4").status).toBe("ready");
});
test("coalesces subscribers and discards late cancelled reads on close", async () => {
  let finish!: (value: Awaited<ReturnType<ReturnType<typeof loader>>>) => void;
  const load = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<ReturnType<typeof loader>>>>((resolve) => {
        finish = resolve;
      }),
  );
  const cache = createAddressIndexCache(load);
  const off = cache.subscribe("lab", "ipv4", vi.fn());
  const pending = cache.read("lab", "ipv4");
  await cache.read("lab", "ipv4");
  expect(load).toHaveBeenCalledOnce();
  off();
  finish({ device: "lab", family: "ipv4", offset: 0, total: 0, rows: [], nextOffset: undefined });
  await pending;
  expect(cache.get("lab", "ipv4").status).toBe("idle");
});
test("distinguishes complete empty indexes from read errors", async () => {
  const cache = createAddressIndexCache(async (device, family, offset) => ({
    device,
    family,
    offset,
    total: 0,
    rows: [],
  }));
  await cache.read("lab", "ipv4");
  expect(cache.get("lab", "ipv4")).toMatchObject({ status: "ready", rows: [], total: 0 });
});
test("ranks literal IP matches above fuzzy matches and supports IPv6, Persian digits and mixed tokens", () => {
  const entries: AddressEntry[] = [
    { family: "ipv4", row: { address: "8.8.8.9", list: "Google", comment: "Secondary resolver" } },
    { family: "ipv4", row: { address: "8.8.8.8", list: "Google", comment: "Primary resolver" } },
    {
      family: "ipv6",
      row: { address: "2001:db8::1", list: "production", comment: "Claude downloads" },
    },
  ];
  expect(searchAddressEntries(entries, "۸.۸.۸.۸").map((r) => r.match)).toEqual(["exact", "fuzzy"]);
  expect(searchAddressEntries(entries, "cluade 2001:db8")).toMatchObject([
    { family: "ipv6", match: "fuzzy" },
  ]);
  expect(searchAddressEntries(entries, "primary gogle")).toHaveLength(1);
  expect(searchAddressEntries(entries, "zzzz notfound")).toEqual([]);
  expect(searchAddressEntries(entries, "[.*")).toEqual([]);
  expect(searchAddressEntries(entries, "")).toHaveLength(3);
});
