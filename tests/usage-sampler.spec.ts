import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import {
  sampleUsageOnce,
  startUsageSampler,
  stopUsageSampler,
  MIN_USAGE_INTERVAL_MS,
} from "../src/observability/usage-sampler";
import type { UsageStore } from "../src/observability/usage-store";
import { logger } from "../src/logger";

const read = vi.hoisted(() => vi.fn(async (_command: string) => ""));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: read }));
const original = getConfig();
const busyError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 });
function store() {
  return {
    recordClientSamples: vi.fn(),
    upsertSessions: vi.fn(() => 0),
    clientDailyUsage: vi.fn(() => []),
    umUserDailyUsage: vi.fn(() => []),
    umUsers: vi.fn(() => []),
    heatmap: vi.fn(() => []),
    pruneSamples: vi.fn(() => 0),
    close: vi.fn(),
  } satisfies UsageStore;
}
beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({ defaultDevice: "edge", devices: { edge: { host: "192.0.2.1" } } }),
  );
  read.mockReset().mockResolvedValue("");
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  stopUsageSampler();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setConfig(original);
});
test("retention contention never rejects the background pass, and the next pass recovers", async () => {
  const db = store();
  vi.mocked(db.pruneSamples).mockImplementationOnce(() => {
    throw busyError;
  });
  await expect(sampleUsageOnce(db)).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("retention cleanup"));
  await sampleUsageOnce(db);
  expect(db.pruneSamples).toHaveBeenCalledTimes(2);
});
test("non-lock retention errors remain visible without killing the sampler", async () => {
  const db = store();
  vi.mocked(db.pruneSamples).mockImplementation(() => {
    throw new Error("disk I/O error");
  });
  await expect(sampleUsageOnce(db)).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disk I/O error"));
});
test("a sample write failure is logged and retention still runs", async () => {
  const db = store();
  read.mockResolvedValue("0 target=192.0.2.10/32 bytes=1/2");
  vi.mocked(db.recordClientSamples).mockImplementation(() => {
    throw busyError;
  });
  await expect(sampleUsageOnce(db)).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining("usage sample failed for 'edge'"),
  );
  expect(db.pruneSamples).toHaveBeenCalledTimes(1);
});
test("immediate and periodic timer passes survive retention failures", async () => {
  vi.useFakeTimers();
  const db = store();
  vi.mocked(db.pruneSamples).mockImplementation(() => {
    throw busyError;
  });
  startUsageSampler(db, MIN_USAGE_INTERVAL_MS);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(MIN_USAGE_INTERVAL_MS);
  expect(db.pruneSamples).toHaveBeenCalledTimes(2);
  stopUsageSampler();
  await vi.advanceTimersByTimeAsync(MIN_USAGE_INTERVAL_MS);
  expect(db.pruneSamples).toHaveBeenCalledTimes(2);
});

test("records Kid Control counters even without queues, once per IPv4 client", async () => {
  read.mockImplementation(async (command?: string) =>
    command?.includes("kid-control")
      ? `0 D name="PS5"
    ip-address=fe80::1,
      10.10.10.191 rate-down=0bps rate-up=0bps bytes-down=1MiB bytes-up=64KiB`
      : "",
  );
  const db = store();
  await sampleUsageOnce(db);
  expect(db.recordClientSamples).toHaveBeenCalledWith("edge", expect.any(Number), [
    { ip: "10.10.10.191", rx: 1048576, tx: 65536, source: "kid-control" },
  ]);
  expect(read.mock.calls.every(([command]) => command.includes("print"))).toBe(true);
});

test("prefers Kid Control and only falls back to exact-host queues without double counting", async () => {
  read.mockImplementation(async (command?: string) => {
    if (command?.includes("kid-control")) return `0 ip-address=10.0.0.1 bytes-down=100 bytes-up=20`;
    if (command?.includes("queue simple"))
      return `0 target=10.0.0.1/32 bytes=999/999
1 target=10.0.0.2/32 bytes=10/50
2 target=10.0.0.0/24 bytes=500/800
3 target=10.0.0.3/32,10.0.0.4/32 bytes=600/900
4 target=bridge bytes=700/1000`;
    return "";
  });
  const db = store();
  await sampleUsageOnce(db);
  expect(db.recordClientSamples).toHaveBeenCalledWith("edge", expect.any(Number), [
    { ip: "10.0.0.1", rx: 100, tx: 20, source: "kid-control" },
    { ip: "10.0.0.2", rx: 50, tx: 10, source: "queue" },
  ]);
});

test("unsupported Kid Control retains legacy queue sampling", async () => {
  read.mockImplementation(async (command?: string) =>
    command?.includes("kid-control")
      ? "bad command name kid-control"
      : command?.includes("queue simple")
        ? "0 target=10.0.0.2/32 bytes=10/50"
        : "",
  );
  const db = store();
  await sampleUsageOnce(db);
  expect(db.recordClientSamples).toHaveBeenCalledWith("edge", expect.any(Number), [
    { ip: "10.0.0.2", rx: 50, tx: 10, source: "queue" },
  ]);
});
