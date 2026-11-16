/** Traffic monitor — `/tool traffic-monitor` (threshold-triggered scripts). */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { yesno, whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";

const Traffic = z.enum(["received", "transmitted"]);
const Trigger = z.enum(["above", "below", "always"]);

export const trafficMonitorTools: ToolModule = [
  defineTool({
    name: "add_traffic_monitor",
    title: "Add Traffic Monitor Entry",
    annotations: WRITE,
    description:
      "Creates a traffic-monitor entry (`/tool traffic-monitor add`) that fires a RouterOS script " +
      "when an interface's receive or transmit rate crosses a threshold — for event-driven automation " +
      "such as alerting, logging, or triggering throttling. " +
      "Not for real-time bandwidth measurement (use `/tool bandwidth-test`) or traffic shaping " +
      "(use `create_simple_queue` or `create_queue_tree`). " +
      "Returns the created entry's full detail.\n\n" +
      "Args:\n" +
      "    name: unique name for this entry.\n" +
      "    interface: name of the interface to watch.\n" +
      "    traffic: direction to watch — `received` or `transmitted`.\n" +
      "    trigger: fire when rate goes `above`, `below`, or `always` relative to the threshold.\n" +
      "    threshold: rate in bits/second.\n" +
      "    on_event: RouterOS script source or script name to execute when the trigger fires.",
    inputSchema: {
      name: z.string(),
      interface: z.string(),
      traffic: Traffic,
      trigger: Trigger,
      threshold: z.number().int().describe("Rate threshold in bits/second"),
      on_event: z.string().optional().describe("Script source/name to run on trigger"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding traffic-monitor: name=${a.name}`);
      const cmd = new Cmd("/tool traffic-monitor add")
        .set("name", a.name)
        .set("interface", a.interface)
        .set("traffic", a.traffic)
        .set("trigger", a.trigger)
        .set("threshold", a.threshold)
        .opt("on-event", a.on_event)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add traffic-monitor: ${result}`;
      const details = await executeMikrotikCommand(
        `/tool traffic-monitor print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `Traffic monitor added successfully:\n\n${details}`
        : "Traffic monitor addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_traffic_monitors",
    title: "List Traffic Monitor Entries",
    annotations: READ,
    description:
      "Lists all traffic-monitor entries (`/tool traffic-monitor print`) — for auditing " +
      "which interface thresholds and on-event scripts are configured on the device. " +
      "Optionally filter by `name_filter` (substring match on name), `interface_filter` " +
      "(exact interface name), or `disabled_only`. " +
      "Returns all matching entries with their threshold, trigger direction, and script. " +
      "To inspect a single entry in full detail use `get_traffic_monitor`.",
    inputSchema: {
      name_filter: z.string().optional(),
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing traffic monitors");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.interface_filter) filters.push(`interface="${a.interface_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      const result = await executeMikrotikCommand(
        `/tool traffic-monitor print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No traffic monitors found matching the criteria."
        : `TRAFFIC MONITORS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_traffic_monitor",
    title: "Get Traffic Monitor Entry Detail",
    annotations: READ,
    description:
      "Fetches the full detail of one traffic-monitor entry by name " +
      "(`/tool traffic-monitor print detail where name=...`) — for inspecting the watched " +
      "interface, traffic direction, trigger condition, threshold, on-event script, and " +
      "enabled/disabled state of a specific monitor. " +
      "To see all entries use `list_traffic_monitors`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting traffic-monitor: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/tool traffic-monitor print detail where name="${a.name}"`,
        ctx,
      );
      return isEmpty(result)
        ? `Traffic monitor '${a.name}' not found.`
        : `TRAFFIC MONITOR DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_traffic_monitor",
    title: "Update Traffic Monitor Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing traffic-monitor entry by name (`/tool traffic-monitor set [find name=...]`) — " +
      "for changing the watched interface, traffic direction (`received`/`transmitted`), trigger condition " +
      "(`above`/`below`/`always`), threshold (bits/second), or on-event script without removing and re-adding. " +
      "Supply only the fields to change; omitted fields are left unchanged. " +
      'Pass `comment=""` to clear the comment. ' +
      "Returns the updated entry's full detail. " +
      "To create a new entry use `add_traffic_monitor`.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string(),
      interface: z.string().optional(),
      traffic: Traffic.optional(),
      trigger: Trigger.optional(),
      threshold: z.number().int().optional(),
      on_event: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating traffic-monitor: name=${a.name}`);
      const base = `/tool traffic-monitor set [find name="${a.name}"]`;
      const cmd = new Cmd(base)
        .opt("interface", a.interface)
        .opt("traffic", a.traffic)
        .opt("trigger", a.trigger)
        .opt("threshold", a.threshold)
        .opt("on-event", a.on_event);
      if (a.comment !== undefined) cmd.raw(`comment=${quoteValue(a.comment)}`);
      if (a.disabled !== undefined) cmd.raw(`disabled=${yesno(a.disabled)}`);

      const built = cmd.unset(a.unset).build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update traffic-monitor: ${result}`;
      const details = await executeMikrotikCommand(
        `/tool traffic-monitor print detail where name="${a.name}"`,
        ctx,
      );
      return `Traffic monitor updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_traffic_monitor",
    title: "Remove Traffic Monitor Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a traffic-monitor entry by name (`/tool traffic-monitor remove [find name=...]`). " +
      "Performs a count-only existence check first and returns an error if the name is not found. " +
      "Use `disable_traffic_monitor` instead to keep the entry inactive without deleting it. " +
      "Returns confirmation on success.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing traffic-monitor: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/tool traffic-monitor print count-only where name="${a.name}"`,
        ctx,
      );
      if (count.trim() === "0") return `Traffic monitor '${a.name}' not found.`;
      const result = await executeMikrotikCommand(
        `/tool traffic-monitor remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove traffic-monitor: ${result}`;
      return `Traffic monitor '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_traffic_monitor",
    title: "Enable Traffic Monitor Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled traffic-monitor entry by name (`/tool traffic-monitor enable [find name=...]`) — " +
      "resumes threshold checking and on-event script execution without modifying any parameters. " +
      "To suspend monitoring temporarily without deleting use `disable_traffic_monitor`; " +
      "to delete permanently use `remove_traffic_monitor`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling traffic-monitor: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/tool traffic-monitor enable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable traffic-monitor: ${result}`;
      return `Traffic monitor '${a.name}' enabled.`;
    },
  }),

  defineTool({
    name: "disable_traffic_monitor",
    title: "Disable Traffic Monitor Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active traffic-monitor entry by name (`/tool traffic-monitor disable [find name=...]`) — " +
      "suspends threshold checking and on-event script execution without removing the entry. " +
      "To resume monitoring use `enable_traffic_monitor`; " +
      "to delete the entry permanently use `remove_traffic_monitor`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling traffic-monitor: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/tool traffic-monitor disable [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable traffic-monitor: ${result}`;
      return `Traffic monitor '${a.name}' disabled.`;
    },
  }),
];
