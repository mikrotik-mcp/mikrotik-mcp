import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DeviceConfigSchema, MikrotikConfigSchema } from "../src/config";
import {
  deviceEndpoints,
  endpointOptions,
  ENDPOINT_SUCCESS_TTL_MS,
} from "../src/core/device-endpoints";
import { createDeviceClient, createRestClient, sshOptionsOf } from "../src/core/transport";
import { MikroTikSSHClient } from "../src/ssh/client";
import { SafeModeManager } from "../src/ssh/safe-mode";
import { getConfig, setConfig } from "../src/core/runtime";
import { closeAll, poolStatus, runPooled } from "../src/core/connection-pool";
import { shouldFallbackToSsh } from "../src/rest/client";
import { executeMikrotikCommand } from "../src/core/connector";
import { createContext } from "../src/core/context";

const mock = vi.hoisted(() => ({
  attempts: [] as string[],
  commands: [] as string[],
  failures: new Map<string, string>(),
  clients: [] as any[],
  commandError: "",
  connectError: "",
  forwards: [] as string[],
}));
vi.mock("ssh2", () => ({
  Client: class extends EventEmitter {
    host = "";
    closed = false;
    channel?: EventEmitter;
    connect(cfg: { host: string }) {
      this.host = cfg.host;
      mock.clients.push(this);
      mock.attempts.push(cfg.host);
      if (mock.connectError) throw new Error(mock.connectError);
      queueMicrotask(() =>
        mock.failures.has(cfg.host)
          ? this.emit("error", new Error(mock.failures.get(cfg.host)))
          : this.emit("ready"),
      );
    }
    destroy() {
      if (!this.closed) {
        this.closed = true;
        this.channel?.emit("close");
        this.emit("close");
      }
    }
    end() {
      this.destroy();
    }
    forwardOut(_src: string, _port: number, host: string, _targetPort: number, cb: Function) {
      mock.forwards.push(host);
      cb(undefined, new PassThrough());
    }
    exec(command: string, cb: Function) {
      mock.commands.push(command);
      if (mock.commandError) return cb(new Error(mock.commandError));
      const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close() {},
        signal() {},
      });
      cb(undefined, stream);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from("name: demo"));
        stream.emit("close");
      });
    }
    shell(_opts: unknown, cb: Function) {
      const channel = Object.assign(new EventEmitter(), {
        write(input: string) {
          channel.emit(
            "data",
            Buffer.from(
              input === "\x18"
                ? "[Safe Mode taken]\n[admin@demo] <SAFE> "
                : `${input}\nname: demo\n[admin@demo] <SAFE> `,
            ),
          );
        },
        end() {
          channel.emit("close");
        },
      });
      this.channel = channel;
      cb(undefined, channel);
      setTimeout(() => channel.emit("data", Buffer.from("[admin@demo] > ")), 0);
    }
  },
}));

const original = getConfig();
const device = () =>
  DeviceConfigSchema.parse({
    host: "10.0.0.1",
    fallbackHosts: ["203.0.113.1", "2001:db8::1"],
    password: "secret",
  });
