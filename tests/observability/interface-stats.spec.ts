import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  interfaceRates,
  interfaceStatsResponse,
  parseInterfaceStats,
  subscribeInterfaces,
} from "../../src/observability/interface-stats";
import type { InterfaceSample } from "../../src/observability/interface-stats";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";

const read = vi.hoisted(() => vi.fn(async (_command: string, _ctx: unknown) => ""));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: read }));
const original = getConfig();
const stops: (() => void)[] = [];
const detail = `Flags: D - dynamic; X - disabled, R - running
0 R name="ether 123 456" type="ether" actual-mtu=1500 mac-address=AA:BB:CC:DD:EE:01 comment="uplink 123 456"
1 X name="wg-home" type="wg" mtu=1420
2 D name="vlan-guest" type="vlan" running=yes`;
const stats = `Flags: R - RUNNING
0 R name="ether 123 456" rx-byte=205 164 277 tx-byte=147 977 500
    rx-packet=158 254 tx-packet=150 156 tx-queue-drop=2 rx-error=0 link-downs=3
1 X name="wg-home" rx-byte=0 tx-byte=0`;
const sample = (ts: number): InterfaceSample => ({
  device: "edge",
  ts,
  interfaces: parseInterfaceStats(detail, stats),
});
const config = () =>
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        edge: { host: "127.0.0.1", username: "admin" },
        other: { host: "127.0.0.2", username: "admin" },
      },
      defaultDevice: "edge",
    }),
  );

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  read.mockReset();
  setConfig(original);
});

test("merges stats by name, preserves grouped digits, states, metadata and unavailable counters", () => {
  const rows = parseInterfaceStats(detail, stats);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    name: "ether 123 456",
    comment: "uplink 123 456",
    rxBytes: 205164277,
    txBytes: 147977500,
    rxPackets: 158254,
    running: true,
    mtu: 1500,
    rxErrors: 0,
    txErrors: null,
    queueDrops: 2,
  });
  expect(rows[1]).toMatchObject({ disabled: true, rxBytes: 0, rxRate: null });
  expect(rows[2]).toMatchObject({ dynamic: true, running: true, rxBytes: null });
});

test("rates use elapsed time and never bridge resets, failures, new interfaces or devices", () => {
  const before = sample(1000);
  const next = sample(3000);
  next.interfaces[0].rxBytes! += 1000;
  next.interfaces[0].rxPackets! += 20;
  expect(interfaceRates(next, before).interfaces[0]).toMatchObject({
    rxRate: 4000,
    txRate: 0,
    rxPps: 10,
  });
  expect(interfaceRates(next).interfaces[0].rxRate).toBeNull();
  expect(interfaceRates(next, { ...before, device: "other" }).interfaces[0].rxRate).toBeNull();
  expect(interfaceRates(next, { ...before, error: "offline" }).interfaces[0].rxRate).toBeNull();
  expect(interfaceRates({ ...next, ts: 60_000 }, before).interfaces[0].rxRate).toBeNull();
  next.interfaces[0].rxBytes = 1;
  expect(interfaceRates(next, before).interfaces[0].rxRate).toBeNull();
  expect(interfaceRates(next, before).interfaces[2].rxRate).toBeNull();
});

test("shares one serial sampler per device and stops polling when the last viewer leaves", async () => {
  config();
  vi.useFakeTimers();
  read.mockImplementation(async (command) => (command.includes("stats-detail") ? stats : detail));
  const a = vi.fn();
  const b = vi.fn();
  const stopA = subscribeInterfaces("edge", a);
  stops.push(stopA);
  await vi.advanceTimersByTimeAsync(0);
  const stopB = subscribeInterfaces("edge", b);
  stops.push(stopB);
  expect(read).toHaveBeenCalledTimes(2);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(read).toHaveBeenCalledTimes(4);
  expect(b.mock.lastCall?.[0].interfaces[0].rxRate).toBe(0);
  stopA();
  stopB();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(4);
  expect(read.mock.calls.map(([command]) => command)).toEqual([
    "/interface print detail without-paging",
    "/interface print stats-detail without-paging",
    "/interface print detail without-paging",
    "/interface print stats-detail without-paging",
  ]);
});

test("slow reads do not overlap and a detached result never leaks to a new subscriber", async () => {
  config();
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = vi.fn();
  const fresh = vi.fn();
  const stop = subscribeInterfaces("edge", old);
  stops.push(stop);
  await vi.advanceTimersByTimeAsync(6000);
  expect(read).toHaveBeenCalledTimes(1);
  stop();
  read.mockImplementation(async (command) => (command.includes("stats-detail") ? stats : detail));
  stops.push(subscribeInterfaces("edge", fresh));
  await vi.advanceTimersByTimeAsync(0);
  finish(detail);
  await vi.advanceTimersByTimeAsync(0);
  expect(old).not.toHaveBeenCalled();
  expect(fresh).toHaveBeenCalledTimes(1);
});

test("errors are explicit and recovery starts a fresh rate baseline", async () => {
  config();
  vi.useFakeTimers();
  read.mockResolvedValueOnce("failure: no permission");
  const listener = vi.fn();
  stops.push(subscribeInterfaces("edge", listener));
  await vi.advanceTimersByTimeAsync(0);
  expect(listener.mock.lastCall?.[0]).toMatchObject({ interfaces: [], error: expect.any(String) });
  read.mockImplementation(async (command) => (command.includes("stats-detail") ? stats : detail));
  await vi.advanceTimersByTimeAsync(2000);
  expect(listener.mock.lastCall?.[0].interfaces[0].rxRate).toBeNull();
});

test("unknown targets fail closed before router I/O; SSE cancel releases its subscriber", async () => {
  config();
  vi.useFakeTimers();
  expect(() =>
    interfaceStatsResponse(new Request("http://localhost/api/interfaces/stream"), "unknown"),
  ).toThrow();
  expect(read).not.toHaveBeenCalled();
  read.mockImplementation(async (command) => (command.includes("stats-detail") ? stats : detail));
  const response = interfaceStatsResponse(
    new Request("http://localhost/api/interfaces/stream"),
    "edge",
  );
  const reader = response.body!.getReader();
  await vi.advanceTimersByTimeAsync(0);
  const event = new TextDecoder().decode((await reader.read()).value);
  expect(event).toContain("event: interfaces");
  expect(event).toContain('"device":"edge"');
  await reader.cancel();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(2);
});
