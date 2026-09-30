import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { MikroTikSSHClient } from "../../src/ssh/client";

afterEach(() => vi.useRealTimers());

function session(open = true) {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    close: vi.fn(() => channel.emit("close", 0)),
    signal: vi.fn(),
  });
  let reply!: (error?: Error, stream?: typeof channel) => void;
  const connection = Object.assign(new EventEmitter(), {
    end: vi.fn(() => connection.emit("close")),
    exec: vi.fn((_command, callback) => {
      reply = callback;
      if (open) callback(undefined, channel);
    }),
  });
  const client = new MikroTikSSHClient({ host: "router", username: "test", timeoutMs: 1500 });
  Object.assign(client, { client: connection });
  return { client, connection, channel, reply: () => reply(undefined, channel) };
}

test("bounds a stalled exec-channel request and discards a late callback without replay", async () => {
  vi.useFakeTimers();
  const s = session(false);
  let outcome: unknown;
  const result = s.client.run("/ip route set *1 check-gateway=ping").catch((e) => (outcome = e));
  await vi.advanceTimersByTimeAsync(1500);
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toMatch(/SSH channel.*timed out/);
  expect(String(outcome)).toMatch(/do not retry/i);
  s.reply();
  await result;
  expect(s.channel.close).toHaveBeenCalledOnce();
  expect(s.connection.exec).toHaveBeenCalledOnce();
  expect(s.connection.end).toHaveBeenCalledOnce();
  expect(s.client.isConnected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([false, true])(
  "transport loss rejects even while waiting for a channel (open=%s)",
  async (open) => {
    vi.useFakeTimers();
    const s = session(open);
    const result = s.client.run("/ip route set *1 distance=2").catch((e) => e);
    s.connection.emit("close");
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/outcome.*unknown/i);
    expect(s.connection.exec).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("channel errors reject rather than leaving a call pending", async () => {
  const s = session();
  const result = s.client.run("/ip route print").catch((e) => e);
  s.channel.emit("error", new Error("channel broken"));
  expect((await result).message).toContain("channel broken");
  expect(s.connection.listenerCount("close")).toBe(0);
});

test("nonzero exit cannot be masked by partial stdout", async () => {
  const s = session();
  const result = s.client.run("/ip route set *1 distance=2").catch((e) => e);
  s.channel.emit("data", Buffer.from("partial output"));
  s.channel.stderr.emit("data", Buffer.from("failure: rejected"));
  s.channel.emit("close", 1);
  expect(await result).toBeInstanceOf(Error);
  expect((await result).message).toMatch(/exit code 1.*failure: rejected/s);
});

test("normal close without optional exit status remains supported", async () => {
  const s = session();
  const result = s.client.run("/system identity print");
  s.channel.emit("data", Buffer.from("name: home"));
  s.channel.emit("close");
  expect(await result).toBe("name: home");
  expect(s.connection.listenerCount("close")).toBe(0);
});

test("caller-capped streaming completes once and does not leave watchdogs behind", async () => {
  vi.useFakeTimers();
  const s = session();
  const result = s.client.run("/ping 192.0.2.1", { maxMs: 100 });
  s.channel.emit("data", Buffer.from("1 reply"));
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe("1 reply");
  s.channel.emit("data", Buffer.from("late"));
  expect(vi.getTimerCount()).toBe(0);
});

test.each([false, true])(
  "idle/hard timeout cannot be turned into success by synchronous close (streaming=%s)",
  async (streaming) => {
    vi.useFakeTimers();
    const s = session();
    s.channel.signal.mockImplementation(() => s.channel.emit("close", 0));
    const result = s.client.run("/ip route print").catch((e) => e);
    if (streaming) {
      for (let n = 0; n < 3; n++) {
        await vi.advanceTimersByTimeAsync(30_000);
        s.channel.emit("data", Buffer.from("partial"));
      }
      await vi.advanceTimersByTimeAsync(30_000);
    } else await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(Error);
    expect((await result).message).toMatch(streaming ? /hard timeout/ : /no output/);
    expect(vi.getTimerCount()).toBe(0);
  },
);
