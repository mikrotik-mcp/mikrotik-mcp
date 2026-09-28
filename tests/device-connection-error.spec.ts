import { afterEach, expect, test } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import { createContext } from "../src/core/context";
import { executeMikrotikCommand } from "../src/core/connector";
import { DeviceConnectionError } from "../src/core/device-connection-error";
import { errorResponse } from "../src/observability/http-error";

const original = getConfig();
afterEach(() => setConfig(original));

test.each([true, false])(
  "failed SSH connection reaches HTTP as a device error (pool=%s)",
  async (keepAlive) => {
    setConfig(
      MikrotikConfigSchema.parse({
        defaultDevice: "offline-test",
        devices: { "offline-test": { host: "127.0.0.1", port: 1, timeoutMs: 300 } },
        ssh: { keepAlive },
      }),
    );
    let failure: unknown;
    try {
      await executeMikrotikCommand("/radius print detail", createContext());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeviceConnectionError);
    const res = errorResponse(failure);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "DEVICE_CONNECTION_FAILED",
      device: "offline-test",
      error: expect.stringContaining("Failed to connect to MikroTik device 'offline-test'"),
    });
    await expect(
      executeMikrotikCommand("/radius print", createContext(undefined, "missing")),
    ).rejects.not.toBeInstanceOf(DeviceConnectionError);
  },
);
