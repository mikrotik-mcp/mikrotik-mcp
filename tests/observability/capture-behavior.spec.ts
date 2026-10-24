import { beforeEach, expect, test, vi } from "vite-plus/test";
import { capture } from "../../src/observability/capture";

const sockets = vi.hoisted(() => ({
  latest: null as null | {
    callbacks: Record<string, (...args: unknown[]) => void>;
    close: ReturnType<typeof vi.fn>;
  },
}));
vi.mock("node:dgram", () => ({
  createSocket: () => {
    const callbacks: Record<string, (...args: unknown[]) => void> = {};
    const socket = {
      callbacks,
      on: (name: string, cb: (...args: unknown[]) => void) => {
        callbacks[name] = cb;
      },
      bind: (_port: number, cb: () => void) => cb(),
      close: vi.fn(),
    };
    sockets.latest = socket;
    return socket;
  },
}));

function frame() {
  const packet = new Uint8Array(14 + 20 + 8);
  packet[12] = 8;
  packet[14] = 0x45;
  packet[23] = 17;
  packet.set([10, 0, 0, 1], 26);
  packet.set([10, 0, 0, 2], 30);
  packet[35] = 53;
  return new Uint8Array([1, 0, 0, 1, 1, ...packet]);
}

beforeEach(() => {
  capture.stop();
  sockets.latest = null;
});

test("capture starts once, ingests Ethernet datagrams, and exports retained pcap", async () => {
  expect(await capture.start(37100)).toEqual({ ok: true, port: 37100 });
  const socket = sockets.latest!;
  expect(await capture.start(37101)).toEqual({ ok: true, port: 37100 });
  const received = vi.fn();
  const unsubscribe = capture.subscribe(received);
  socket.callbacks.message(Buffer.from(frame()));
  socket.callbacks.message(Buffer.from([1, 4, 0, 1, 1]));
  expect(capture.stats()).toMatchObject({
    running: true,
    port: 37100,
    packets: 1,
    pcapFrames: 1,
    protocols: { UDP: 1 },
  });
  expect(capture.stats().topTalkers[0]).toMatchObject({ addr: "10.0.0.1", count: 1 });
  expect(capture.recent()).toHaveLength(1);
  expect(received).toHaveBeenCalledOnce();
  expect(capture.pcap().length).toBeGreaterThan(24);
  unsubscribe();
  socket.callbacks.message(Buffer.from(frame()));
  expect(received).toHaveBeenCalledOnce();
  capture.stop();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(capture.stats().running).toBe(false);
});

test("bad subscriber cannot prevent accounting or delivery to another subscriber", async () => {
  await capture.start(37102);
  const good = vi.fn();
  const bad = () => {
    throw new Error("viewer closed");
  };
  const removeBad = capture.subscribe(bad);
  const removeGood = capture.subscribe(good);
  sockets.latest!.callbacks.message(Buffer.from(frame()));
  expect(capture.stats().packets).toBe(1);
  expect(good).toHaveBeenCalledOnce();
  removeBad();
  removeGood();
  capture.stop();
});
