/**
 * REST API device fields: `api`, `apiPort`, `apiInsecureTls`.
 *
 * `z.boolean()` does not coerce strings, so the two booleans are parsed in
 * `loadConfig` rather than by the schema — which makes their tri-state
 * behaviour (absent leaves a config-file value alone) worth pinning down.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { loadConfig } from "../../src/config";

const dirs: string[] = [];
function configFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mikrotik-api-"));
  dirs.push(dir);
  const p = join(dir, "devices.json");
  writeFileSync(p, JSON.stringify(body));
  return p;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("REST fields from flags", () => {
  test("a bare --api enables REST on the default device", () => {
    const cfg = loadConfig(["--host", "10.0.0.1", "--api"]);
    expect(cfg.devices.default.api).toBe(true);
  });

  test("an explicitly falsy value disables it", () => {
    for (const v of ["false", "0", "no", "off"]) {
      expect(loadConfig(["--host", "10.0.0.1", "--api", v]).devices.default.api).toBe(false);
    }
  });

  test("port and insecure-tls come through, port coerced to a number", () => {
    const cfg = loadConfig([
      "--host",
      "10.0.0.1",
      "--api",
      "--api-port",
      "8443",
      "--api-insecure-tls",
    ]);
    expect(cfg.devices.default.apiPort).toBe(8443);
    expect(cfg.devices.default.apiInsecureTls).toBe(true);
  });

  test("absent means unset, not false — so a config-file value can win", () => {
    const cfg = loadConfig(["--host", "10.0.0.1"]);
    expect(cfg.devices.default.api).toBeUndefined();
    expect(cfg.devices.default.apiPort).toBeUndefined();
    expect(cfg.devices.default.apiInsecureTls).toBeUndefined();
  });

  test("apiInsecureTls defaults to unset — never silently trusting a cert", () => {
    const cfg = loadConfig(["--host", "10.0.0.1", "--api"]);
    expect(cfg.devices.default.apiInsecureTls).toBeUndefined();
  });
});

describe("REST fields from a multi-device config file", () => {
  test("per-device api settings are read", () => {
    const path = configFile({
      defaultDevice: "edge",
      devices: {
        edge: {
          host: "203.0.113.10",
          username: "admin",
          api: true,
          apiPort: 8443,
          apiInsecureTls: true,
        },
        legacy: { host: "198.51.100.5", username: "admin" },
      },
    });
    const cfg = loadConfig(["--config", path]);
    expect(cfg.devices.edge.api).toBe(true);
    expect(cfg.devices.edge.apiPort).toBe(8443);
    expect(cfg.devices.edge.apiInsecureTls).toBe(true);
    // The other device is untouched — REST is per-device, not global.
    expect(cfg.devices.legacy.api).toBeUndefined();
  });

  test("a device may be MAC-Telnet and carry api without conflict", () => {
    // isRestDevice() resolves the precedence (MAC wins); the schema simply
    // accepts both so a device can be flipped between them by editing one field.
    const path = configFile({
      devices: { lab: { mac: "48:A9:8A:C6:42:F7", username: "admin", api: true } },
    });
    const cfg = loadConfig(["--config", path]);
    expect(cfg.devices.lab.mac).toBe("48:A9:8A:C6:42:F7");
    expect(cfg.devices.lab.api).toBe(true);
  });
});
