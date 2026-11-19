/**
 * Plan the move from the legacy `wireless` package to `wifi` (the driver that
 * was called wifiwave2). PURE: it turns the rows of the old menus into the
 * commands for the new one, and says what cannot be carried over.
 *
 * The two menus name the same settings differently and group them differently:
 * `wireless` keeps the key in a separate security profile, `wifi` takes
 * `security.*`, `channel.*`, `configuration.*` and `datapath.*` inline.
 *
 * The plan is a script for a person to review. It is never applied by itself:
 * the move needs another package and a reboot, and wireless clients drop.
 */
import { Cmd, quoteValue } from "./routeros";

type Row = Record<string, string>;

/** Stands where a Wi-Fi password goes. The plan never holds a real one. */
export const PLACEHOLDER = "CHANGE-ME";

export interface WifiMigrationPlan {
  /** Commands for `/interface wifi`, in order. */
  commands: string[];
  /**
   * For a command that holds the CHANGE-ME placeholder: the name of the legacy
   * security profile whose password belongs there. Same order as `commands`.
   */
  secretFor: (string | undefined)[];
  /** Things the new driver cannot do. Resolve them before the move. */
  blockers: string[];
  /** Things a person must check or fill in. */
  notes: string[];
}

/** Legacy `band` to the new `channel.band`. */
const BAND: Record<string, string> = {
  "2ghz-b": "2ghz-g",
  "2ghz-b/g": "2ghz-g",
  "2ghz-onlyg": "2ghz-g",
  "2ghz-b/g/n": "2ghz-n",
  "2ghz-g/n": "2ghz-n",
  "2ghz-onlyn": "2ghz-n",
  "5ghz-a": "5ghz-a",
  "5ghz-a/n": "5ghz-n",
  "5ghz-onlyn": "5ghz-n",
  "5ghz-a/n/ac": "5ghz-ac",
  "5ghz-n/ac": "5ghz-ac",
  "5ghz-onlyac": "5ghz-ac",
};

/** Legacy `mode` to the new `configuration.mode`. `null` means no equivalent. */
const MODE: Record<string, string | null> = {
  "ap-bridge": "ap",
  bridge: "ap",
  "wds-slave": null,
  station: "station",
  "station-bridge": "station-bridge",
  "station-pseudobridge": "station-pseudobridge",
  "station-pseudobridge-clone": "station-pseudobridge",
  "station-wds": null,
  "nstreme-dual-slave": null,
  "alignment-only": null,
};

/** `20/40/80mhz-Ceee` to `20/40/80mhz`: the new driver picks the control channel. */
const width = (legacy: string): string => legacy.replace(/-[A-Za-z]+$/, "");

const yes = (value: string | undefined): boolean => value === "yes" || value === "true";

