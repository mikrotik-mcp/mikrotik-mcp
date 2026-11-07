import { beforeEach, expect, test, vi } from "vite-plus/test";
import { bandwidthServerTools } from "../../src/tools/tool-bandwidth-server";
import { executeMikrotikCommand } from "../../src/core/connector";
import { MikrotikConfigSchema } from "../../src/config";
import { redact } from "../../src/observability/event";
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
const update = bandwidthServerTools.find((t) => t.name === "update_bandwidth_server")!;
const ctx = { info: vi.fn(), error: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeMikrotikCommand).mockResolvedValue("");
});
test("server allowlists distinguish unchanged from explicitly cleared", async () => {
  await update.handler(
    { allowed_addresses4: ["10.0.0.1/32"], allowed_addresses6: ["::1/128"] },
    ctx,
  );
  expect(executeMikrotikCommand).toHaveBeenNthCalledWith(
    1,
    "/tool bandwidth-server set allowed-addresses4=10.0.0.1/32 allowed-addresses6=::1/128",
    ctx,
  );
  vi.clearAllMocks();
  await update.handler({ allowed_addresses4: [] }, ctx);
  expect(executeMikrotikCommand).toHaveBeenNthCalledWith(
    1,
    '/tool bandwidth-server set allowed-addresses4=""',
    ctx,
  );
});
test("dedicated credentials are bounded and recursively redacted", () => {
  const config = {
    devices: {
      test: { host: "192.0.2.1", bandwidthAuth: { username: "test", password: "secret" } },
    },
    defaultDevice: "test",
  };
  expect(MikrotikConfigSchema.safeParse(config).success).toBe(true);
  expect(JSON.stringify(redact(config))).not.toContain('"secret"');
  config.devices.test.bandwidthAuth.password = "x".repeat(33);
  expect(MikrotikConfigSchema.safeParse(config).success).toBe(false);
});
