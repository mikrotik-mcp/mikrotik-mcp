/** Power over Ethernet — `/interface ethernet poe`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolModule } from "../core/registry";
import { READ, defineTool, withRequires } from "../core/registry";
import { looksLikeError, isEmpty, commandUnsupported } from "../core/routeros";

/**
 * Devices without PoE-out hardware have no `/interface ethernet poe` menu, so
 * RouterOS answers with `bad command name poe`. Treat that as "no PoE hardware"
 * rather than wrapping the parser error in a success message.
 *
 * The message disambiguates PoE-OUT from PoE-IN: a device that is *powered* over
 * Ethernet (PoE-IN) but cannot *supply* power to others still has no
 * `/interface ethernet poe` menu — that is expected, not a fault — and its
 * PoE-IN status lives under `/system health`, surfaced by `get_system_health`.
 */
const NO_POE =
  "This device has no PoE-OUT hardware, so the `/interface ethernet poe` menu " +
  "(used to SUPPLY power to other devices) is not available — this is normal, not an error. " +
  "Note: PoE-OUT (this router powering other devices) is different from PoE-IN (this router being " +
  "powered over Ethernet). If your device is PoE-powered, read its PoE-IN voltage/state with " +
  "get_system_health (`/system health`), not the PoE tools.";

const poeToolsDefs: ToolModule = [
  defineTool({
    name: "get_poe_monitor",
    title: "Read PoE Interface Live Metrics",
    annotations: READ,
    description:
      "Read live Power-over-Ethernet monitor data (`/interface ethernet poe monitor <interfaces> once`) — returns a real-time snapshot of PoE-out status, voltage (V), current (mA), and power (W) for one or more interfaces. Use this to diagnose active power delivery on PoE ports or confirm a powered device is drawing current. For static PoE-out configuration (mode, priority, thresholds) use `get_poe_settings`; for a summary list of all PoE-capable interfaces use `list_poe`. The `interfaces` argument takes a comma-separated list of ethernet interface names, e.g. 'ether1' or 'ether9,ether10'.",
    inputSchema: {
      interfaces: z
        .string()
        .describe("Comma-separated ethernet interface name(s), e.g. 'ether1' or 'ether9,ether10'"),
    },
    async handler(a, ctx) {
      ctx.info(`Reading PoE monitor for: ${a.interfaces}`);
      // `once` is required — without it the monitor streams forever and hangs the session.
      const result = await executeMikrotikCommand(
        `/interface ethernet poe monitor ${a.interfaces} once`,
        ctx,
      );
      if (commandUnsupported(result)) return NO_POE;
      if (looksLikeError(result)) return `Failed to read PoE monitor: ${result}`;
      if (isEmpty(result)) {
        return `No PoE monitor data returned for: ${a.interfaces}. The interface(s) may not exist or may not support PoE-out.`;
      }
      return `POE MONITOR:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_poe",
    title: "List PoE Interface Configuration",
    annotations: READ,
    description:
      "List the Power-over-Ethernet configuration of all PoE-capable ethernet interfaces (`/interface ethernet poe print`) — returns PoE-out mode and priority for each port. Use this to see at a glance which ports have PoE-out enabled across the whole device. For detailed settings of one specific interface (voltage thresholds, etc.) use `get_poe_settings`; for real-time voltage/current/power readings use `get_poe_monitor`. Optionally narrow results by partial interface name via `interface_filter`, e.g. 'ether'.",
    inputSchema: {
      interface_filter: z.string().optional().describe("Partial name match, e.g. 'ether'"),
    },
    async handler(a, ctx) {
      ctx.info("Listing PoE configuration");
      let cmd = "/interface ethernet poe print";
      if (a.interface_filter) cmd += ` where name~"${a.interface_filter}"`;
      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NO_POE;
      if (looksLikeError(result)) return `Failed to list PoE configuration: ${result}`;
      if (isEmpty(result)) return "No PoE-capable ethernet interfaces found on this device.";
      return `POE CONFIGURATION:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_poe_settings",
    title: "Get PoE Interface Settings",
    annotations: READ,
    description:
      "Get detailed Power-over-Ethernet settings for a single ethernet interface (`/interface ethernet poe print detail where name=<name>`) — returns PoE-out mode, priority, voltage, and power thresholds for that port. Use this to inspect the full PoE-out configuration of one specific port. For a summary list across all PoE-capable interfaces use `list_poe`; for real-time voltage/current/power measurements use `get_poe_monitor`. The `name` argument takes the exact interface name, e.g. 'ether1'.",
    inputSchema: {
      name: z.string().describe("Exact ethernet interface name, e.g. 'ether1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting PoE settings for: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/interface ethernet poe print detail where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(result)) return NO_POE;
      if (looksLikeError(result)) return `Failed to get PoE settings: ${result}`;
      if (isEmpty(result)) return `No PoE settings found for interface '${a.name}'.`;
      return `POE SETTINGS:\n\n${result}`;
    },
  }),
];

// PoE-out is a board feature, not an OS one — CHR and x86 have no PoE hardware.
export const poeTools: ToolModule = withRequires({ routerBoard: true }, poeToolsDefs);
