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

test("an unknown menu is returned as text, although RouterOS exits non-zero", async () => {
  const s = session();
  const result = s.client.run("/caps-man manager print");
  s.channel.stderr.emit("data", Buffer.from("bad command name caps-man (line 1 column 2)"));
  s.channel.emit("close", 1);
  expect(await result).toBe("bad command name caps-man (line 1 column 2)");
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

test("concurrent commands share one connection-loss listener set", async () => {
  const s = session(false);
  const errors: string[] = [];
  process.on("warning", (w) => errors.push(w.name));
  const runs = Array.from({ length: 20 }, (_, i) =>
    s.client.run(`/log print ${i}`).catch((e) => e),
  );
  expect(s.connection.listenerCount("close")).toBe(1);
  expect(s.connection.listenerCount("error")).toBe(1);
  expect(s.connection.listenerCount("end")).toBe(1);
  s.connection.emit("close");
  const results = await Promise.all(runs);
  expect(results.every((r) => r instanceof Error && /outcome.*unknown/i.test(r.message))).toBe(
    true,
  );
  expect(s.connection.listenerCount("close")).toBe(0);
  await new Promise((r) => setImmediate(r));
  expect(errors).not.toContain("MaxListenersExceededWarning");
});

/** A fake connection whose SFTP channel answers only when the test says so. */
function fileSession() {
  const sftp = {
    end: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
  };
  const connection = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    sftp: vi.fn((callback: (error: Error | undefined, channel: typeof sftp) => void) =>
      callback(undefined, sftp),
    ),
  });
  const client = new MikroTikSSHClient({ host: "router", username: "test" });
  Object.assign(client, { client: connection });
  return { client, connection, sftp };
}

test("a file transfer that stalls is stopped, and says the file must be read back", async () => {
  vi.useFakeTimers();
  const s = fileSession();
  // writeFile never calls back: before the limit this promise waited for ever.
  const result = s.client.uploadFile("a.txt", Buffer.from("x")).catch((e) => e);
  await vi.advanceTimersByTimeAsync(45_000);
  const error = await result;
  expect(error.message).toMatch(/did not finish in 45 s/);
  expect(error.message).toMatch(/read it back before you send it again/);
  expect(s.sftp.end).toHaveBeenCalledOnce();
  expect(s.connection.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("a file transfer ends when the connection closes or fails under it", async () => {
  const closed = fileSession();
  const upload = closed.client.uploadFile("a.txt", Buffer.from("x")).catch((e) => e);
  closed.connection.emit("close");
  expect((await upload).message).toMatch(/SFTP write stopped: the SSH connection closed/);

  const failed = fileSession();
  const download = failed.client.downloadFile("a.txt").catch((e) => e);
  failed.connection.emit("error", new Error("read ECONNRESET"));
  expect((await download).message).toBe("SFTP read stopped: read ECONNRESET.");
});

test("a finished transfer gives its result once and leaves nothing behind", async () => {
  vi.useFakeTimers();
  const s = fileSession();
  s.sftp.readFile.mockImplementation((_path: string, done: (e: null, d: Buffer) => void) =>
    done(null, Buffer.from("data")),
  );
  expect((await s.client.downloadFile("a.txt")).toString()).toBe("data");
  s.sftp.writeFile.mockImplementation((_p: string, _d: Buffer, done: (e: Error) => void) =>
    done(new Error("No such file or directory")),
  );
  await expect(s.client.uploadFile("dir/a.txt", Buffer.from("x"))).rejects.toThrow(
    "SFTP write failed: No such file or directory",
  );
  expect(s.connection.listenerCount("close")).toBe(0);
  expect(s.connection.listenerCount("error")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
