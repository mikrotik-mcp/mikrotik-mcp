/**
 * The move from the legacy `wireless` package to `wifi`: plan it (read-only),
 * save the plan, and apply the saved plan once the router runs the new driver.
 * The model is in `src/core/wifi-migration.ts`.
 *
 * The plan must be saved BEFORE the package is changed: after the change the
 * legacy menus are gone and there is nothing left to read.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { commandUnsupported, looksLikeError } from "../core/routeros";
import { parseKeyValues, parseRecords } from "../core/routeros-parse";
import { resolveDeviceName } from "../core/runtime";
import { SECRET_REF, resolveSecret } from "../core/secret-ref";
import { checkSyntax, describeProblem } from "../core/syntax-check";
import {
  PLACEHOLDER,
  fillSecrets,
  planCapsmanMigration,
  planWifiMigration,
} from "../core/wifi-migration";
import type { WifiMigrationPlan } from "../core/wifi-migration";
import { captureSnapshot } from "../snapshots/capture";
import { applyWritesSafely } from "../utils/safe-mode-apply";

/** Where saved plans go: `MIKROTIK_WIFI_MIGRATION_DIR`, or `~/.mikrotik-mcp/wifi-migrations`. */
export function migrationDir(): string {
  return (
    process.env.MIKROTIK_WIFI_MIGRATION_DIR || join(homedir(), ".mikrotik-mcp", "wifi-migrations")
  );
}
const fileOf = (device: string): string =>
  join(
    migrationDir(),
    `${device.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[.-]+/, "") || "device"}.json`,
  );

interface SavedPlan extends WifiMigrationPlan {
  device: string;
  savedAt: string;
}

/** Hide a password in a command that is shown to a person or the model. */
const hide = (command: string): string =>
  command.replace(/(passphrase=)(?:"(?:[^"\\]|\\.)*"|\S+)/g, `$1«hidden»`);

