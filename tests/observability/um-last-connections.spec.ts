import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  getUmLastConnections,
  umConnectionDate,
} from "../../src/observability/um-last-connections";

const read = vi.hoisted(() => vi.fn());
const access = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: read }));
vi.mock("../../src/core/scoped-access", () => ({ assertDeviceAccess: access }));
const original = getConfig();
beforeEach(() => {
  vi.useFakeTimers();
  setConfig(
    MikrotikConfigSchema.parse({ defaultDevice: "edge", devices: { edge: { host: "192.0.2.1" } } }),
  );
  read.mockReset().mockResolvedValue("{}");
  access.mockReset();
});
afterEach(() => {
  setConfig(original);
  vi.useRealTimers();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

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

test("returns immediately, shares one bounded read and expires after thirty seconds", async () => {
  let finish!: (raw: string) => void;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(getUmLastConnections("edge").status).toBe("pending");
  expect(getUmLastConnections("edge").status).toBe("pending");
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][0]).toContain("$started > $previous");
  expect(read.mock.calls[0][0]).toContain("count-only] > 100000");
  expect(read.mock.calls[0][2]).toEqual({ maxMs: 15_000 });
  finish('{"alice":"2026-10-05 23:45:56","bob":"never"}');
  await settle();
  expect(getUmLastConnections("edge")).toMatchObject({ status: "ready" });
  expect(getUmLastConnections("edge").values.get("alice")).toBe("2026-10-05 23:45:56");
  expect(getUmLastConnections("edge").values.has("bob")).toBe(false);
  await vi.advanceTimersByTimeAsync(29_999);
  getUmLastConnections("edge");
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(getUmLastConnections("edge").status).toBe("stale");
  expect(read).toHaveBeenCalledTimes(2);
});

test("retains last known dates on failure and isolates config replacements", async () => {
  read.mockResolvedValueOnce('{"alice":"2026-10-05 23:45:56"}');
  getUmLastConnections("edge");
  await settle();
  await vi.advanceTimersByTimeAsync(30_000);
  read.mockRejectedValueOnce(new Error("offline"));
  getUmLastConnections("edge");
  await settle();
  expect(getUmLastConnections("edge").status).toBe("stale");
  expect(getUmLastConnections("edge").values.get("alice")).toBe("2026-10-05 23:45:56");
  const before = read.mock.calls.length;
  getUmLastConnections("edge");
  expect(read).toHaveBeenCalledTimes(before);
  setConfig(MikrotikConfigSchema.parse(getConfig()));
  expect(getUmLastConnections("edge").values.size).toBe(0);
});

test("denied session access never returns cached history or reads the router", async () => {
  read.mockResolvedValueOnce('{"alice":"2026-10-05 23:45:56"}');
  getUmLastConnections("edge");
  await settle();
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
  '[{"alice":"2026-10-05 23:45:56"}]',
])("invalid results are unavailable, not invented history: %s", async (raw) => {
  read.mockResolvedValue(raw);
  getUmLastConnections("edge");
  await settle();
  expect(getUmLastConnections("edge")).toEqual({
    status: "unavailable",
    values: new Map(),
    collectedAt: undefined,
  });
});
