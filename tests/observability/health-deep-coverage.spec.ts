import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { capture } from "../../src/observability/capture";

const sockets = vi.hoisted(() => ({
  latest: null as null | {
    callbacks: Record<string, (...args: any[]) => void>;
    bind: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  },
  failBind: false,
}));

vi.mock("node:dgram", () => ({
  createSocket: () => {
    const callbacks: Record<string, (...args: any[]) => void> = {};
    const socket = {
      callbacks,
      on: (name: string, cb: (...args: any[]) => void) => {
        callbacks[name] = cb;
      },
      bind: vi.fn((_port: number, cb: () => void) => {
        if (sockets.failBind) callbacks.error(new Error("port occupied"));
        else cb();
      }),
      close: vi.fn(),
    };
    sockets.latest = socket;
    return socket;
  },
}));

function packet(source: number): Uint8Array {
  const ethernet = new Uint8Array(14 + 20 + 8);
  ethernet[12] = 8;
  ethernet[14] = 0x45;
  ethernet[23] = 17;
  ethernet.set([10, 0, 0, source], 26);
  ethernet.set([8, 8, 8, 8], 30);
  ethernet[35] = 53;
  return new Uint8Array([1, 0, 0, 1, 1, ...ethernet]);
}

function send(bytes: Uint8Array) {
  sockets.latest!.callbacks.message(bytes);
}

beforeEach(() => {
  sockets.failBind = false;
  capture.stop();
});
afterEach(() => capture.stop());

test("bind failure reports an error and a later start opens a fresh session", async () => {
  sockets.failBind = true;
  expect(await capture.start(37110)).toEqual({ ok: false, error: "port occupied", port: 37110 });
  expect(capture.stats().running).toBe(false);
  sockets.failBind = false;
  expect(await capture.start(37111)).toEqual({ ok: true, port: 37111 });
  expect(capture.stats()).toMatchObject({ running: true, port: 37111, packets: 0 });
});

test("invalid, keepalive, and unsupported encapsulation do not enter capture", async () => {
  await capture.start(37112);
  send(new Uint8Array([0]));
  send(new Uint8Array([1, 4, 0, 1, 1]));
  send(new Uint8Array([1, 0, 0, 2, 1, ...packet(1).slice(5)]));
  expect(capture.stats()).toMatchObject({ packets: 0, bytes: 0, pcapFrames: 0 });
  expect(capture.recent()).toEqual([]);
  expect(capture.pcap()).toHaveLength(24);
});

test("recent summaries are newest first while pcap preserves original frame bytes", async () => {
  await capture.start(37113);
  const first = packet(1);
  send(first);
  first[31] = 99;
  send(packet(2));
  expect(capture.stats()).toMatchObject({
    packets: 2,
    bytes: 84,
    pcapFrames: 2,
    protocols: { UDP: 2 },
  });
  expect(capture.recent(1)).toMatchObject([{ src: "10.0.0.2" }]);
  expect(capture.recent(0)).toHaveLength(1);
  expect(capture.stats().topTalkers).toEqual([
    { addr: "10.0.0.1", count: 1 },
    { addr: "10.0.0.2", count: 1 },
  ]);
  const exported = capture.pcap();
  expect(exported).toHaveLength(24 + 2 * (16 + 42));
  expect(exported.slice(24 + 16, 24 + 16 + 42)).toEqual(packet(1).slice(5));
  sockets.latest!.callbacks.error(new Error("receiver died"));
  expect(capture.stats().running).toBe(false);
  expect(sockets.latest!.close).toHaveBeenCalledOnce();
  await capture.start(37114);
  expect(capture.stats()).toMatchObject({ packets: 0, bytes: 0, pcapFrames: 0, protocols: {} });
});
