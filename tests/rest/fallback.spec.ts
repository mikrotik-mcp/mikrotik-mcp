/**
 * REST → SSH fallback rules.
 *
 * The one decision that makes an opt-in second transport safe: which failures
 * mean "REST could not do this, try SSH" and which mean "the device rejected
 * this, stop". Getting it wrong in the permissive direction re-runs a malformed
 * command over SSH and produces a second, differently worded failure — leaving
 * the operator debugging the wrong transport.
 */
import { describe, expect, test } from "vite-plus/test";
import { RestHttpError, RestUnmappableError, shouldFallbackToSsh } from "../../src/rest/client";
import { toRequest } from "../../src/rest/bridge";
import { isRestDevice } from "../../src/core/transport";
import type { DeviceConfig } from "../../src/config";
import { MikrotikConfigSchema } from "../../src/config";
import { executeMikrotikCommand } from "../../src/core/connector";
import { createContext } from "../../src/core/context";
import { setConfig } from "../../src/core/runtime";
import { getSafeModeManager } from "../../src/ssh/safe-mode";

const dev = (over: Partial<DeviceConfig> = {}): DeviceConfig =>
  ({
    host: "127.0.0.1",
    port: 22,
    username: "admin",
    ...over,
  }) as DeviceConfig;

describe("isRestDevice", () => {
  test("opt-in only", () => {
    expect(isRestDevice(dev())).toBe(false);
    expect(isRestDevice(dev({ api: true }))).toBe(true);
    expect(isRestDevice(dev({ api: false }))).toBe(false);
  });

  test("MAC-Telnet wins over REST", () => {
    // A device addressed by MAC has no routable IP for HTTPS to reach, so the
    // two together can only mean MAC-Telnet.
    expect(isRestDevice(dev({ api: true, mac: "48:A9:8A:C6:42:F7" }))).toBe(false);
  });
});

describe("shouldFallbackToSsh", () => {
  test("an unmappable command falls back", () => {
    expect(shouldFallbackToSsh(new RestUnmappableError("/export"))).toBe(true);
  });

  test("404 falls back — the menu is absent on this RouterOS version", () => {
    expect(shouldFallbackToSsh(new RestHttpError(404, "not found", "/ip/x/print"))).toBe(true);
  });

  test("400 does NOT fall back — the device rejected the parameters", () => {
    expect(shouldFallbackToSsh(new RestHttpError(400, "bad parameter", "/ip/address/add"))).toBe(
      false,
    );
  });

  test("401 does NOT fall back — retrying over SSH would mask an auth failure", () => {
    expect(shouldFallbackToSsh(new RestHttpError(401, "unauthorized", "/ip/address/print"))).toBe(
      false,
    );
  });

  test("403 and 5xx do not fall back either — all are the device answering", () => {
    expect(shouldFallbackToSsh(new RestHttpError(403, "forbidden", "x"))).toBe(false);
    expect(shouldFallbackToSsh(new RestHttpError(500, "internal", "x"))).toBe(false);
  });

  test("a transport-level failure falls back", () => {
    // DNS, TCP refused, TLS rejected: REST never reached the device at all.
    expect(shouldFallbackToSsh(new Error("fetch failed: ECONNREFUSED"))).toBe(true);
    expect(shouldFallbackToSsh(new TypeError("self signed certificate"))).toBe(true);
  });
});

describe("commands that must never attempt REST", () => {
  // These reach `tryRest`, which checks `toRequest` before opening a connection
  // — a null mapping means SSH runs and REST costs nothing.
  test.each([
    ["/export"],
    ["/system backup save name=x"],
    ["/tool ping 8.8.8.8"],
    ["/ip firewall filter remove [find chain=input]"],
    ["/ip address print; /ip route print"],
    ["/system script run name=$var"],
  ])("%s has no REST mapping", (cmd) => {
    expect(toRequest(cmd)).toBeNull();
  });

  test("Safe Mode commands are console-only, so they can never map", () => {
    // Safe Mode is additionally routed away from runOnce entirely by
    // executeMikrotikCommand — see the structural test below.
    expect(toRequest("/system safe-mode")).toBeNull();
    expect(toRequest("[Y]")).toBeNull();
  });
});

describe("Safe Mode is never served over REST", () => {
  test("an active Safe Mode session bypasses the REST branch entirely", async () => {
    // A REST-enabled device pointed at a closed port: if the REST branch were
    // reached it would attempt a connection and then fall through to SSH, which
    // throws ECONNREFUSED. Getting the sentinel back proves the Safe Mode
    // short-circuit in executeMikrotikCommand ran first.
    setConfig(
      MikrotikConfigSchema.parse({
        devices: {
          default: { host: "127.0.0.1", port: 1, api: true, apiPort: 1, timeoutMs: 500 },
        },
        defaultDevice: "default",
      }),
    );

    const mgr = getSafeModeManager("default");
    Object.defineProperty(mgr, "isActive", { get: () => true, configurable: true });
    const execute = mgr.execute.bind(mgr);
    mgr.execute = async () => "SAFE-MODE-SENTINEL";

    try {
      expect(await executeMikrotikCommand("/ip address print", createContext())).toBe(
        "SAFE-MODE-SENTINEL",
      );
    } finally {
      mgr.execute = execute;
      Reflect.deleteProperty(mgr, "isActive");
    }
  });
});
