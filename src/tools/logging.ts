/** System logging rules and actions — `/system logging`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const systemLoggingTools: ToolModule = [
  defineTool({
    name: "add_logging_rule",
    title: "Add System Logging Rule",
    annotations: WRITE,
    description:
      "Creates a system logging rule (`/system logging add`) that routes log messages matching specified topics to a named logging action — defines WHICH topics go WHERE." +
      ' The `topics` field accepts comma-separated RouterOS topic strings (e.g. `"info"`, `"firewall,!debug"`).' +
      " The referenced action must already exist; to define a physical log destination (memory, disk, remote syslog, email, echo) use `add_logging_action`." +
      " To inspect existing rules use `list_logging_rules`." +
      " Returns the created rule's detail.",
    inputSchema: {
      topics: z.string().describe('Comma-separated log topics, e.g. "info", "firewall,!debug"'),
      action: z.string().optional().describe("Logging action name (default 'memory')"),
      prefix: z.string().optional().describe("Text prepended to each matching log message"),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding logging rule: topics=${a.topics}, action=${a.action ?? "memory"}`);
      const cmd = new Cmd("/system logging add")
        .set("topics", a.topics)
        .opt("action", a.action)
        .opt("prefix", a.prefix)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add logging rule: ${result}`;

      const details = await executeMikrotikCommand(
        `/system logging print detail where topics=${quoted(a.topics)}`,
        ctx,
      );
      return details.trim()
        ? `Logging rule added successfully:\n\n${details}`
        : "Logging rule add completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_logging_rules",
    title: "List System Logging Rules",
    annotations: READ,
    description:
      "Lists system logging rules (`/system logging print`), optionally filtered by partial topics match or exact action name." +
      " Returns the topic-to-action routing table — each rule shows which log topics are forwarded to which named action." +
      " To see what each action does (its physical destination) use `list_logging_actions`." +
      " Returns matching rules or a 'no rules found' message.",
    inputSchema: {
      topics_filter: z.string().optional().describe("Partial topics match"),
      action_filter: z.string().optional().describe("Exact action name"),
    },
    async handler(a, ctx) {
      ctx.info("Listing logging rules");
      const filters: string[] = [];
      if (a.topics_filter) filters.push(`topics~${quoted(a.topics_filter)}`);
      if (a.action_filter) filters.push(`action=${quoted(a.action_filter)}`);

      const result = await executeMikrotikCommand(
        `/system logging print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No logging rules found matching the criteria."
        : `LOGGING RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_logging_rule",
    title: "Remove System Logging Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a system logging rule (`/system logging remove`) by its `.id` — stops the matched topics from being routed to that action." +
      " Confirms the rule exists before deleting." +
      " `rule_id` is the `.id` value returned by `list_logging_rules` (e.g. `'*1'`)." +
      " To remove a logging action (physical destination) instead use `remove_logging_action`.",
    inputSchema: {
      rule_id: z.string().describe("Internal .id of the logging rule, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing logging rule: rule_id=${a.rule_id}`);
      const count = await executeMikrotikCommand(
        `/system logging print count-only where .id=${quoted(a.rule_id)}`,
        ctx,
      );
      if (count.trim() === "0") return `Logging rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/system logging remove [find .id=${quoted(a.rule_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove logging rule: ${result}`;
      return `Logging rule '${a.rule_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "add_logging_action",
    title: "Add System Logging Action",
    annotations: WRITE,
    description:
      "Creates a system logging action (`/system logging action add`) defining a physical log destination — the named target referenced by logging rules." +
      " `target` selects the destination type: `memory` (in-RAM buffer), `disk` (file), `echo` (terminal), `remote` (UDP syslog server), or `email`." +
      " Target-specific parameters: `remote`/`remote_port`/`bsd_syslog`/`syslog_facility`/`syslog_severity` for remote syslog;" +
      " `disk_file_name`/`disk_lines_per_file` for disk; `memory_lines` for memory; `email_to` for email." +
      " Once created, reference this action by name in `add_logging_rule`." +
      " To list existing actions use `list_logging_actions`." +
      " Returns the created action's detail.",
    inputSchema: {
      name: z.string().describe("Name for the new logging action"),
      target: z
        .enum(["memory", "disk", "echo", "remote", "email"])
        .describe("Where log messages are written"),
      remote: z.string().optional().describe("Remote syslog server address (target=remote)"),
      remote_port: z.number().int().optional().describe("Remote syslog UDP port"),
      src_address: z
        .string()
        .optional()
        .describe("Source address used when sending to remote syslog (target=remote)"),
      bsd_syslog: z.boolean().optional().describe("Use BSD-style syslog format"),
      syslog_facility: z.string().optional(),
      syslog_severity: z.string().optional(),
      syslog_time_format: z
        .string()
        .optional()
        .describe("Syslog timestamp format, e.g. 'bsd' or 'iso8601'"),
      disk_file_name: z.string().optional().describe("File name for target=disk"),
      disk_lines_per_file: z.number().int().optional(),
      disk_file_count: z
        .number()
        .int()
        .optional()
        .describe("Number of files used to store log (target=disk)"),
      disk_stop_on_full: z
        .boolean()
        .optional()
        .describe("Stop saving once disk-lines-per-file is reached (target=disk)"),
      memory_lines: z.number().int().optional().describe("Lines kept for target=memory"),
      memory_stop_on_full: z
        .boolean()
        .optional()
        .describe("Stop saving once memory-lines is reached (target=memory)"),
      remember: z
        .boolean()
        .optional()
        .describe("Keep messages not yet displayed in console (target=memory)"),
      email_to: z.string().optional().describe("Recipient address for target=email"),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding logging action: name=${a.name}, target=${a.target}`);
      const cmd = new Cmd("/system logging action add")
        .set("name", a.name)
        .set("target", a.target)
        .opt("remote", a.remote)
        .opt("remote-port", a.remote_port)
        .opt("src-address", a.src_address)
        .bool("bsd-syslog", a.bsd_syslog)
        .opt("syslog-facility", a.syslog_facility)
        .opt("syslog-severity", a.syslog_severity)
        .opt("syslog-time-format", a.syslog_time_format)
        .opt("disk-file-name", a.disk_file_name)
        .opt("disk-lines-per-file", a.disk_lines_per_file)
        .opt("disk-file-count", a.disk_file_count)
        .bool("disk-stop-on-full", a.disk_stop_on_full)
        .opt("memory-lines", a.memory_lines)
        .bool("memory-stop-on-full", a.memory_stop_on_full)
        .bool("remember", a.remember)
        .opt("email-to", a.email_to)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add logging action: ${result}`;

      const details = await executeMikrotikCommand(
        `/system logging action print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `Logging action added successfully:\n\n${details}`
        : "Logging action add completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_logging_actions",
    title: "List System Logging Actions",
    annotations: READ,
    description:
      "Lists system logging actions (`/system logging action print`), optionally filtered by partial name match." +
      " Returns the named destinations available for use in logging rules — each entry shows target type (memory, disk, echo, remote, email) and its configuration." +
      " To see the topic-routing rules that reference these actions use `list_logging_rules`." +
      " Returns matching actions or a 'no actions found' message.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing logging actions");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/system logging action print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No logging actions found matching the criteria."
        : `LOGGING ACTIONS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_logging_action",
    title: "Remove System Logging Action",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a system logging action (`/system logging action remove`) by its name — deletes the physical log destination definition." +
      " Confirms the action exists before deleting." +
      " `name` is the action name from `list_logging_actions`." +
      " Warning: removing an action still referenced by active logging rules leaves those rules with an invalid target — remove or update dependent rules first using `remove_logging_rule`." +
      " To remove a logging rule (topic filter) instead use `remove_logging_rule`.",
    inputSchema: {
      name: z.string().describe("Name of the logging action to remove"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing logging action: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/system logging action print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `Logging action '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/system logging action remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove logging action: ${result}`;
      return `Logging action '${a.name}' removed successfully.`;
    },
  }),
];