export function planWifiMigration(
  interfaces: Row[],
  profiles: Row[],
  accessList: Row[],
): WifiMigrationPlan {
  const commands: string[] = [];
  const secretFor: (string | undefined)[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];
  const profileOf = new Map(profiles.map((profile) => [profile.name ?? "", profile]));
  const physical = interfaces.filter((row) => !row["master-interface"]);
  /** `wlan1` becomes `wifi1`: the new driver names radios in the same order. */
  const newName = new Map<string, string>();
  physical.forEach((row, index) => newName.set(row.name ?? "", `wifi${index + 1}`));

  for (const row of interfaces) {
    const name = row.name ?? "?";
    const master = row["master-interface"];
    const protocol = row["wireless-protocol"];
    if (protocol === "nv2" || protocol === "nstreme")
      blockers.push(
        `${name}: wireless-protocol=${protocol}. The wifi driver speaks 802.11 only; an Nv2 or Nstreme link cannot be moved.`,
      );
    if (row["wds-mode"] && row["wds-mode"] !== "disabled")
      blockers.push(
        `${name}: WDS (wds-mode=${row["wds-mode"]}) works differently in wifi. Rebuild the link by hand.`,
      );
    const mode = row.mode ? MODE[row.mode] : "ap";
    if (mode === null || mode === undefined) {
      blockers.push(`${name}: mode=${row.mode} has no equivalent in wifi.`);
      continue;
    }

    const cmd = master
      ? new Cmd("/interface wifi add")
          .set("name", name)
          .set("master-interface", newName.get(master) ?? master)
      : new Cmd(`/interface wifi set [find default-name=${newName.get(name)}]`);
    cmd.set("configuration.mode", mode);
    if (row.ssid) cmd.set("configuration.ssid", row.ssid);
    if (yes(row["hide-ssid"])) cmd.set("configuration.hide-ssid", "yes");
    if (row.country && row.country !== "no_country_set") {
      cmd.set("configuration.country", row.country);
      notes.push(
        `${name}: country "${row.country}" is copied as it is. wifi writes country names with capitals ("United States"); correct it if the command is refused.`,
      );
    }
    if (!master) {
      const band = row.band ? BAND[row.band] : undefined;
      if (band) cmd.set("channel.band", band);
      else if (row.band)
        notes.push(`${name}: band=${row.band} was not mapped. Set channel.band by hand.`);
      if (row["channel-width"]) cmd.set("channel.width", width(row["channel-width"]));
      if (row.frequency && /^\d+$/.test(row.frequency)) cmd.set("channel.frequency", row.frequency);
    }
    if (row["default-forwarding"] === "no") cmd.set("datapath.client-isolation", "yes");
    if (row["vlan-mode"] === "use-tag" && row["vlan-id"] && row["vlan-id"] !== "1")
      cmd.set("datapath.vlan-id", row["vlan-id"]);
    if (row["wps-mode"] === "disabled") cmd.set("security.wps", "disable");

    const profile = profileOf.get(row["security-profile"] ?? "default");
    const types = (profile?.["authentication-types"] ?? "")
      .split(",")
      .filter((type) => /^wpa[23]?-(?:psk|eap)$/.test(type))
      // WPA1 is not offered by the new driver.
      .filter((type) => type !== "wpa-psk" && type !== "wpa-eap");
    if (profile && profile.mode !== "none" && types.length > 0) {
      cmd.set("security.authentication-types", types.join(","));
      if (types.some((type) => type.endsWith("-psk"))) {
        cmd.set("security.passphrase", PLACEHOLDER);
        notes.push(
          `${name}: the Wi-Fi password is not read from the router. Replace CHANGE-ME with the password of security profile '${profile.name}'.`,
        );
      }
      if ((profile["authentication-types"] ?? "").includes("wpa-psk"))
        notes.push(`${name}: WPA (version 1) is dropped. Very old clients will not connect.`);
    } else if (profile && profile.mode === "none")
      notes.push(`${name}: the network is open (no security), as before.`);
    cmd.set("disabled", yes(row.disabled) ? "yes" : "no");
    const built = cmd.build();
    commands.push(built);
    secretFor.push(built.includes(PLACEHOLDER) ? profile?.name : undefined);
  }

  for (const entry of accessList) {
    if (!entry["mac-address"]) continue;
    const cmd = new Cmd("/interface wifi access-list add")
      .set("mac-address", entry["mac-address"])
      .set("action", entry.authentication === "no" ? "reject" : "accept");
    const iface = entry.interface && entry.interface !== "any" ? entry.interface : undefined;
    if (iface) cmd.set("interface", newName.get(iface) ?? iface);
    if (entry["signal-range"] && entry["signal-range"] !== "-120..120")
      cmd.set("signal-range", entry["signal-range"]);
    if (entry.comment) cmd.set("comment", entry.comment);
    commands.push(cmd.build());
    secretFor.push(undefined);
  }

  if (interfaces.length > 0)
    notes.push(
      "Check that the device can run the new driver before you start: it needs the wifi-qcom-ac " +
        "package (802.11ac ARM devices) or wifi-qcom (802.11ax devices). MIPS devices and devices " +
        "with 16 MB of storage cannot run it.",
      "Bridge ports, the DHCP server and firewall rules name the old interfaces (wlan1). After the " +
        "move, point them at the new names (wifi1).",
    );
  return { commands, secretFor, blockers, notes: Array.from(new Set(notes)) };
}