beforeEach(() => {
  mock.attempts = [];
  mock.commands = [];
  mock.clients = [];
  mock.failures.clear();
  mock.forwards = [];
  mock.commandError = "";
  mock.connectError = "";
});
afterEach(() => {
  closeAll();
  for (const c of mock.clients) c.destroy();
  setConfig(original);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("legacy configs work; alternates are bounded, unique static IPs and unavailable for MAC", () => {
  expect(DeviceConfigSchema.parse({ host: "router.example" }).fallbackHosts).toBeUndefined();
  expect(device().fallbackHosts).toHaveLength(2);
  for (const config of [
    { host: "10.0.0.1", fallbackHosts: ["10.0.0.1"] },
    { host: "2001:db8::1", fallbackHosts: ["2001:db8:0:0:0:0:0:1"] },
    { fallbackHosts: ["https://example.com"] },
    { fallbackHosts: ["bad-ip"] },
    { fallbackHosts: Array.from({ length: 8 }, (_, i) => `10.0.0.${i + 1}`) },
    { mac: "00:11:22:33:44:55", fallbackHosts: ["10.0.0.1"] },
  ])
    expect(DeviceConfigSchema.safeParse(config).success).toBe(false);
});

test("SSH selects the authenticated fallback, closes failed sockets, and separates live from historical state", async () => {
  const dc = device();
  mock.failures.set(dc.host, "connect ETIMEDOUT");
  const client = createDeviceClient(dc);
  expect(await client.connect()).toBe(true);
  expect(mock.attempts).toEqual(["10.0.0.1", "203.0.113.1"]);
  expect(mock.clients[0].closed).toBe(true);
  expect(client.connectedHost).toBe("203.0.113.1");
  expect(deviceEndpoints(dc)?.connected).toEqual([
    { host: "203.0.113.1", port: 22, transport: "ssh" },
  ]);
  expect(deviceEndpoints(dc)?.observations).toHaveLength(2); // IPv6 not tested
  client.disconnect();
  expect(deviceEndpoints(dc)?.connected).toEqual([]);
  expect(deviceEndpoints(dc)?.observations.at(-1)?.error).toBeUndefined();
});

test("a failed primary has a short cooldown but is preferred again on a later new session", async () => {
  const dc = device(),
    options = endpointOptions(dc, "ssh", 22);
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  options.onAttempt!(dc.host, "timeout");
  expect(options.hosts!()[0]).toBe("203.0.113.1");
  clock.mockReturnValue(32000);
  expect(options.hosts!()[0]).toBe(dc.host);
  expect(deviceEndpoints(DeviceConfigSchema.parse(dc))?.observations).toEqual([]);
});

test("authenticated fallback is remembered beyond failure cooldown, renewed on connect, and expires without closing sessions", async () => {
  const dc = device();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  mock.failures.set(dc.host, "ETIMEDOUT");
  const first = createDeviceClient(dc);
  expect(await first.connect()).toBe(true);
  first.disconnect();
  mock.attempts = [];
  mock.failures.clear(); // Primary has recovered, but must not cost another dial yet.
  clock.mockReturnValue(61_000);
  const next = createDeviceClient(dc);
  expect(await next.connect()).toBe(true);
  expect(mock.attempts).toEqual(["203.0.113.1"]);
  expect(deviceEndpoints(dc)?.remembered).toEqual([
    {
      host: "203.0.113.1",
      transport: "ssh",
      port: 22,
      expiresAt: 61_000 + ENDPOINT_SUCCESS_TTL_MS,
    },
  ]);
  clock.mockReturnValue(61_000 + ENDPOINT_SUCCESS_TTL_MS);
  expect(endpointOptions(dc, "ssh", 22).hosts!()[0]).toBe(dc.host);
  expect(deviceEndpoints(dc)?.remembered).toEqual([]);
  expect(deviceEndpoints(dc)?.connected[0]?.host).toBe("203.0.113.1");
  expect(await next.run("/system identity print")).toContain("demo");
  expect(mock.attempts).toEqual(["203.0.113.1"]); // Expiry does not redial a live session.
});

test("failed remembered address is invalidated and a new successful address becomes preferred", async () => {
  const dc = device();
  const options = endpointOptions(dc, "ssh", 22);
  options.onConnected!("203.0.113.1")();
  options.onAttempt!("203.0.113.1", "ECONNREFUSED");
  expect(deviceEndpoints(dc)?.remembered).toEqual([]);
  expect(options.hosts!()[0]).toBe(dc.host);
  options.onConnected!("203.0.113.1")();
  mock.failures.set("203.0.113.1", "ECONNREFUSED");
  const next = createDeviceClient(dc);
  expect(await next.connect()).toBe(true);
  expect(mock.attempts).toEqual(["203.0.113.1", dc.host]);
  expect(deviceEndpoints(dc)?.remembered?.[0].host).toBe(dc.host);
});

test("successful preference is isolated by config identity, transport and port", () => {
  const dc = device();
  endpointOptions(dc, "ssh", 22).onConnected!("203.0.113.1")();
  expect(endpointOptions(dc, "ssh", 22).hosts!()[0]).toBe("203.0.113.1");
  expect(endpointOptions(dc, "ssh", 2222).hosts!()[0]).toBe(dc.host);
  expect(endpointOptions(dc, "rest", 22).hosts!()[0]).toBe(dc.host);
  expect(endpointOptions(DeviceConfigSchema.parse(dc), "ssh", 22).hosts!()[0]).toBe(dc.host);
  endpointOptions(dc, "rest", 443).onConnected!("2001:db8::1")();
  expect(endpointOptions(dc, "rest", 443).hosts!()[0]).toBe("2001:db8::1");
  expect(endpointOptions(dc, "ssh", 22).hosts!()[0]).toBe("203.0.113.1");
});

test("authentication failure stops attempts and all-network failure reports each attempted IP", async () => {
  const dc = device();
  mock.failures.set(dc.host, "All configured authentication methods failed");
  const client = createDeviceClient(dc);
  expect(await client.connect()).toBe(false);
  expect(mock.attempts).toEqual([dc.host]);
  const next = device();
  for (const host of [next.host, ...next.fallbackHosts!]) mock.failures.set(host, "ECONNREFUSED");
  const offline = createDeviceClient(next);
  expect(await offline.connect()).toBe(false);
  expect(offline.lastError).toContain("[2001:db8::1]:22");
  expect(deviceEndpoints(next)?.connected).toEqual([]);
});

test("configured jump hosts and their targets each resolve their own addresses", async () => {
  const bastion = DeviceConfigSchema.parse({ host: "10.0.1.1", fallbackHosts: ["203.0.113.9"] });
  const target = DeviceConfigSchema.parse({ ...device(), jumpVia: "bastion" });
  mock.failures.set(bastion.host, "ECONNREFUSED");
  mock.failures.set(target.host, "ECONNREFUSED");
  const client = createDeviceClient(target, { bastion, target });
  expect(await client.connect()).toBe(true);
  expect(mock.attempts).toEqual([bastion.host, "203.0.113.9", target.host, "203.0.113.1"]);
  expect(mock.forwards).toEqual([target.host, "203.0.113.1"]);
  client.disconnect();
  expect(deviceEndpoints(bastion)?.connected).toEqual([]);
});

test("invalid private keys stop failover even when teardown emits close synchronously", async () => {
  mock.connectError = "Cannot parse privateKey: unsupported key format";
  const dc = device();
  const client = createDeviceClient(dc);
  expect(await client.connect()).toBe(false);
  expect(mock.attempts).toEqual([dc.host]);
  expect(client.lastError).toContain("privateKey");
});

test("removing a device during connection closes the obsolete session before any command", async () => {
  setConfig(MikrotikConfigSchema.parse({ devices: { edge: device() }, defaultDevice: "edge" }));
  const pending = runPooled("/system identity print", "edge");
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { other: { host: "192.0.2.1" } },
      defaultDevice: "other",
    }),
  );
  await expect(pending).rejects.toThrow();
  expect(mock.commands).toEqual([]);
  expect(mock.clients.every((c) => c.closed)).toBe(true);
  expect(poolStatus()).toEqual([]);
});

