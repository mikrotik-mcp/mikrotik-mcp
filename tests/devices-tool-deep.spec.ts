import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { deviceTools } from "../src/tools/devices";

const initial = getConfig();
const ctx: ToolContext = { device: "main", info: vi.fn(), error: vi.fn() };
beforeEach(() =>
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        main: {
          host: "192.0.2.1",
          port: 2222,
          username: "admin",
          password: "hidden-password",
          description: "HQ",
        },
        backup: {
          host: "198.51.100.2",
          username: "operator",
          keyFilename: "/secrets/key",
          fallbackHosts: ["198.51.100.3"],
        },
      },
      defaultDevice: "main",
    }),
  ),
);
afterEach(() => setConfig(initial));

test("inventory reports names, default, auth and endpoints without credentials", async () => {
  const result = await deviceTools[0].handler({} as never, ctx);
  if (typeof result !== "string") throw new Error("Expected device inventory text");
  expect(result).toContain("CONFIGURED MIKROTIK DEVICES (2)");
  expect(result).toContain("main (default): admin@192.0.2.1:2222 [auth: password]");
  expect(result).toContain("backup: operator@198.51.100.2:22 [auth: key]");
  expect(result).toContain("198.51.100.3");
  expect(result).not.toContain("hidden-password");
  expect(result).not.toContain("/secrets/key");
});
