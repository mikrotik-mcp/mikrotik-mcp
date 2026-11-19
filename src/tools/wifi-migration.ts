/**
 * Plan the move from the legacy `wireless` package to `wifi` — read-only.
 * The model is in `src/core/wifi-migration.ts`.
 */
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { commandUnsupported, looksLikeError } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { planWifiMigration } from "../core/wifi-migration";

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
      "authentication types, virtual APs, access-list entries). It also lists BLOCKERS that the " +
      "new driver cannot do (Nv2 or Nstreme links, WDS, modes with no equivalent) and notes for a " +
      "person. It changes NOTHING and does not read Wi-Fi passwords: the plan has a CHANGE-ME " +
      "placeholder for each one. The move itself is manual: install the new package, reboot, " +
      "then run the reviewed commands; wireless clients drop while you do it. Use this before " +
      "you decide to migrate, to see what the result would be and whether anything stands in " +
      "the way. Fails with a clear message when the router has no `wireless` menu.",
    inputSchema: {},
    async handler(_a, ctx) {
      const read = async (command: string): Promise<string> =>
        executeMikrotikCommand(command, ctx).catch((error: unknown) => String(error));
      const interfacesOut = await read("/interface wireless print detail");
      if (commandUnsupported(interfacesOut) || looksLikeError(interfacesOut))
        return {
          text: "This router has no legacy `/interface wireless` menu, so there is nothing to migrate. It may already use `wifi`.",
          isError: false,
        };
      const interfaces = parseRecords(interfacesOut).rows;
      if (interfaces.length === 0)
        return "The `wireless` package is installed, but this router has no wireless interface. Nothing to migrate.";
      const rows = async (command: string): Promise<Record<string, string>[]> => {
        const out = await read(command);
        return looksLikeError(out) ? [] : parseRecords(out).rows;
      };
      const plan = planWifiMigration(
        interfaces,
        await rows("/interface wireless security-profiles print detail"),
        await rows("/interface wireless access-list print detail"),
      );
      return [
        `WIRELESS TO WIFI — plan for ${interfaces.length} interface(s). Nothing was changed.`,
        "",
        plan.blockers.length > 0
          ? `BLOCKERS (${plan.blockers.length}) — resolve these first:\n${plan.blockers.map((b) => `  - ${b}`).join("\n")}`
          : "No blocker found.",
        "",
        "Commands for the new driver (review, then run after the package change and reboot):",
        ...plan.commands.map((command) => `  ${command}`),
        "",
        "Notes:",
        ...plan.notes.map((note) => `  - ${note}`),
        "",
        "Before you start: capture_config_snapshot, and have a wired or console way in.",
      ].join("\n");
    },
  }),
];
