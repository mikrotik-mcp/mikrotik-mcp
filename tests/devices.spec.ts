/**
 * Multi-device configuration + resolution tests (offline).
 */
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { loadConfig, MikrotikConfigSchema } from "../src/config";
import {
  deviceLabels,
  getDevice,
  listDevices,
  resolveDeviceName,
  setConfig,
  tryResolveDeviceName,
} from "../src/core/runtime";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("MIKROTIK")) delete process.env[k];
  Object.assign(process.env, SAVED);
});
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("MIKROTIK")) delete process.env[k];
});

describe("single-device config (legacy MIKROTIK_*)", () => {
  test("MIKROTIK_HOST defines the 'default' device", () => {
    process.env.MIKROTIK_HOST = "192.168.88.1";
    process.env.MIKROTIK_PASSWORD = "secret";
    const cfg = loadConfig([]);
    expect(Object.keys(cfg.devices)).toEqual(["default"]);
    expect(cfg.defaultDevice).toBe("default");
    expect(cfg.devices.default.host).toBe("192.168.88.1");
  });

  test("no config at all still yields a usable default device", () => {
    const cfg = loadConfig([]);
    expect(cfg.devices.default.host).toBe("127.0.0.1");
    expect(cfg.devices.default.username).toBe("admin");
  });

  test("flags win over env", () => {
    process.env.MIKROTIK_HOST = "10.0.0.9";
    const cfg = loadConfig(["--host", "172.16.0.1", "--port", "2222"]);
    expect(cfg.devices.default.host).toBe("172.16.0.1");
    expect(cfg.devices.default.port).toBe(2222);
  });
});

describe("multi-device config (MIKROTIK_DEVICES)", () => {
  const DEVICES = JSON.stringify({
    defaultDevice: "site-a",
    devices: {
      "site-a": { host: "10.0.0.1", username: "admin", keyFilename: "/keys/a" },
      "site-b": { host: "10.0.0.2", username: "admin", password: "x" },
    },
  });

  test("parses named devices and the default", () => {
    process.env.MIKROTIK_DEVICES = DEVICES;
    const cfg = loadConfig([]);
    expect(Object.keys(cfg.devices).sort()).toEqual(["site-a", "site-b"]);
    expect(cfg.defaultDevice).toBe("site-a");
    expect(cfg.devices["site-b"].password).toBe("x");
  });

  test("a bare { name: {...} } map defaults to the first key", () => {
    process.env.MIKROTIK_DEVICES = JSON.stringify({
      hq: { host: "10.0.0.1" },
      branch: { host: "10.0.0.2" },
    });
    const cfg = loadConfig([]);
    expect(cfg.defaultDevice).toBe("hq");
  });

  test("single env + multi source coexist (default + named)", () => {
    process.env.MIKROTIK_HOST = "192.168.88.1";
    process.env.MIKROTIK_DEVICES = JSON.stringify({
      devices: { remote: { host: "203.0.113.1" } },
    });
    const cfg = loadConfig([]);
    expect(Object.keys(cfg.devices).sort()).toEqual(["default", "remote"]);
    // MIKROTIK_HOST was present first, so default stays "default".
    expect(cfg.defaultDevice).toBe("default");
  });
});

describe("device resolution", () => {
  beforeEach(() => {
    process.env.MIKROTIK_DEVICES = JSON.stringify({
      defaultDevice: "site-a",
      devices: {
        "site-a": { host: "10.0.0.1" },
        "site-b": { host: "10.0.0.2" },
      },
    });
    setConfig(loadConfig([]));
  });

  test("listDevices reports names + default", () => {
    const d = listDevices();
    expect(d.names.sort()).toEqual(["site-a", "site-b"]);
    expect(d.default).toBe("site-a");
  });

  test("resolveDeviceName defaults only for an OMITTED name", () => {
    expect(resolveDeviceName(undefined)).toBe("site-a");
    expect(resolveDeviceName("site-b")).toBe("site-b");
  });

  // Fail-closed: the whole point. A name the config does not know must never
  // degrade into "run it on the default router" — that silently retargets a
  // write at the wrong physical device.
  test("resolveDeviceName THROWS on an unknown name instead of defaulting", () => {
    expect(() => resolveDeviceName("nope")).toThrow(/Unknown device 'nope'/);
    expect(() => resolveDeviceName("nope")).toThrow(/NOT run against the default device/);
  });

  test("tryResolveDeviceName reports unknown as undefined without throwing", () => {
    expect(tryResolveDeviceName("site-b")).toBe("site-b");
    expect(tryResolveDeviceName("nope")).toBeUndefined();
    expect(tryResolveDeviceName(undefined)).toBeUndefined();
  });

  test("getDevice returns the right host and throws on unknown names", () => {
    expect(getDevice("site-b").host).toBe("10.0.0.2");
    expect(getDevice(undefined).host).toBe("10.0.0.1");
    expect(() => getDevice("ghost")).toThrow(/Unknown device 'ghost'/);
  });
});

describe("targeting a device by its friendly label (description)", () => {
  beforeEach(() => {
    // Key "home" carries the label "Ali Home" — the name the AI naturally uses.
    setConfig(
      MikrotikConfigSchema.parse({
        devices: {
          mobin: { host: "10.0.0.1" },
          home: { host: "10.0.0.2", description: "Ali Home" },
        },
        defaultDevice: "mobin",
      }),
    );
  });

  test("deviceLabels exposes distinct labels that aren't already keys", () => {
    expect(deviceLabels()).toEqual(["Ali Home"]);
  });

  test("resolveDeviceName maps a label (any case) to its key", () => {
    expect(resolveDeviceName("Ali Home")).toBe("home");
    expect(resolveDeviceName("ali home")).toBe("home"); // case-insensitive
    expect(resolveDeviceName("home")).toBe("home"); // key still works
    expect(resolveDeviceName("mobin")).toBe("mobin");
  });

  test("getDevice resolves a label to its connection config", () => {
    expect(getDevice("Ali Home").host).toBe("10.0.0.2");
    // A name that's neither a key nor a label still throws.
    expect(() => getDevice("Nonexistent")).toThrow(/Unknown device/);
  });
});
