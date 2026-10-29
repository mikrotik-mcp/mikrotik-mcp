/** RouterOS HTTP/HTTPS CONNECT web proxy and its ordered access policy. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import {
  READ,
  WRITE,
  WRITE_IDEMPOTENT,
  DESTRUCTIVE,
  DANGEROUS,
  defineTool,
} from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, isEmpty, looksLikeError } from "../core/routeros";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";
import { listItemIds, ruleResolver } from "./_resolve-rule-id";

const scope = "/ip proxy access";
const resolveAccessId = ruleResolver(scope);

export const webProxyTools: ToolModule = [
  defineTool({
    name: "get_web_proxy",
    title: "Get Web Proxy Settings",
    annotations: READ,
    description:
      "Read RouterOS `/ip proxy` settings, including enabled, port, outgoing source and cache.",
    async handler(_a, ctx) {
      const result = await executeMikrotikCommand("/ip proxy print", ctx);
      return isEmpty(result) ? "Web proxy settings unavailable." : result;
    },
  }),
  defineTool({
    name: "update_web_proxy",
    title: "Update Web Proxy Settings",
    annotations: DANGEROUS,
    description:
      "Configure RouterOS `/ip proxy`. Enabling a listener does not restrict who may connect: " +
      "configure IPv4/IPv6 input firewall rules and inspect web proxy access rules first. " +
      "The outgoing src_address can select existing source-based policy routing; verify the route and NAT separately.",
    inputSchema: {
      enabled: z.boolean().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      src_address: z.string().optional(),
      anonymous: z.boolean().optional(),
      max_cache_size: z.string().optional(),
      confirm_firewall_ready: z
        .boolean()
        .optional()
        .describe("Required when enabling: IPv4 and IPv6 input firewall access has been verified."),
    },
    async handler(a, ctx) {
      if (a.enabled === true && !a.confirm_firewall_ready) {
        return "Refusing to enable web proxy until confirm_firewall_ready=true: verify both IPv4 and IPv6 input firewall restrictions first.";
      }
      const cmd = new Cmd("/ip proxy set")
        .bool("enabled", a.enabled)
        .opt("port", a.port)
        .opt("src-address", a.src_address)
        .bool("anonymous", a.anonymous)
        .opt("max-cache-size", a.max_cache_size);
      if (cmd.build() === "/ip proxy set") return "No updates specified.";
      const result = await executeMikrotikCommand(cmd.build(), ctx);
      if (looksLikeError(result)) return `Failed to update web proxy: ${result}`;
      return `Web proxy update sent. Current settings:\n${await executeMikrotikCommand("/ip proxy print", ctx)}`;
    },
  }),
  defineTool({
    name: "monitor_web_proxy",
    title: "Monitor Web Proxy",
    annotations: READ,
    description:
      "Read one `/ip proxy monitor once` sample, including connection and request counters.",
    async handler(_a, ctx) {
      return executeMikrotikCommand("/ip proxy monitor once", ctx);
    },
  }),
  defineTool({
    name: "list_web_proxy_access_rules",
    title: "List Web Proxy Access Rules",
    annotations: READ,
    description:
      "Read ordered `/ip proxy access` rules and their `.id`s. An unmatched request is allowed by RouterOS; use firewall input rules to control source address lists.",
    async handler(_a, ctx) {
      const result = await executeMikrotikCommand(`${scope} print detail`, ctx);
      return isEmpty(result)
        ? "No web proxy access rules (unmatched requests are allowed)."
        : result;
    },
  }),
  defineTool({
    name: "add_web_proxy_access_rule",
    title: "Add Web Proxy Access Rule",
    annotations: WRITE,
    description:
      "Add an allow/deny rule to `/ip proxy access`. Order matters; place_before is an existing `.id` or zero-based row. Use dst_address to block private targets; the proxy firewall controls client sources.",
    inputSchema: {
      action: z.enum(["allow", "deny"]),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      comment: z.string().optional(),
      place_before: z.string().optional(),
    },
    async handler(a, ctx) {
      const cmd = new Cmd(`${scope} add`)
        .set("action", a.action)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("comment", a.comment);
      const result = await executeRuleCreate(scope, cmd, ctx, a.place_before);
      if (looksLikeError(result)) return `Failed to add web proxy access rule: ${result}`;
      return readCreatedRule(scope, result, "Web proxy access rule", ctx);
    },
  }),
  defineTool({
    name: "remove_web_proxy_access_rule",
    title: "Remove Web Proxy Access Rule",
    annotations: DESTRUCTIVE,
    description:
      "Remove one `/ip proxy access` rule by `.id` or zero-based row, after inspecting the ordered list.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      const id = await resolveAccessId(a.rule_id, ctx);
      if (!id) return `Web proxy access rule '${a.rule_id}' not found.`;
      const result = await executeMikrotikCommand(`${scope} remove ${id}`, ctx);
      return looksLikeError(result)
        ? `Failed to remove web proxy access rule: ${result}`
        : `Removed web proxy access rule ${id}.`;
    },
  }),
  defineTool({
    name: "move_web_proxy_access_rule",
    title: "Move Web Proxy Access Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Move one `/ip proxy access` rule before the item at a zero-based destination position; reads back the resulting order.",
    inputSchema: { rule_id: z.string(), destination: z.number().int().min(0) },
    async handler(a, ctx) {
      const id = await resolveAccessId(a.rule_id, ctx);
      if (!id) return `Web proxy access rule '${a.rule_id}' not found.`;
      const before = await listItemIds(scope, ctx);
      if (a.destination >= before.length)
        return `NO CHANGE: destination ${a.destination} is outside the ${before.length} rule positions.`;
      if (before.indexOf(id) === a.destination)
        return `NO CHANGE: web proxy access rule ${id} is already at position ${a.destination}.`;
      const result = await executeMikrotikCommand(
        `${scope} move ${id} ${before[a.destination]}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move web proxy access rule: ${result}`;
      const to = (await listItemIds(scope, ctx)).indexOf(id);
      return to === a.destination
        ? `Web proxy access rule ${id} moved to position ${to}.`
        : `Web proxy access rule ${id} is at position ${to} (requested ${a.destination}); inspect the ordered list.`;
    },
  }),
];
