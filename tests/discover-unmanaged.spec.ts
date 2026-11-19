/** discover_unmanaged_devices: neighbours of every router, minus the configured ones. */
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createSocket } from "node:dgram";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";

const command = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());
const applyConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../src/core/mndp-listen", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listenMndp: listen,
}));
vi.mock("../src/observability/health", () => ({ probeDevice: probe }));
vi.mock("../src/observability/config-admin", () => ({ getConfigAdmin: () => ({ applyConfig }) }));
const { neighborTools, parseIpScan } = await import("../src/tools/neighbor");
const { listenMndp, parseMndp } =
  await vi.importActual<typeof import("../src/core/mndp-listen")>("../src/core/mndp-listen");

const tool = neighborTools.find((t) => t.name === "discover_unmanaged_devices")!;
const run = (args: Record<string, unknown> = {}): Promise<string> =>
  (tool.handler as (a: unknown, c: unknown) => Promise<string>)(
    z.object(tool.inputSchema).parse(args),
    { info() {}, error() {} },
  );

const original = getConfig();
beforeEach(() => {
  command.mockReset();
  listen.mockReset();
  probe.mockReset();
  applyConfig.mockReset();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        edge: { host: "10.0.0.1" },
        core: { host: "10.0.0.2" },
        spare: { host: "10.0.0.9", disabled: true },
      },
      defaultDevice: "edge",
    }),
  );
});
afterEach(() => setConfig(original));

const row = (i: number, fields: Record<string, string>): string =>
  ` ${i}   ${Object.entries(fields)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}`;

test("it lists what the routers see and leaves out configured devices", async () => {
  command.mockImplementation(async (_cmd: string, ctx: { device: string }) =>
    ctx.device === "edge"
      ? [
          row(0, {
            interface: "ether2",
            address: "10.0.0.2",
            "mac-address": "AA:AA:AA:00:00:02",
            identity: "core",
          }),
          row(1, {
            interface: "ether3",
            address: "10.0.0.50",
            "mac-address": "AA:AA:AA:00:00:50",
            identity: "new-ap",
            board: "cAP ax",
            version: "7.25.1",
            platform: "MikroTik",
          }),
        ].join("\n")
      : row(0, {
          interface: "ether5",
          address: "10.0.0.50",
          "mac-address": "AA:AA:AA:00:00:50",
          identity: "new-ap",
        }),
  );
  const text = await run();
  expect(tool.annotations.readOnlyHint).toBe(true);
  // The disabled router is not asked.
  expect(command.mock.calls.map((c) => (c[1] as { device: string }).device)).toEqual([
    "edge",
    "core",
  ]);
  expect(command.mock.calls.every((c) => c[0] === "/ip neighbor print detail")).toBe(true);
  expect(text).toContain("Asked 2 of 2 router(s). 1 device(s) are attached and not managed.");
  expect(text).toContain("new-ap");
  expect(text).toContain("board: cAP ax · version: 7.25.1");
  expect(text).toContain("seen by: edge on ether3, core on ether5");
  expect(text).toContain('"host":"10.0.0.50"');
  expect(text).toContain("This tool adds nothing.");
  // "core" is configured: it is not offered as a new device.
  expect(text).not.toMatch(/^core$/m);
});

test("a router that cannot be asked is reported, and the rest still answer", async () => {
  command.mockImplementation(async (_cmd: string, ctx: { device: string }) => {
    if (ctx.device === "edge") throw new Error("connection refused");
    return "";
  });
  const text = await run({ devices: ["edge", "core"] });
  expect(text).toContain("Asked 1 of 2 router(s). 0 device(s) are attached and not managed.");
  expect(text).toContain("edge: connection refused");
  await expect(run({ devices: ["nope"] })).rejects.toThrow();
});

/** One MNDP record: type, length, value. */
const record = (type: number, value: Buffer): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value]);
};
const packet = Buffer.concat([
  Buffer.alloc(4),
  record(1, Buffer.from([0xaa, 0xbb, 0xcc, 0, 0, 0x77])),
  record(5, Buffer.from("new-ap\u0007")),
  record(7, Buffer.from("7.25.1 (stable)")),
  record(12, Buffer.from("cAP ax")),
  record(17, Buffer.from([10, 0, 0, 77])),
]);

test("an MNDP packet is read, and a packet that lies about its length ends the parse", () => {
  expect(parseMndp(packet)).toEqual({
    mac: "AA:BB:CC:00:00:77",
    identity: "new-ap",
    version: "7.25.1 (stable)",
    board: "cAP ax",
    ip: "10.0.0.77",
  });
  const lying = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 5, 0xff, 0xff]), Buffer.from("x")]);
  expect(parseMndp(lying)).toBeNull();
  expect(parseMndp(Buffer.alloc(3))).toBeNull();
});

