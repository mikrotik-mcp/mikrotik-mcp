import { expect, test } from "vite-plus/test";
import {
  CREDENTIAL_SOURCE,
  duplicateDevice,
  renameDevice,
  reorderDevices,
} from "../../src/config-device-draft";
import { mergeConfigDraft, mergeDeviceDraft, serializeConfig } from "../../src/config-write";
import { REDACTED, redact } from "../../src/observability/event";
import { MikrotikConfigSchema } from "../../src/config";

const current = {
  defaultDevice: "home",
  dashboard: { token: "dashboard-secret" },
  devices: {
    home: {
      host: "192.0.2.1",
      username: "admin",
      password: "secret",
      privateKey: "key",
      passphrase: "phrase",
      disabled: false,
      port: 2222,
      description: "Home",
      timeoutMs: 5000,
    },
    edge: { host: "192.0.2.2", username: "admin", password: "edge-secret" },
  },
};

test("copy includes every setting, stays independent, and securely restores credentials through repeated copies", () => {
  const draft = redact(current) as Record<string, unknown>;
  const first = duplicateDevice(draft, "home");
  const second = duplicateDevice(first.config, "home");
  expect(first.name).toBe("home-copy");
  expect(second.name).toBe("home-copy-2");
  const nested = duplicateDevice(first.config, first.name);
  const resolved = mergeConfigDraft(nested.config, current) as typeof current;
  expect(resolved.devices["home-copy-copy" as "home"]).toEqual(current.devices.home);
  expect(JSON.stringify(nested.config)).not.toContain('"secret"');
  expect(JSON.stringify(resolved)).not.toContain(CREDENTIAL_SOURCE);
  expect(resolved.dashboard.token).toBe("dashboard-secret");
  expect(first.config.defaultDevice).toBe("home");
  const devices = first.config.devices as Record<string, Record<string, unknown>>;
  devices[first.name].host = "192.0.2.9";
  devices[first.name].password = "replacement";
  expect((draft.devices as typeof current.devices).home.host).toBe("192.0.2.1");
  expect(mergeDeviceDraft(devices[first.name], first.name, current.devices)).toMatchObject({
    host: "192.0.2.9",
    password: "replacement",
    privateKey: "key",
  });
});

test("rename preserves position, default and secrets even when the source is removed in the draft", () => {
  const draft = redact(current) as Record<string, unknown>;
  const renamed = renameDevice(draft, "home", "new-home");
  expect(Object.keys(renamed.devices as object)).toEqual(["new-home", "edge"]);
  expect(renamed.defaultDevice).toBe("new-home");
  expect(
    (mergeConfigDraft(renamed, current) as { devices: Record<string, unknown> }).devices[
      "new-home"
    ],
  ).toEqual(current.devices.home);
  expect(() => renameDevice(draft, "home", "edge")).toThrow();
  expect(() => duplicateDevice(draft, "missing")).toThrow();
});

test("device order survives secret resolution, schema validation and serialization without changing the default", () => {
  const draft = reorderDevices(redact(current) as Record<string, unknown>, ["edge", "home"]);
  const config = MikrotikConfigSchema.parse(mergeConfigDraft(draft, current));
  const saved = JSON.parse(serializeConfig(config));
  expect(Object.keys(saved.devices)).toEqual(["edge", "home"]);
  expect(saved.defaultDevice).toBe("home");
  expect(reorderDevices(draft, ["edge", "edge"])).toBe(draft);
  expect(reorderDevices(draft, ["ghost", "home"])).toBe(draft);
});

test("missing or invalid credential origins fail closed; markers never become credentials", () => {
  for (const source of ["missing", "__proto__", 1]) {
    expect(() =>
      mergeDeviceDraft({ [CREDENTIAL_SOURCE]: source, password: REDACTED }, "new", current.devices),
    ).toThrow();
  }
  expect(mergeDeviceDraft({ password: "typed" }, "new", current.devices)).toEqual({
    password: "typed",
  });
  expect(mergeDeviceDraft({ password: REDACTED }, "new", current.devices)).toEqual({});
});