test("a remotely closed session is dead, never idle", async () => {
  setConfig(MikrotikConfigSchema.parse({ devices: { edge: device() }, defaultDevice: "edge" }));
  await runPooled("/system identity print", "edge");
  mock.clients.at(-1).destroy();
  expect(poolStatus()).toEqual([{ device: "edge", inflight: 0, idle: false, dead: true }]);
});

test("pool stays on a healthy fallback; an ambiguous mutation is never replayed and edits invalidate the connection", async () => {
  const cfg = MikrotikConfigSchema.parse({ devices: { edge: device() }, defaultDevice: "edge" });
  setConfig(cfg);
  mock.failures.set("10.0.0.1", "ETIMEDOUT");
  await Promise.all([
    runPooled("/system identity print", "edge"),
    runPooled("/system identity print", "edge"),
  ]);
  expect(mock.attempts).toHaveLength(2);
  mock.failures.clear();
  await runPooled("/system resource print", "edge");
  expect(mock.attempts).toHaveLength(2);
  mock.commandError = "ECONNRESET";
  await expect(runPooled("/ip address add address=10.2.0.1/24", "edge")).rejects.toThrow(
    "ECONNRESET",
  );
  expect(mock.commands.filter((c) => c.includes(" add "))).toHaveLength(1);
  expect(mock.attempts).toHaveLength(2);
  mock.commandError = "";
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "203.0.113.100" } },
      defaultDevice: "edge",
    }),
  );
  await runPooled("/system identity print", "edge");
  expect(mock.attempts.at(-1)).toBe("203.0.113.100");
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "203.0.113.101" } },
      defaultDevice: "edge",
    }),
  );
  await runPooled("/system identity print", "edge");
  expect(mock.attempts.at(-1)).toBe("203.0.113.101");
});

test("Safe Mode connects through a fallback, stays pinned, and never reconnects on a dropped shell", async () => {
  setConfig(MikrotikConfigSchema.parse({ devices: { edge: device() }, defaultDevice: "edge" }));
  mock.failures.set("10.0.0.1", "ETIMEDOUT");
  const safe = new SafeModeManager("edge");
  expect(await safe.enable()).toContain("ENABLED");
  mock.failures.clear();
  expect(await safe.execute("/system identity print")).toContain("name: demo");
  expect(mock.attempts).toHaveLength(2);
  mock.clients.at(-1).destroy();
  expect(safe.isActive).toBe(false);
  expect(mock.attempts).toHaveLength(2);
});

test("REST probes fail over, bracket IPv6, and a dispatched request is not retried over SSH", async () => {
  const dc = device();
  const fetcher = vi.fn(async (url: string) => {
    if (!url.includes("[2001:db8::1]")) throw new Error("connect ECONNREFUSED");
    return Response.json({ version: "7" });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = createRestClient(dc);
  expect(await client.connect()).toBe(true);
  expect(client.connectedHost).toBe("2001:db8::1");
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(deviceEndpoints(dc)?.connected[0].transport).toBe("rest");
  client.disconnect();
  expect(deviceEndpoints(dc)?.connected).toEqual([]);
  expect(shouldFallbackToSsh(new Error("ECONNRESET"), true)).toBe(false);
});

test("direct SSH options keep per-device endpoint observations isolated", async () => {
  const a = device(),
    b = device();
  const client = new MikroTikSSHClient(sshOptionsOf(a));
  await client.connect();
  expect(deviceEndpoints(b)?.observations).toEqual([]);
  client.disconnect();
});

test("a REST mutation with lost response is never replayed over SSH", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { ...device(), api: true } },
      defaultDevice: "edge",
    }),
  );
  const fetcher = vi.fn(async (_url: string, opts: RequestInit) => {
    if (opts.method === "GET") return Response.json({ version: "7" });
    throw new Error("ECONNRESET after request was sent");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    executeMikrotikCommand("/ip address add address=10.2.0.1/24 interface=bridge", createContext()),
  ).rejects.toThrow("ECONNRESET");
  expect(mock.attempts).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
