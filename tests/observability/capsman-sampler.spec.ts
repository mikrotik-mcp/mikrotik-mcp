import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { emptyCapsmanState } from "../../src/core/capsman";
import { getConfig, setConfig } from "../../src/core/runtime";
import { logger } from "../../src/logger";
import {
  CAPSMAN_RETENTION_MS,
  MIN_CAPSMAN_INTERVAL_MS,
  sampleCapsmanOnce,
  startCapsmanSampler,
  stopCapsmanSampler,
} from "../../src/observability/capsman-sampler";
import type { CapsmanStore } from "../../src/observability/capsman-store";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/wifi-query", () => ({ fetchCapsmanState: read }));
const original = getConfig();
const busyError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 });
function store() {
  return {
    recordRadioSamples: vi.fn(),
    radioSeries: vi.fn(() => []),
    pruneSamples: vi.fn(() => 0),
    close: vi.fn(),
  } satisfies CapsmanStore;
}

beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({ defaultDevice: "edge", devices: { edge: { host: "192.0.2.1" } } }),
  );
  read.mockReset().mockResolvedValue({
    ...emptyCapsmanState(),
    radios: [{ radioId: "wifi1", cap: "ap-1", band: "5ghz", clientCount: 2 }],
  });
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  stopCapsmanSampler();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setConfig(original);
});

test("retention contention never rejects the pass, and the next pass recovers", async () => {
  vi.useFakeTimers();
  const db = store();
  db.pruneSamples.mockImplementationOnce(() => {
    throw busyError;
  });
  await expect(sampleCapsmanOnce(db)).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("retention cleanup"));
  expect(db.pruneSamples).toHaveBeenCalledWith(Date.now() - CAPSMAN_RETENTION_MS);
  await sampleCapsmanOnce(db);
  expect(db.recordRadioSamples).toHaveBeenCalledTimes(2);
  expect(db.pruneSamples).toHaveBeenCalledTimes(2);
});

test("non-lock storage failures remain visible without killing the sampler", async () => {
  const db = store();
  db.pruneSamples.mockImplementation(() => {
    throw new Error("disk I/O error");
  });
  await expect(sampleCapsmanOnce(db)).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disk I/O error"));
});

test("one device's write failure does not prevent other samples or retention", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      defaultDevice: "edge",
      devices: { edge: { host: "192.0.2.1" }, other: { host: "192.0.2.2" } },
    }),
  );
  const db = store();
  db.recordRadioSamples.mockImplementationOnce(() => {
    throw busyError;
  });
  await expect(sampleCapsmanOnce(db)).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining("capsman sample failed for 'edge'"),
  );
  expect(db.recordRadioSamples).toHaveBeenCalledWith("other", expect.any(Number), [
    expect.objectContaining({ radioId: "wifi1", clients: 2 }),
  ]);
  expect(db.pruneSamples).toHaveBeenCalledTimes(1);
});

test("immediate and periodic timer passes survive retention failures", async () => {
  vi.useFakeTimers();
  const db = store();
  db.pruneSamples.mockImplementation(() => {
    throw busyError;
  });
  startCapsmanSampler(db, MIN_CAPSMAN_INTERVAL_MS);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(MIN_CAPSMAN_INTERVAL_MS);
  expect(db.pruneSamples).toHaveBeenCalledTimes(2);
  stopCapsmanSampler();
  await vi.advanceTimersByTimeAsync(MIN_CAPSMAN_INTERVAL_MS);
  expect(db.pruneSamples).toHaveBeenCalledTimes(2);
});
