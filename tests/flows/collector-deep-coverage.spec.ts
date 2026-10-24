import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { getFlowCollector } from "../../src/flows/collector";
import type { FlowStore } from "../../src/flows/store";

const sockets = vi.hoisted(() => ({
  latest: null as null | {
    callbacks: Record<string, (...args: any[]) => void>;
    bind: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("node:dgram", () => ({
  createSocket: () => {
    const callbacks: Record<string, (...args: any[]) => void> = {};
    const socket = {
      callbacks,
      on: (name: string, cb: (...args: any[]) => void) => {
        callbacks[name] = cb;
      },
      bind: vi.fn((_port: number, cb: () => void) => cb()),
      close: vi.fn(),
    };
    sockets.latest = socket;
    return socket;
  },
}));

function v5Packet(): Uint8Array {
  const bytes = new Uint8Array(72);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 5);
  view.setUint16(2, 1);
  view.setUint32(4, 3_600_000);
  view.setUint32(8, 1_700_000_000);
  bytes.set([10, 0, 0, 1], 24);
  bytes.set([8, 8, 8, 8], 28);
  view.setUint32(40, 3);
  view.setUint32(44, 384);
  view.setUint16(56, 1234);
  view.setUint16(58, 53);
  bytes[62] = 17;
  return bytes;
}

const collector = getFlowCollector();
let insert: ReturnType<typeof vi.fn>;
let prune: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  insert = vi.fn();
  prune = vi.fn(() => ({ rawDeleted: 2, rollupDeleted: 1 }));
});

afterEach(() => {
  collector.stop();
  vi.useRealTimers();
});

async function start() {
  const store = { insert, prune } as unknown as FlowStore;
  expect(await collector.start(store, 2056)).toEqual({ ok: true, port: 2056 });
  return sockets.latest!;
}

function send(packet: Uint8Array, address = "192.0.2.10") {
  sockets.latest!.callbacks.message(packet, { address });
}

test("decodes actual NetFlow, tracks exporters, and drains records with source address", async () => {
  const socket = await start();
  expect(await collector.start({ insert, prune } as unknown as FlowStore, 9999)).toEqual({
    ok: true,
    port: 2056,
  });
  send(v5Packet());
  send(v5Packet(), "192.0.2.11");
  expect(collector.stats()).toMatchObject({
    running: true,
    packets: 2,
    flows: 2,
    queued: 2,
    exporters: { "192.0.2.10": 1, "192.0.2.11": 1 },
  });
  expect(insert).not.toHaveBeenCalled();
  collector.drain();
  expect(insert).toHaveBeenCalledOnce();
  expect(insert.mock.calls[0][0]).toMatchObject([
    { src: "10.0.0.1", dst: "8.8.8.8", bytes: 384, exporter: "192.0.2.10" },
    { exporter: "192.0.2.11" },
  ]);
  expect(collector.stats().queued).toBe(0);
  collector.stop();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(collector.stats().running).toBe(false);
});

test("bad datagrams count as decode errors without reaching storage", async () => {
  await start();
  send(new Uint8Array([0, 99]));
  expect(collector.stats()).toMatchObject({ packets: 1, flows: 0, decodeErrors: 1, queued: 0 });
  expect(collector.stats().lastError).toContain("192.0.2.10:");
  collector.drain();
  expect(insert).not.toHaveBeenCalled();
});

test("batch threshold flushes automatically and failed writes count dropped records", async () => {
  insert.mockImplementation(() => {
    throw new Error("disk full");
  });
  await start();
  for (let i = 0; i < 500; i++) send(v5Packet());
  expect(insert).toHaveBeenCalledOnce();
  expect(insert.mock.calls[0][0]).toHaveLength(500);
  expect(collector.stats()).toMatchObject({
    packets: 500,
    flows: 500,
    queued: 0,
    storageDropped: 500,
  });
  insert.mockImplementation(() => undefined);
  send(v5Packet());
  collector.stop();
  expect(insert).toHaveBeenCalledTimes(2);
  expect(collector.stats().storageDropped).toBe(500);
});

test("periodic flush and prune survive store failures; restart resets counters", async () => {
  const socket = await start();
  send(v5Packet());
  await vi.advanceTimersByTimeAsync(2_000);
  expect(insert).toHaveBeenCalledOnce();
  prune.mockImplementationOnce(() => {
    throw new Error("busy");
  });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(prune).toHaveBeenCalledOnce();
  socket.callbacks.error(new Error("socket died"));
  expect(socket.close).toHaveBeenCalledOnce();
  expect(collector.stats().running).toBe(false);
  await start();
  expect(collector.stats()).toMatchObject({
    packets: 0,
    flows: 0,
    queued: 0,
    storageDropped: 0,
    exporters: {},
  });
});