export const wifiMigrationTools: ToolModule = [
  defineTool({
    name: "plan_wireless_to_wifi_migration",
    title: "Plan the Move From 'wireless' to 'wifi'",
    annotations: READ,
    description:
      "Plans the migration of a router from the legacy `wireless` package (`/interface wireless`) " +
      "to the new `wifi` driver (`/interface wifi`, formerly wifiwave2). It reads the wireless " +
      "interfaces, their security profiles and the access list, and returns the equivalent " +
      "`/interface wifi` commands with every setting translated to its new name (ssid, mode, " +
      "band, channel width, frequency, country, hidden SSID, client isolation, VLAN, WPS, " +
      "authentication types, virtual APs, access-list entries). It also reads a legacy CAPsMAN " +
      "(`/caps-man`: security, channel, datapath, configuration, provisioning, the manager and " +
      "the CAP setting) and returns the commands for the wifi CAPsMAN. It lists BLOCKERS that the " +
      "new driver cannot do (Nv2 or Nstreme links, WDS, modes with no equivalent, legacy CAPs " +
      "under a wifi manager) and notes for a person. It changes NOTHING on the router and does " +
      "not read Wi-Fi passwords: the plan has a CHANGE-ME placeholder for each one. With " +
      "`save=true` the plan is also stored on the MCP host, which you MUST do before the package " +
      "is changed: afterwards the legacy menus are gone and cannot be read. The move is then: " +
      "install the new package, reboot, `apply_wireless_to_wifi_migration`. Fails with a clear " +
      "message when the router has no `wireless` menu.",
    inputSchema: {
      save: z
        .boolean()
        .default(false)
        .describe("Store the plan on the MCP host for apply_wireless_to_wifi_migration"),
    },
    async handler(a, ctx) {
      const read = async (command: string): Promise<string> =>
        executeMikrotikCommand(command, ctx).catch((error: unknown) => String(error));
      const rows = async (command: string): Promise<Record<string, string>[]> => {
        const out = await read(command);
        return looksLikeError(out) || commandUnsupported(out) ? [] : parseRecords(out).rows;
      };
      const values = async (command: string): Promise<Record<string, string>> => {
        const out = await read(command);
        return looksLikeError(out) || commandUnsupported(out) ? {} : parseKeyValues(out);
      };
      const interfacesOut = await read("/interface wireless print detail");
      if (commandUnsupported(interfacesOut) || looksLikeError(interfacesOut))
        return {
          text: "This router has no legacy `/interface wireless` menu, so there is nothing to migrate. It may already use `wifi`.",
          isError: false,
        };
      const interfaces = parseRecords(interfacesOut).rows;
      const radios = planWifiMigration(
        interfaces,
        await rows("/interface wireless security-profiles print detail"),
        await rows("/interface wireless access-list print detail"),
      );
      const caps = planCapsmanMigration({
        manager: await values("/caps-man manager print"),
        cap: await values("/interface wireless cap print"),
        configurations: await rows("/caps-man configuration print detail"),
        securities: await rows("/caps-man security print detail"),
        channels: await rows("/caps-man channel print detail"),
        datapaths: await rows("/caps-man datapath print detail"),
        provisioning: await rows("/caps-man provisioning print detail"),
      });
      // CAPsMAN profiles first: a radio or a provisioning rule may refer to them.
      const plan: WifiMigrationPlan = {
        commands: [...caps.commands, ...radios.commands],
        secretFor: [...caps.secretFor, ...radios.secretFor],
        blockers: [...radios.blockers, ...caps.blockers],
        notes: Array.from(new Set([...radios.notes, ...caps.notes])),
      };
      if (plan.commands.length === 0)
        return "The `wireless` package is installed, but this router has no wireless interface and no CAPsMAN configuration. Nothing to migrate.";

      const device = resolveDeviceName(ctx.device);
      const saved: string[] = [];
      if (a.save) {
        mkdirSync(migrationDir(), { recursive: true });
        const body: SavedPlan = { ...plan, device, savedAt: new Date().toISOString() };
        writeFileSync(fileOf(device), `${JSON.stringify(body, null, 2)}\n`);
        saved.push(
          "",
          `Plan saved: ${fileOf(device)}`,
          "After the package change and the reboot: apply_wireless_to_wifi_migration.",
        );
      }
      const secrets = Array.from(new Set(plan.secretFor.filter(Boolean)));
      return [
        `WIRELESS TO WIFI — plan for ${interfaces.length} interface(s)` +
          `${caps.commands.length > 0 ? ` and CAPsMAN (${caps.commands.length} command(s))` : ""}. Nothing was changed.`,
        "",
        plan.blockers.length > 0
          ? `BLOCKERS (${plan.blockers.length}) — resolve these first:\n${plan.blockers.map((b) => `  - ${b}`).join("\n")}`
          : "No blocker found.",
        "",
        "Commands for the new driver:",
        ...plan.commands.map((command) => `  ${command}`),
        "",
        secrets.length > 0
          ? `Passwords needed at apply time, one for each of: ${secrets.join(", ")}`
          : "No password is needed.",
        "",
        "Notes:",
        ...plan.notes.map((note) => `  - ${note}`),
        ...saved,
        ...(a.save ? [] : ["", "Not saved. Pass save=true before you change the package."]),
      ].join("\n");
    },
  }),

  defineTool({
    name: "apply_wireless_to_wifi_migration",
    title: "Apply a Saved 'wireless' to 'wifi' Plan",
    annotations: WRITE,
    description:
      "Applies the plan that `plan_wireless_to_wifi_migration save=true` stored for this router, " +
      "AFTER you installed the new `wifi` package and rebooted. It refuses to run while the " +
      "router still has no `/interface wifi` menu. Wi-Fi passwords do not pass through this " +
      "call: `passwords_from` maps each security profile name to a secret reference " +
      "(`env:NAME`, `file:/path` or `keyring:service/account`), which the server reads on the " +
      "host. A profile with no reference stops the run. A plan with blockers is refused unless " +
      "`ignore_blockers=true`. DEFAULTS TO A DRY RUN (`apply=false`) that shows the commands with " +
      "passwords hidden. Every command is first parsed on the router; if one is not valid, " +
      "nothing is written. Applying takes a config snapshot and writes in Safe Mode, so a " +
      "setting that cuts your connection is rolled back. Wireless clients reconnect when the " +
      "radios are configured. It does not install a package, does not reboot, and does not " +
      "change bridge ports, DHCP or firewall rules that still name the old interfaces.",
    inputSchema: {
      passwords_from: z
        .record(z.string(), z.string().regex(SECRET_REF))
        .default({})
        .describe("For each security profile: where its password is (a secret reference)"),
      ignore_blockers: z.boolean().default(false),
      apply: z.boolean().default(false).describe("false = show the commands; true = apply"),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      let plan: SavedPlan;
      try {
        plan = JSON.parse(readFileSync(fileOf(device), "utf8")) as SavedPlan;
      } catch {
        return `No saved plan for '${device}'. It is made with plan_wireless_to_wifi_migration save=true, before the package is changed.`;
      }
      const noMenu = await checkSyntax("/interface wifi print", ctx);
      if (noMenu)
        return `Not applied: '${device}' has no /interface wifi menu yet (${describeProblem(noMenu)}). Install the wifi package and reboot first.`;
      if (plan.blockers.length > 0 && !a.ignore_blockers)
        return `Not applied: the plan has ${plan.blockers.length} blocker(s). Resolve them, or pass ignore_blockers=true.\n${plan.blockers.map((b) => `  - ${b}`).join("\n")}`;

      const secrets: Record<string, string> = {};
      for (const [profile, reference] of Object.entries(a.passwords_from as Record<string, string>))
        try {
          secrets[profile] = resolveSecret(reference);
        } catch (error) {
          return `Not applied: the password of '${profile}' could not be read: ${error instanceof Error ? error.message : String(error)}`;
        }
      const { commands, missing } = fillSecrets(plan, secrets);
      if (missing.length > 0)
        return `Not applied: no password reference for: ${missing.join(", ")}. Add each to passwords_from.`;
      if (commands.some((command) => command.includes(PLACEHOLDER)))
        return `Not applied: a ${PLACEHOLDER} placeholder is left in the plan.`;

      for (const command of commands) {
        const problem = await checkSyntax(command, ctx);
        if (problem)
          return {
            text: `Nothing was written: this router does not accept "${hide(command)}": ${describeProblem(problem)}.`,
            isError: true,
          };
      }
      const preview = commands.map((command) => `  ${hide(command)}`).join("\n");
      if (!a.apply)
        return `DRY RUN — ${commands.length} command(s) from the plan of ${plan.savedAt}. Every command is valid on this router. Set apply=true to apply.\n\n${preview}`;

      const snapshotId = await captureSnapshot(ctx, "pre-wifi-migration");
      const outcome = await applyWritesSafely(ctx, device, commands, {
        allowDirectFallback: false,
      });
      return [
        `WIFI MIGRATION — snapshot=${snapshotId}  safe-mode=${outcome.safeMode}`,
        `Applied ${outcome.applied}/${outcome.total} command(s).`,
        ...(outcome.error ? [`FAILED: ${outcome.error}`] : []),
        "",
        preview,
        "",
        "Next: point bridge ports, the DHCP server and firewall rules at the new interface names.",
      ].join("\n");
    },
  }),
];
