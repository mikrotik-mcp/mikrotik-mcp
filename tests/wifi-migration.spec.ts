/** Wireless to wifi: settings are translated, and what cannot move is named. */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fillSecrets, planCapsmanMigration, planWifiMigration } from "../src/core/wifi-migration";

const command = vi.hoisted(() => vi.fn());
const applied = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../src/core/runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveDeviceName: (name?: string) => name ?? "edge",
}));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: async () => "snap_1" }));
vi.mock("../src/utils/safe-mode-apply", () => ({ applyWritesSafely: applied }));
const { wifiMigrationTools } = await import("../src/tools/wifi-migration");

const interfaces: Record<string, string>[] = [
  {
    name: "wlan1",
    mode: "ap-bridge",
    ssid: "Home",
    band: "2ghz-b/g/n",
    "channel-width": "20/40mhz-XX",
    frequency: "2437",
    country: "germany",
    "security-profile": "home",
    "default-forwarding": "no",
    "wps-mode": "disabled",
    disabled: "no",
  },
  {
    name: "wlan2",
    mode: "ap-bridge",
    ssid: "Home 5G",
    band: "5ghz-a/n/ac",
    "channel-width": "20/40/80mhz-Ceee",
    frequency: "auto",
    "security-profile": "home",
    "hide-ssid": "yes",
    disabled: "yes",
  },
  {
    name: "guest",
    "master-interface": "wlan2",
    mode: "ap-bridge",
    ssid: "Guest",
    "security-profile": "open",
    "vlan-mode": "use-tag",
    "vlan-id": "20",
  },
];
const profiles: Record<string, string>[] = [
  { name: "home", mode: "dynamic-keys", "authentication-types": "wpa-psk,wpa2-psk" },
  { name: "open", mode: "none" },
];
const accessList: Record<string, string>[] = [
  {
    "mac-address": "AA:BB:CC:00:00:01",
    interface: "wlan1",
    authentication: "no",
    comment: "blocked",
  },
  {
    "mac-address": "AA:BB:CC:00:00:02",
    interface: "any",
    authentication: "yes",
    "signal-range": "-80..120",
  },
];

test("each setting moves to its new name, radios are renamed, virtual APs follow their master", () => {
  const plan = planWifiMigration(interfaces, profiles, accessList);
  expect(plan.blockers).toEqual([]);
  expect(plan.commands).toEqual([
    "/interface wifi set [find default-name=wifi1] configuration.mode=ap configuration.ssid=Home configuration.country=germany channel.band=2ghz-n channel.width=20/40mhz channel.frequency=2437 datapath.client-isolation=yes security.wps=disable security.authentication-types=wpa2-psk security.passphrase=CHANGE-ME disabled=no",
    '/interface wifi set [find default-name=wifi2] configuration.mode=ap configuration.ssid="Home 5G" configuration.hide-ssid=yes channel.band=5ghz-ac channel.width=20/40/80mhz security.authentication-types=wpa2-psk security.passphrase=CHANGE-ME disabled=yes',
    "/interface wifi add name=guest master-interface=wifi2 configuration.mode=ap configuration.ssid=Guest datapath.vlan-id=20 disabled=no",
    "/interface wifi access-list add mac-address=AA:BB:CC:00:00:01 action=reject interface=wifi1 comment=blocked",
    "/interface wifi access-list add mac-address=AA:BB:CC:00:00:02 action=accept signal-range=-80..120",
  ]);
  const notes = plan.notes.join("\n");
  expect(notes).toContain("Replace CHANGE-ME with the password of security profile 'home'");
  expect(notes).toContain("WPA (version 1) is dropped");
  expect(notes).toContain("guest: the network is open");
  expect(notes).toContain("point them at the new names (wifi1)");
});

test("links the new driver cannot carry are blockers, not silent drops", () => {
  const plan = planWifiMigration(
    [
      { name: "wlan1", mode: "station", "wireless-protocol": "nv2", ssid: "ptp" },
      { name: "wlan2", mode: "ap-bridge", "wds-mode": "dynamic", ssid: "mesh" },
      { name: "wlan3", mode: "station-wds", ssid: "x" },
    ],
    [],
    [],
  );
  expect(plan.blockers).toHaveLength(3);
  expect(plan.blockers[0]).toContain("wireless-protocol=nv2");
  expect(plan.blockers[1]).toContain("WDS");
  expect(plan.blockers[2]).toContain("mode=station-wds has no equivalent");
  // The interface with no equivalent mode gets no command.
  expect(plan.commands.some((c) => c.includes("wifi3"))).toBe(false);
});

