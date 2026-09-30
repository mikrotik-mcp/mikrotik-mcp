/**
 * Offline tests for SSH jump-host (ProxyJump) resolution: config parsing,
 * single-device flag plumbing, and the cycle / MAC-Telnet guards in
 * createDeviceClient. The actual tunnelling needs a live bastion, so it isn't
 * exercised here — these pin the wiring and the guard rails.
 */
import { describe, expect, test } from "vite-plus/test";
import { MikrotikConfigSchema, loadConfig } from "../src/config";
import { createDeviceClient, resolveJump } from "../src/core/transport";
import { mergeConfigDraft } from "../src/config-write";
import { redact } from "../src/observability/event";
import { getDevice, setConfig } from "../src/core/runtime";

describe("jump-host config parsing", () => {
  test("jumpVia and inline jumpHost survive schema validation", () => {
    const cfg = MikrotikConfigSchema.parse({
      defaultDevice: "edge",
      devices: {
        hex: { host: "192.168.88.1", username: "admin", password: "x" },
        edge: { host: "10.10.30.100", username: "admin", password: "y", jumpVia: "hex" },
        inline: {
          host: "10.0.0.5",
          jumpHost: { host: "203.0.113.9", username: "ops", port: 2222 },
        },
      },
    });
    expect(cfg.devices.edge!.jumpVia).toBe("hex");
    expect(cfg.devices.inline!.jumpHost?.host).toBe("203.0.113.9");
    expect(cfg.devices.inline!.jumpHost?.port).toBe(2222);
    expect(cfg.devices.inline!.jumpHost?.username).toBe("ops");
  });

  test("single-device flags build an inline jump host on the default device", () => {
    const cfg = loadConfig([
      "--host",
      "10.10.30.100",
      "--jump-host",
      "192.168.88.1",
      "--jump-username",
      "admin",
      "--jump-port",
      "22",
    ]);
    expect(cfg.devices.default!.jumpHost?.host).toBe("192.168.88.1");
    expect(cfg.devices.default!.jumpHost?.port).toBe(22);
  });
});

describe("jump-host resolution guards (createDeviceClient)", () => {
  const withDevices = (devices: Record<string, unknown>, def = Object.keys(devices)[0]): void =>
    setConfig(MikrotikConfigSchema.parse({ defaultDevice: def, devices }));

  test("a valid jumpVia builds a client without error", () => {
    withDevices({
      hex: { host: "192.168.88.1", username: "admin", password: "x" },
      edge: { host: "10.10.30.100", username: "admin", password: "y", jumpVia: "hex" },
    });
    expect(() => createDeviceClient(getDevice("edge"))).not.toThrow();
  });

  test("a multi-hop chain (edge → b → hex) resolves", () => {
    withDevices({
      hex: { host: "192.168.88.1", username: "admin", password: "x" },
      b: { host: "10.0.0.2", username: "admin", password: "x", jumpVia: "hex" },
      edge: { host: "10.10.30.100", username: "admin", password: "y", jumpVia: "b" },
    });
    expect(() => createDeviceClient(getDevice("edge"))).not.toThrow();
  });

  test("a jump cycle is rejected", () => {
    withDevices({
      a: { host: "10.0.0.1", username: "admin", password: "x", jumpVia: "b" },
      b: { host: "10.0.0.2", username: "admin", password: "x", jumpVia: "a" },
    });
    expect(() => createDeviceClient(getDevice("a"))).toThrow(/cycle/i);
  });

  test("a self-jump is rejected", () => {
    withDevices({
      s: { host: "10.0.0.1", username: "admin", password: "x", jumpVia: "s" },
    });
    expect(() => createDeviceClient(getDevice("s"))).toThrow(/cycle/i);
  });

  test("a MAC-Telnet device cannot be used as a bastion", () => {
    withDevices({
      l2: { mac: "48:A9:8A:C6:42:F7", username: "admin", password: "x" },
      edge: { host: "10.10.30.100", username: "admin", password: "y", jumpVia: "l2" },
    });
    expect(() => createDeviceClient(getDevice("edge"))).toThrow(/MAC-Telnet/i);
  });
});

test("draft jump chains use edited endpoints and server-side secrets, never stale runtime fallbacks", () => {
  const live = MikrotikConfigSchema.parse({
    devices: {
      bastion: { host: "old.example", password: "stored-secret" },
      edge: { host: "edge", jumpVia: "bastion" },
    },
    defaultDevice: "edge",
  });
  setConfig(live);
  const draft = redact(live) as any;
  draft.devices.bastion.host = "new.example";
  draft.devices.bastion.port = 2222;
  draft.devices.edge.jumpVia = "new-hop";
  draft.devices["new-hop"] = { host: "new-hop", jumpVia: "bastion" };
  const parsed = MikrotikConfigSchema.parse(mergeConfigDraft(draft, live));
  const jump = resolveJump(parsed.devices.edge!, new Set(), parsed.devices);
  expect(jump?.host).toBe("new-hop");
  expect(jump?.jump).toMatchObject({ host: "new.example", port: 2222, password: "stored-secret" });
  expect(getDevice("bastion").host).toBe("old.example");
  expect(() => resolveJump(live.devices.edge!, new Set(), {})).toThrow(/not in this device draft/);
  expect(() =>
    resolveJump(parsed.devices.edge!, new Set(), {
      ...parsed.devices,
      bastion: { ...parsed.devices.bastion!, jumpVia: "edge" },
    }),
  ).toThrow(/cycle/);
});
