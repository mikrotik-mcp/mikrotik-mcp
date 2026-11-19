/** Wireless to wifi: settings are translated, and what cannot move is named. */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { planWifiMigration } from "../src/core/wifi-migration";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
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

const run = async (): Promise<string> => {
  const tool = wifiMigrationTools[0]!;
  const result = await (tool.handler as (a: unknown, c: unknown) => Promise<unknown>)(
    {},
    { device: "edge", info() {}, error() {} },
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};
beforeEach(() => command.mockReset());

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
  expect(sent.every((c) => c.endsWith("print detail"))).toBe(true);
  expect(sent.some((c) => c.includes("show-sensitive"))).toBe(false);

  command.mockImplementation(async () => "bad command name wireless (line 1 column 12)");
  expect(await run()).toContain("has no legacy `/interface wireless` menu");
  command.mockImplementation(async () => "");
  expect(await run()).toContain("no wireless interface");
});