/** Legacy CAPsMAN `hw-supported-modes` to the new `supported-bands`. */
const HW_MODE: Record<string, string> = {
  b: "2ghz-g",
  g: "2ghz-g",
  gn: "2ghz-n",
  a: "5ghz-a",
  an: "5ghz-n",
  ac: "5ghz-ac",
};

/** `control-channel-width` plus `extension-channel` to the new `width`. */
function capsWidth(row: Row): string | undefined {
  const base = row["control-channel-width"];
  if (!base) return undefined;
  const extension = row["extension-channel"] ?? "disabled";
  if (extension === "disabled" || base !== "20mhz") return base;
  return extension.length > 2 ? "20/40/80mhz" : "20/40mhz";
}

export interface CapsmanRows {
  manager: Row;
  cap: Row;
  configurations: Row[];
  securities: Row[];
  channels: Row[];
  datapaths: Row[];
  provisioning: Row[];
}

/**
 * Plan the move of a legacy CAPsMAN (`/caps-man`) to the wifi CAPsMAN
 * (`/interface wifi capsman`). The named profiles keep their names, so a
 * configuration still points at the same security, channel and datapath.
 */
export function planCapsmanMigration(rows: CapsmanRows): WifiMigrationPlan {
  const commands: string[] = [];
  const secretFor: (string | undefined)[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];
  const push = (command: string, secret?: string): void => {
    commands.push(command);
    secretFor.push(secret);
  };

  for (const row of rows.securities) {
    if (!row.name) continue;
    const types = (row["authentication-types"] ?? "")
      .split(",")
      .filter((type) => /^wpa[23]-(?:psk|eap)$/.test(type));
    const cmd = new Cmd("/interface wifi security add").set("name", row.name);
    if (types.length > 0) cmd.set("authentication-types", types.join(","));
    const psk = types.some((type) => type.endsWith("-psk"));
    if (psk) cmd.set("passphrase", PLACEHOLDER);
    if ((row["authentication-types"] ?? "").includes("wpa-psk"))
      notes.push(`security ${row.name}: WPA (version 1) is dropped.`);
    push(cmd.build(), psk ? row.name : undefined);
  }
  for (const row of rows.channels) {
    if (!row.name) continue;
    const cmd = new Cmd("/interface wifi channel add").set("name", row.name);
    const band = row.band ? BAND[row.band] : undefined;
    if (band) cmd.set("band", band);
    else if (row.band) notes.push(`channel ${row.name}: band=${row.band} was not mapped.`);
    const w = capsWidth(row);
    if (w) cmd.set("width", w);
    if (row.frequency && /^[\d,]+$/.test(row.frequency)) cmd.set("frequency", row.frequency);
    push(cmd.build());
  }
  for (const row of rows.datapaths) {
    if (!row.name) continue;
    const cmd = new Cmd("/interface wifi datapath add").set("name", row.name);
    if (row.bridge) cmd.set("bridge", row.bridge);
    if (row["vlan-mode"] === "use-tag" && row["vlan-id"]) cmd.set("vlan-id", row["vlan-id"]);
    if (row["client-to-client-forwarding"] === "no") cmd.set("client-isolation", "yes");
    if (row["local-forwarding"] === "yes")
      notes.push(
        `datapath ${row.name}: local-forwarding is how the wifi driver always works (a CAP bridges traffic itself). Traffic no longer passes through the manager.`,
      );
    push(cmd.build());
  }
  for (const row of rows.configurations) {
    if (!row.name) continue;
    const cmd = new Cmd("/interface wifi configuration add")
      .set("name", row.name)
      .set("mode", "ap");
    if (row.ssid) cmd.set("ssid", row.ssid);
    if (row.country && row.country !== "no_country_set") cmd.set("country", row.country);
    if (yes(row["hide-ssid"])) cmd.set("hide-ssid", "yes");
    for (const ref of ["security", "channel", "datapath"] as const)
      if (row[ref]) cmd.set(ref, row[ref]!);
    const inline = Object.keys(row).filter((key) => /^(?:security|channel|datapath)\./.test(key));
    if (inline.length > 0)
      notes.push(
        `configuration ${row.name}: inline settings are not carried over (${inline.join(", ")}). Put them in a named security, channel or datapath.`,
      );
    push(cmd.build());
  }
  for (const row of rows.provisioning) {
    const action = row.action ?? "none";
    if (action === "none") continue;
    const cmd = new Cmd("/interface wifi provisioning add").set("action", action);
    if (row["master-configuration"]) cmd.set("master-configuration", row["master-configuration"]);
    if (row["slave-configurations"]) cmd.set("slave-configurations", row["slave-configurations"]);
    if (row["radio-mac"] && row["radio-mac"] !== "00:00:00:00:00:00")
      cmd.set("radio-mac", row["radio-mac"]);
    const bands = (row["hw-supported-modes"] ?? "")
      .split(",")
      .map((mode) => HW_MODE[mode])
      .filter(Boolean);
    if (bands.length > 0) cmd.set("supported-bands", Array.from(new Set(bands)).join(","));
    if (row["identity-regexp"]) cmd.set("identity-regexp", row["identity-regexp"]);
    if (row["common-name-regexp"]) cmd.set("common-name-regexp", row["common-name-regexp"]);
    if (row.comment) cmd.set("comment", row.comment);
    push(cmd.build());
  }
  if (yes(rows.manager.enabled)) {
    push(new Cmd("/interface wifi capsman set").set("enabled", "yes").build());
    if (rows.manager.certificate && rows.manager.certificate !== "none")
      notes.push(
        `The manager uses certificate=${rows.manager.certificate}. Set the certificate on the new manager by hand.`,
      );
    blockers.push(
      "A wifi CAPsMAN manages only CAPs that run the wifi driver. CAPs that still run the legacy " +
        "wireless package stay with the old manager. Keep both managers running, and move the CAPs " +
        "one at a time.",
    );
  }
  if (yes(rows.cap.enabled)) {
    const cmd = new Cmd("/interface wifi cap set").set("enabled", "yes");
    if (rows.cap["discovery-interfaces"])
      cmd.set("discovery-interfaces", rows.cap["discovery-interfaces"]);
    if (rows.cap["caps-man-addresses"])
      cmd.set("caps-man-addresses", rows.cap["caps-man-addresses"]);
    push(cmd.build());
    notes.push(
      "This device is a CAP. After the move its manager must be a wifi CAPsMAN, and each radio " +
        "needs `configuration.manager=capsman` to be managed.",
    );
  }
  return { commands, secretFor, blockers, notes: Array.from(new Set(notes)) };
}

/** Put the real passwords in. Returns the commands and the profiles that still have none. */
export function fillSecrets(
  plan: Pick<WifiMigrationPlan, "commands" | "secretFor">,
  secrets: Record<string, string>,
): { commands: string[]; missing: string[] } {
  const missing = new Set<string>();
  const commands = plan.commands.map((command, index) => {
    const profile = plan.secretFor[index];
    if (!command.includes(PLACEHOLDER)) return command;
    const secret = profile === undefined ? undefined : secrets[profile];
    if (secret === undefined) {
      missing.add(profile ?? "?");
      return command;
    }
    // The same quoting as every other value: a password cannot end the string.
    return command.replace(`=${PLACEHOLDER}`, `=${quoteValue(secret)}`);
  });
  return { commands, missing: Array.from(missing) };
}