test("the host listener collects what arrives on its port", async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const heard = listenMndp(400, port);
  const sender = createSocket("udp4");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise<void>((resolve) => sender.send(packet, port, "127.0.0.1", () => resolve()));
  sender.close();
  expect(await heard).toEqual([
    expect.objectContaining({ mac: "AA:BB:CC:00:00:77", identity: "new-ap" }),
  ]);
});

test("an ip-scan table is read by address and MAC", () => {
  expect(
    parseIpScan(
      "Columns: ADDRESS, MAC-ADDRESS, TIME, DNS\n10.0.0.1  AA:AA:AA:00:00:01  1ms  gw.lan\n10.0.0.60  aa:aa:aa:00:00:60  12ms\n10.0.0.61\n",
    ),
  ).toEqual([
    { ip: "10.0.0.1", mac: "AA:AA:AA:00:00:01", identity: "gw.lan" },
    { ip: "10.0.0.60", mac: "AA:AA:AA:00:00:60", identity: undefined },
    { ip: "10.0.0.61", mac: undefined, identity: undefined },
  ]);
});

test("what the host hears and what a scan finds are added, without known devices", async () => {
  command.mockImplementation(async (cmd: string) =>
    String(cmd).startsWith("/tool ip-scan")
      ? "10.0.0.1  AA:AA:AA:00:00:01  1ms\n10.0.0.60  AA:AA:AA:00:00:60  2ms printer"
      : "",
  );
  listen.mockResolvedValue([
    { mac: "AA:BB:CC:00:00:77", identity: "new-ap", board: "cAP ax", ip: "10.0.0.77" },
    { mac: "AA:AA:AA:00:00:01", identity: "edge", ip: "10.0.0.1" },
  ]);
  const text = await run({
    listen_seconds: 3,
    scan: { device: "edge", address_range: "10.0.0.0/24" },
  });
  expect(listen).toHaveBeenCalledWith(3000);
  expect(command.mock.calls.map((c) => String(c[0]))).toContain(
    "/tool ip-scan address-range=10.0.0.0/24 duration=8s",
  );
  expect(text).toContain("2 device(s) are attached and not managed.");
  expect(text).toContain("new-ap\n  board: cAP ax");
  expect(text).toContain("seen by: MCP host");
  expect(text).toContain("seen by: scan on edge");
  // 10.0.0.1 is the configured router: neither source offers it.
  expect(text).not.toContain("10.0.0.1 ");
  expect(text).not.toMatch(/IP: 10\.0\.0\.1$/m);
});

const enrol = neighborTools.find((t) => t.name === "enrol_device")!;
const runEnrol = async (args: Record<string, unknown>): Promise<string> => {
  const result = await (enrol.handler as (a: unknown, c: unknown) => Promise<unknown>)(
    z.object(enrol.inputSchema).parse(args),
    { info() {}, error() {} },
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};

test("enrol takes a secret reference, never a password, and adds only what it can reach", async () => {
  const schema = z.object(enrol.inputSchema);
  expect(Object.keys(enrol.inputSchema ?? {})).not.toContain("password");
  expect(
    schema.safeParse({ name: "ap", host: "10.0.0.77", password_from: "hunter2" }).success,
  ).toBe(false);
  expect(await runEnrol({ name: "ap", host: "10.0.0.77" })).toContain(
    "A literal password is not accepted",
  );
  expect(await runEnrol({ name: "edge", host: "10.0.0.77", ssh_agent: true })).toContain(
    "already exists",
  );
  expect(await runEnrol({ name: "ap", ssh_agent: true })).toContain("Give a host");
  expect(probe).not.toHaveBeenCalled();

  probe.mockResolvedValue({ reachable: false, error: "authentication failed" });
  const refused = await runEnrol({
    name: "ap",
    host: "10.0.0.77",
    password_from: "env:AP_PW",
    apply: true,
  });
  expect(refused).toContain("Not added: the connection failed. authentication failed");
  expect(applyConfig).not.toHaveBeenCalled();

  probe.mockResolvedValue({
    reachable: true,
    identity: "new-ap",
    version: "7.25.1",
    boardName: "cAP ax",
  });
  expect(await runEnrol({ name: "ap", host: "10.0.0.77", password_from: "env:AP_PW" })).toContain(
    "The connection works (new-ap, cAP ax, RouterOS 7.25.1). Nothing was added.",
  );
  expect(applyConfig).not.toHaveBeenCalled();

  const added = await runEnrol({
    name: "ap",
    host: "10.0.0.77",
    password_from: "env:AP_PW",
    apply: true,
  });
  expect(added).toContain("Added 'ap'");
  const saved = applyConfig.mock.calls[0]![0] as {
    devices: Record<string, Record<string, unknown>>;
  };
  expect(saved.devices.ap).toMatchObject({
    host: "10.0.0.77",
    passwordFrom: "env:AP_PW",
    password: "",
  });
  expect(Object.keys(saved.devices)).toEqual(["edge", "core", "spare", "ap"]);
});
