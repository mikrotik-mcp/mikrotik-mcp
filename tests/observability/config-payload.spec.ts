import { afterEach, expect, test } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { mergeSecrets } from "../../src/config-write";
import { getConfig, setConfig } from "../../src/core/runtime";
import { configPayload } from "../../src/observability/dashboard";
const original = getConfig();
afterEach(() => setConfig(original));
test("Config Studio round-trips every feature block without resetting access or exposing secrets", () => {
  const cfg = MikrotikConfigSchema.parse({
    devices: { lab: { host: "192.0.2.1", password: "never-expose-this" } },
    defaultDevice: "lab",
    access: { enabled: true, maxRisk: "READ", denyTools: ["remove_*"] },
  });
  setConfig(cfg);
  const payload = configPayload();
  expect(Object.keys(payload as object).sort()).toEqual(Object.keys(cfg).sort());
  expect(JSON.stringify(payload)).not.toContain("never-expose-this");
  expect(MikrotikConfigSchema.parse(mergeSecrets(payload, cfg))).toEqual(cfg);
});
