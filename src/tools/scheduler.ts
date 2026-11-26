/** Scheduler & scripts — `/system scheduler` and `/system script`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { unsetProperties } from "../core/schema";

export const schedulerTools: ToolModule = [
  defineTool({
    name: "create_scheduler",
    title: "Create Scheduler Entry",
    annotations: WRITE,
    description:
      "Creates a scheduler entry (`/system scheduler add`) — time-driven automation that runs an inline script or calls a named script at a fixed interval or date/time. " +
      "Use this to trigger recurring or one-shot tasks without an interactive session. " +
      "For storing reusable scripts by name use add_script; to reference a stored script set on_event to its name. " +
      "interval accepts RouterOS duration strings like '00:05:00' (every 5 minutes); '0' means run once. " +
      "start_time accepts 'startup' or a wall-clock time like '12:00:00'; start_date accepts 'jan/01/2026'. " +
      "Returns the created entry's detail. To suspend without deleting use disable_scheduler; to re-activate use enable_scheduler.",
    inputSchema: {
      name: z.string().describe("Name for the scheduler entry"),
      on_event: z
        .string()
        .describe("Script source to run on event (may contain spaces/semicolons)"),
      interval: z.string().optional().describe("Run interval, e.g. '00:05:00' (0 = run once)"),
      start_time: z.string().optional().describe("Start time, e.g. '12:00:00' or 'startup'"),
      start_date: z.string().optional().describe("Start date, e.g. 'jan/01/2026'"),
      policy: z
        .string()
        .optional()
        .describe("Permission policy list, e.g. 'read,write,test,policy'"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating scheduler: name=${a.name}`);
      const cmd = new Cmd("/system scheduler add")
        .set("name", a.name)
        .set("on-event", a.on_event)
        .opt("interval", a.interval)
        .opt("start-time", a.start_time)
        .opt("start-date", a.start_date)
        .opt("policy", a.policy)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create scheduler: ${result}`;

      const details = await executeMikrotikCommand(
        `/system scheduler print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `Scheduler created successfully:\n\n${details}`
        : "Scheduler creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_schedulers",
    title: "List Scheduler Entries",
    annotations: READ,
    description:
      "Lists all scheduler entries (`/system scheduler print`) — every time-driven task configured on the device. " +
      "Optionally filters by partial name match via name_filter. " +
      "To retrieve full detail for a single entry use get_scheduler. " +
      "To list stored scripts (not schedulers) use list_scripts.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing schedulers");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/system scheduler print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No schedulers found matching the criteria."
        : `SCHEDULERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_scheduler",
    title: "Get Scheduler Entry Details",
    annotations: READ,
    description:
      "Retrieves full detail for a single scheduler entry (`/system scheduler print detail where name=...`). " +
      "Use this to inspect the on-event script, interval, next-run time, and run-count of one specific entry. " +
      "For all entries use list_schedulers. To look up stored system scripts use list_scripts.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting scheduler details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/system scheduler print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Scheduler '${a.name}' not found.`
        : `SCHEDULER DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_scheduler",
    title: "Update Scheduler Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing scheduler entry (`/system scheduler set [find name=...]`) in place without deleting and recreating it. " +
      "Targets the entry by its current `name`; supply `new_name` to rename it. Any combination of `on_event`, `interval`, `start_time`, `start_date`, `policy`, `comment`, or `disabled` can be updated. " +
      "To inspect the current entry first use get_scheduler. To update a stored script in `/system script` use update_script.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Current name of the scheduler entry to update"),
      new_name: z.string().optional().describe("New name if renaming the scheduler entry"),
      on_event: z
        .string()
        .optional()
        .describe("Updated script source or script name to run on event"),
      interval: z
        .string()
        .optional()
        .describe("Updated run interval, e.g. '00:05:00' or '5s' (0 = run once)"),
      start_time: z
        .string()
        .optional()
        .describe("Updated start time, e.g. '12:00:00' or 'startup'"),
      start_date: z.string().optional().describe("Updated start date, e.g. 'jan/01/2026'"),
      policy: z
        .string()
        .optional()
        .describe("Updated permission policy list, e.g. 'read,write,test,policy'"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating scheduler: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/system scheduler print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `Scheduler '${a.name}' not found.`;

      const cmd = new Cmd(`/system scheduler set [find name=${quoted(a.name)}]`)
        .opt("name", a.new_name)
        .opt("on-event", a.on_event)
        .opt("interval", a.interval)
        .opt("start-time", a.start_time)
        .opt("start-date", a.start_date)
        .opt("policy", a.policy)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .unset(a.unset)
        .build();

      if (!/[=!]/.test(cmd.slice(cmd.indexOf("]")))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update scheduler: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/system scheduler print detail where name=${quoted(target)}`,
        ctx,
      );
      return details.trim()
        ? `Scheduler updated successfully:\n\n${details}`
        : `Scheduler '${target}' updated successfully.`;
    },
  }),

  defineTool({
    name: "remove_scheduler",
    title: "Remove Scheduler Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a scheduler entry (`/system scheduler remove`) by name after verifying it exists. " +
      "Use this to delete a time-driven task from the device. " +
      "To suspend without deleting use disable_scheduler. " +
      "To remove a stored script (not a scheduler) use remove_script.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing scheduler: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/system scheduler print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `Scheduler '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/system scheduler remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove scheduler: ${result}`;
      return `Scheduler '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_scheduler",
    title: "Enable Scheduler Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled scheduler entry (`/system scheduler enable`) by name, allowing it to fire again on its configured interval or schedule. " +
      "Idempotent — safe to call when already enabled. " +
      "To pause without deleting use disable_scheduler. To permanently delete use remove_scheduler.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling scheduler: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/system scheduler enable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable scheduler: ${result}`;
      return `Scheduler '${a.name}' enabled successfully.`;
    },
  }),

  defineTool({
    name: "disable_scheduler",
    title: "Disable Scheduler Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active scheduler entry (`/system scheduler disable`) by name, preventing it from firing without removing it. " +
      "Idempotent — safe to call when already disabled. " +
      "To resume use enable_scheduler. To permanently delete use remove_scheduler.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling scheduler: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/system scheduler disable [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable scheduler: ${result}`;
      return `Scheduler '${a.name}' disabled successfully.`;
    },
  }),

  defineTool({
    name: "add_script",
    title: "Add Script to Repository",
    annotations: WRITE,
    description:
      "Stores a named script in the system script repository (`/system script add`) — reusable RouterOS code callable by name. " +
      "Use this to keep logic out of on-event fields and share it across multiple schedulers or trigger on demand. " +
      "To execute a stored script immediately use run_script. " +
      "To schedule a script to run periodically use create_scheduler (set on_event to the script name). " +
      "dont_require_permissions skips policy-permission checks of the caller. " +
      "Returns the added script's detail including its name and source.",
    inputSchema: {
      name: z.string().describe("Name for the script"),
      source: z
        .string()
        .describe(
          "Script source code, VERBATIM (may contain spaces/semicolons/quotes — they are quoted " +
            "and escaped for the console automatically). Never HTML-escape it: pass `<`, `>`, `&` " +
            "as themselves, since `&lt;`/`&gt;`/`&amp;` are stored literally and break comparisons.",
        ),
      policy: z
        .string()
        .optional()
        .describe("Permission policy list, e.g. 'read,write,test,policy'"),
      comment: z.string().optional(),
      dont_require_permissions: z
        .boolean()
        .default(false)
        .describe("Run without checking the policy permissions of the caller"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding script: name=${a.name}`);
      const cmd = new Cmd("/system script add")
        .set("name", a.name)
        .set("source", a.source)
        .opt("policy", a.policy)
        .opt("comment", a.comment)
        .flag("dont-require-permissions", a.dont_require_permissions)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add script: ${result}`;

      const details = await executeMikrotikCommand(
        `/system script print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `Script added successfully:\n\n${details}`
        : "Script creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_scripts",
    title: "List Scripts in Repository",
    annotations: READ,
    description:
      "Lists all stored scripts in the system script repository (`/system script print`). " +
      "Optionally filters by partial name match via name_filter. " +
      "Use this to see what named scripts are available for run_script or for referencing in a scheduler's on_event. " +
      "To list scheduled tasks (not stored scripts) use list_schedulers.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing scripts");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/system script print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No scripts found matching the criteria." : `SCRIPTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_script",
    title: "Get Script Details",
    annotations: READ,
    description:
      "Retrieves full detail — including the complete `source`, `policy`, `dont-require-permissions`, `run-count`, and `last-started` — for a single stored script (`/system script print detail where name=...`). " +
      "Use this to inspect a script's source code before modifying it with update_script. " +
      "To list all scripts use list_scripts.",
    inputSchema: {
      name: z.string().describe("Exact name of the script to inspect"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting script details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/system script print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result) ? `Script '${a.name}' not found.` : `SCRIPT DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_script",
    title: "Update Script in Repository",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing stored script in the system script repository (`/system script set [find name=...]`) in place without deleting and recreating it. " +
      'Targets the script by its current `name`; supply `new_name` to rename it. Any combination of `source`, `policy`, `comment`, or `dont_require_permissions` can be updated, with automatic RouterOS console quoting and `$` / `"` / `\\` / newline escaping. ' +
      "To inspect a script before editing use get_script; to run it on demand use run_script.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Current name of the script to update"),
      new_name: z.string().optional().describe("New name if renaming the script"),
      source: z
        .string()
        .optional()
        .describe(
          "Updated script source code, VERBATIM (may contain spaces/semicolons/quotes/newlines — they are quoted " +
            "and escaped for the console automatically). Never HTML-escape it: pass `<`, `>`, `&` " +
            "as themselves, since `&lt;`/`&gt;`/`&amp;` are stored literally and break comparisons.",
        ),
      policy: z
        .string()
        .optional()
        .describe("Updated permission policy list, e.g. 'read,write,test,policy'"),
      comment: z.string().optional(),
      dont_require_permissions: z
        .boolean()
        .optional()
        .describe("Run without checking the policy permissions of the caller (yes/no)"),
    },
    async handler(a, ctx) {
      ctx.info(`Updating script: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/system script print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `Script '${a.name}' not found.`;

      const cmd = new Cmd(`/system script set [find name=${quoted(a.name)}]`)
        .opt("name", a.new_name)
        .opt("source", a.source)
        .opt("policy", a.policy)
        .opt("comment", a.comment)
        .bool("dont-require-permissions", a.dont_require_permissions)
        .unset(a.unset)
        .build();

      if (!/[=!]/.test(cmd.slice(cmd.indexOf("]")))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update script: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/system script print detail where name=${quoted(target)}`,
        ctx,
      );
      return details.trim()
        ? `Script updated successfully:\n\n${details}`
        : `Script '${target}' updated successfully.`;
    },
  }),

  defineTool({
    name: "remove_script",
    title: "Remove Script from Repository",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a named script from the system script repository (`/system script remove`) after verifying it exists. " +
      "Use this to clean up scripts no longer needed. " +
      "Verify nothing references it via list_schedulers before removing — schedulers whose on-event names a deleted script will fail silently. " +
      "To remove a scheduler entry (not a script) use remove_scheduler.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing script: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/system script print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `Script '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/system script remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove script: ${result}`;
      return `Script '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "run_script",
    title: "Run Script from Repository",
    annotations: WRITE,
    description:
      "Executes a named script from the system script repository immediately (`/system script run`). " +
      "Use this to trigger a stored script on demand without waiting for a scheduler. " +
      "The script must already exist in the repository — to add one use add_script; to see available scripts use list_scripts. " +
      "For recurring or time-based execution use create_scheduler. " +
      "Returns the script's console output.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Running script: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/system script run [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to run script: ${result}`;
      return `Script '${a.name}' executed.\n\n${result}`;
    },
  }),
];
