import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  readTrafficSample,
  subscribeTraffic,
  trafficSubscriberCount,
} from "../../src/observability/traffic-hub";
import type { BulkTrafficPayload } from "../../src/tools/connected-devices";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../src/tools/connected-devices", () => ({ sampleAllTraffic: read }));
const original = getConfig();
const sample: BulkTrafficPayload = { ts: 1000, source: "kid-control", hosts: {}, limits: {} };
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  setConfig(
    MikrotikConfigSchema.parse({ devices: { edge: { host: "192.0.2.1" } }, defaultDevice: "edge" }),
  );
  read.mockReset().mockResolvedValue(sample);
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  setConfig(original);
});

test("slow reads do not overlap, HTTP and stream viewers share one device sample", async () => {
  let finish!: (value: BulkTrafficPayload) => void;
  read.mockReturnValueOnce(
    new Promise<BulkTrafficPayload>((resolve) => {
      finish = resolve;
    }),
  );
  const receive = vi.fn();
  stops.push(subscribeTraffic("", receive));
  const http = readTrafficSample("edge");
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
  finish(sample);
  await expect(http).resolves.toEqual(sample);
  await vi.advanceTimersByTimeAsync(0);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(trafficSubscriberCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(2);
});

test("reconnect while the last read is unfinished does not create a competing poller", async () => {
  let finish!: (value: BulkTrafficPayload) => void;
  read.mockReturnValueOnce(
    new Promise<BulkTrafficPayload>((resolve) => {
      finish = resolve;
    }),
  );
  const stop = subscribeTraffic("edge", vi.fn());
  stop();
  const receive = vi.fn();
  stops.push(subscribeTraffic("edge", receive));
  finish(sample);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(receive).toHaveBeenCalledWith(sample);
  stops.pop()!();
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
});

test("read failures replace old rates and a standalone HTTP reader unsubscribes", async () => {
  read.mockRejectedValueOnce(new Error("SSH unavailable"));
  const request = readTrafficSample("edge");
  await expect(request).resolves.toMatchObject({
    source: "none",
    hosts: {},
    note: "SSH unavailable",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(trafficSubscriberCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
});
