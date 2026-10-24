import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikroTikSSHClient } from "../../src/ssh/client";

const state = vi.hoisted(() => ({
  made: [] as Array<
    EventEmitter & { end: ReturnType<typeof vi.fn>; forwardOut: ReturnType<typeof vi.fn> }
  >,
  stallForward: false,
}));
vi.mock("ssh2", () => ({
  Client: class FakeSSH extends EventEmitter {
    config?: { host: string; sock?: unknown };
    connect = vi.fn((config: { host: string; sock?: unknown }) => {
      this.config = config;
      if (config.host === "down.invalid") this.emit("error", new Error("connection refused"));
      else if (config.host === "auth.invalid")
        this.emit("error", new Error("authentication failed"));
      else this.emit("ready");
      return this;
    });
    end = vi.fn(() => {
      this.emit("close");
      return this;
    });
    destroy = vi.fn(() => this);
    forwardOut = vi.fn(
      (
        _a: string,
        _b: number,
        _host: string,
        _port: number,
        cb: (err?: Error, stream?: EventEmitter) => void,
      ) => {
        if (!state.stallForward) cb(undefined, new EventEmitter());
      },
    );
    constructor() {
      super();
      state.made.push(this);
    }
  },
}));
beforeEach(() => {
  state.made.length = 0;
  state.stallForward = false;
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

test("tries another address only during connection setup and reconnects after close", async () => {
  const attempts = vi.fn();
  const client = new MikroTikSSHClient({
    host: "down.invalid",
    username: "test",
    hosts: () => ["down.invalid", "up.invalid"],
    onAttempt: attempts,
  });
  expect(await client.connect()).toBe(true);
  expect(client.connectedHost).toBe("up.invalid");
  expect(attempts).toHaveBeenNthCalledWith(1, "down.invalid", "connection refused");
  expect(attempts).toHaveBeenNthCalledWith(2, "up.invalid");
  expect(await client.connect()).toBe(true);
  expect(state.made).toHaveLength(2);
  state.made[1]!.emit("close");
  expect(client.isConnected).toBe(false);
  expect(await client.connect()).toBe(true);
  expect(state.made).toHaveLength(4);
  client.disconnect();
});

test("authentication failure does not try a second address", async () => {
  const client = new MikroTikSSHClient({
    host: "auth.invalid",
    username: "test",
    hosts: () => ["auth.invalid", "up.invalid"],
  });
  expect(await client.connect()).toBe(false);
  expect(client.lastError).toMatch(/authentication failed/);
  expect(state.made).toHaveLength(1);
});

test("jump tunnel timeout fails clearly and retires the bastion", async () => {
  vi.useFakeTimers();
  state.stallForward = true;
  const client = new MikroTikSSHClient({
    host: "target.invalid",
    username: "test",
    timeoutMs: 100,
    jump: { host: "jump.invalid", username: "test" },
  });
  const result = client.connect();
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(false);
  expect(client.lastError).toMatch(/did not open a tunnel/);
  expect(state.made[0]!.end).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