const run = async (
  name = "plan_wireless_to_wifi_migration",
  args: Record<string, unknown> = {},
): Promise<string> => {
  const tool = wifiMigrationTools.find((t) => t.name === name)!;
  const result = await (tool.handler as (a: unknown, c: unknown) => Promise<unknown>)(
    z.object(tool.inputSchema).parse(args),
    { device: "edge", info() {}, error() {} },
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};
beforeEach(() => {
  command.mockReset();
  applied.mockReset();
  vi.stubEnv("MIKROTIK_WIFI_MIGRATION_DIR", mkdtempSync(join(tmpdir(), "wifi-mig-")));
});

test("a legacy CAPsMAN becomes wifi profiles that keep their names", () => {
  const plan = planCapsmanMigration({
    manager: { enabled: "yes", certificate: "auto" },
    cap: {},
    securities: [{ name: "sec", "authentication-types": "wpa-psk,wpa2-psk" }],
    channels: [
      {
        name: "ch5",
        band: "5ghz-a/n/ac",
        "control-channel-width": "20mhz",
        "extension-channel": "Ceee",
        frequency: "5180",
      },
      {
        name: "ch2",
        band: "2ghz-b/g/n",
        "control-channel-width": "20mhz",
        "extension-channel": "disabled",
      },
    ],
    datapaths: [
      {
        name: "dp",
        bridge: "bridge",
        "vlan-mode": "use-tag",
        "vlan-id": "30",
        "client-to-client-forwarding": "no",
      },
    ],
    configurations: [
      {
        name: "cfg",
        ssid: "Office",
        security: "sec",
        channel: "ch5",
        datapath: "dp",
        "security.encryption": "aes-ccm",
      },
    ],
    provisioning: [
      {
        action: "create-dynamic-enabled",
        "master-configuration": "cfg",
        "hw-supported-modes": "ac,an",
      },
      { action: "none" },
    ],
  });
  expect(plan.commands).toEqual([
    "/interface wifi security add name=sec authentication-types=wpa2-psk passphrase=CHANGE-ME",
    "/interface wifi channel add name=ch5 band=5ghz-ac width=20/40/80mhz frequency=5180",
    "/interface wifi channel add name=ch2 band=2ghz-n width=20mhz",
    "/interface wifi datapath add name=dp bridge=bridge vlan-id=30 client-isolation=yes",
    "/interface wifi configuration add name=cfg mode=ap ssid=Office security=sec channel=ch5 datapath=dp",
    "/interface wifi provisioning add action=create-dynamic-enabled master-configuration=cfg supported-bands=5ghz-ac,5ghz-n",
    "/interface wifi capsman set enabled=yes",
  ]);
  expect(plan.secretFor[0]).toBe("sec");
  expect(plan.blockers[0]).toContain("manages only CAPs that run the wifi driver");
  const notes = plan.notes.join("\n");
  expect(notes).toContain("WPA (version 1) is dropped");
  expect(notes).toContain("inline settings are not carried over (security.encryption)");
  expect(notes).toContain("certificate=auto");

  const cap = planCapsmanMigration({
    manager: {},
    cap: { enabled: "yes", "discovery-interfaces": "ether1" },
    securities: [],
    channels: [],
    datapaths: [],
    configurations: [],
    provisioning: [],
  });
  expect(cap.commands).toEqual(["/interface wifi cap set enabled=yes discovery-interfaces=ether1"]);
  expect(cap.blockers).toEqual([]);
});

test("a password is put in as one quoted value, and a missing one is named", () => {
  const plan = {
    commands: [
      "/interface wifi security add name=sec passphrase=CHANGE-ME",
      "/interface wifi capsman set enabled=yes",
    ],
    secretFor: ["sec", undefined],
  };
  expect(fillSecrets(plan, {})).toEqual({ commands: plan.commands, missing: ["sec"] });
  const filled = fillSecrets(plan, { sec: 'p"w ; /system reset-configuration' });
  expect(filled.missing).toEqual([]);
  expect(filled.commands[0]).toBe(
    '/interface wifi security add name=sec passphrase="p\\"w ; /system reset-configuration"',
  );
});

const legacy = async (cmd?: string): Promise<string> => {
  const text = String(cmd);
  if (text === "/interface wireless print detail")
    return ' 0 name="wlan1" mode=ap-bridge ssid="Home" band=2ghz-b/g/n security-profile=home';
  if (text.includes("security-profiles"))
    return ' 0 name="home" mode=dynamic-keys authentication-types=wpa2-psk';
  if (text.startsWith(":put [:parse")) return "(evl ok)";
  return "";
};

test("the saved plan is applied only on a wifi router, with passwords read on the host", async () => {
  expect(await run("apply_wireless_to_wifi_migration")).toContain("No saved plan for 'edge'");
  command.mockImplementation(legacy);
  const planned = await run("plan_wireless_to_wifi_migration", { save: true });
  expect(planned).toContain("Plan saved:");
  expect(planned).toContain("Passwords needed at apply time, one for each of: home");

  // Still the legacy driver: there is no wifi menu.
  command.mockImplementation(async (cmd?: string) =>
    String(cmd).startsWith(":put [:parse") ? "(<%% bad command name wifi (line 1 column 12))" : "",
  );
  expect(await run("apply_wireless_to_wifi_migration")).toContain(
    "has no /interface wifi menu yet",
  );

  command.mockImplementation(legacy);
  expect(await run("apply_wireless_to_wifi_migration")).toContain(
    "no password reference for: home",
  );
  const schema = z.object(wifiMigrationTools[1]!.inputSchema);
  expect(schema.safeParse({ passwords_from: { home: "hunter2" } }).success).toBe(false);

  vi.stubEnv("HOME_WIFI", "s3cret pass");
  const args = { passwords_from: { home: "env:HOME_WIFI" } };
  const dry = await run("apply_wireless_to_wifi_migration", args);
  expect(dry).toContain("DRY RUN — 1 command(s)");
  expect(dry).toContain("security.passphrase=«hidden»");
  expect(dry).not.toContain("s3cret");
  expect(applied).not.toHaveBeenCalled();

  applied.mockResolvedValue({
    applied: 1,
    total: 1,
    safeMode: "committed",
    committed: true,
    fellBack: false,
  });
  const done = await run("apply_wireless_to_wifi_migration", { ...args, apply: true });
  expect(done).toContain("snapshot=snap_1  safe-mode=committed");
  expect(done).not.toContain("s3cret");
  expect((applied.mock.calls[0]![2] as string[])[0]).toContain('security.passphrase="s3cret pass"');
  expect(applied.mock.calls[0]![3]).toEqual({ allowDirectFallback: false });
  vi.unstubAllEnvs();
});

test("the tool only reads, never asks for a password, and says when there is nothing to move", async () => {
  expect(wifiMigrationTools[0]!.annotations.readOnlyHint).toBe(true);
  command.mockImplementation(async (cmd?: string) => {
    if (cmd === "/interface wireless print detail")
      return ' 0 name="wlan1" mode=ap-bridge ssid="Home" band=2ghz-b/g/n security-profile=home';
    if (String(cmd).includes("security-profiles"))
      return ' 0 name="home" mode=dynamic-keys authentication-types=wpa2-psk';
    return "";
  });
  const text = await run();
  expect(text).toContain("plan for 1 interface(s). Nothing was changed.");
  expect(text).toContain("No blocker found.");
  expect(text).toContain("security.passphrase=CHANGE-ME");
  const sent = command.mock.calls.map((c) => String(c[0]));
  expect(sent.every((c) => /print(?: detail)?$/.test(c))).toBe(true);
  expect(sent.some((c) => c.includes("show-sensitive"))).toBe(false);

  command.mockImplementation(async () => "bad command name wireless (line 1 column 12)");
  expect(await run()).toContain("has no legacy `/interface wireless` menu");
  command.mockImplementation(async () => "");
  expect(await run()).toContain("no wireless interface and no CAPsMAN configuration");
});
