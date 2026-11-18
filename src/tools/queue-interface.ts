/**
 * Per-interface queues — `/queue interface`.
 *
 * Each interface has one entry mapping it to a queue type (the queue applied to
 * traffic egressing that interface). Entries are fixed (one per interface), so
 * this scope is list/get plus assigning the queue type.
 */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const queueInterfaceTools: ToolModule = [
  defineTool({
    name: "list_queue_interfaces",
    title: "List Queue Interface Assignments",
    annotations: READ,
    description:
      "List per-interface queue assignments (`/queue interface`). " +
      "Shows which queue type (e.g. 'ethernet-default', 'only-hardware-queue') is currently applied to each interface's egress traffic. " +
      "RouterOS maintains exactly one entry per interface — these entries are fixed and cannot be created or deleted, only updated. " +
      "For bandwidth-limited queues use list_simple_queues; for hierarchical queues use list_queue_trees. " +
      "Returns all matching entries filtered optionally by partial interface name (interface_filter) or partial queue-type name (queue_filter).",
    inputSchema: {
      interface_filter: z.string().optional().describe("Partial interface-name match"),
      queue_filter: z.string().optional().describe("Partial queue-type-name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing queue interfaces");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface~${quoted(a.interface_filter)}`);
      if (a.queue_filter) filters.push(`queue~${quoted(a.queue_filter)}`);

      const result = await executeMikrotikCommand(
        `/queue interface print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No queue interfaces found matching the criteria."
        : `QUEUE INTERFACES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_queue_interface",
    title: "Get Queue Interface Assignment",
    annotations: READ,
    description:
      "Get the queue-type assignment for a single interface (`/queue interface print detail`). " +
      "Resolves by RouterOS '.id' first, then falls back to matching by interface name — pass either the interface name (e.g. 'ether1') or the '.id' from list_queue_interfaces. " +
      "For all interfaces at once use list_queue_interfaces. " +
      "Returns the full detail output for the matched entry including the interface name, queue type, and any active properties.",
    inputSchema: {
      interface_id: z.string().describe("Interface name (e.g. 'ether1') or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting queue interface: interface_id=${a.interface_id}`);
      let result = await executeMikrotikCommand(
        `/queue interface print detail where .id=${quoted(a.interface_id)}`,
        ctx,
      );
      if (isEmpty(result)) {
        result = await executeMikrotikCommand(
          `/queue interface print detail where interface=${quoted(a.interface_id)}`,
          ctx,
        );
      }
      return isEmpty(result)
        ? `Queue interface '${a.interface_id}' not found.`
        : `QUEUE INTERFACE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_queue_interface",
    title: "Update Queue Interface Assignment",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Assign a queue type to a specific interface (`/queue interface set`) — controls which egress queuing discipline is applied to outbound traffic on that interface. " +
      "Use this to switch between built-in types such as 'ethernet-default' or 'only-hardware-queue', or to apply a custom queue type defined under /queue type. " +
      "This does NOT create a bandwidth-limiting queue; for that use create_simple_queue (simple rate-limit) or create_queue_tree (hierarchical/HTB shaping). " +
      "Accepts the interface name (e.g. 'ether1') or RouterOS '.id' (from list_queue_interfaces) as interface_id; " +
      "if the id begins with '*' it is matched by .id, otherwise by interface name. " +
      "Returns the updated entry detail on success.",
    inputSchema: {
      unset: unsetProperties,
      interface_id: z.string().describe("Interface name (e.g. 'ether1') or RouterOS '.id'"),
      queue: z.string().describe("Queue-type name to apply to the interface"),
    },
    async handler(a, ctx) {
      ctx.info(`Updating queue interface: interface_id=${a.interface_id}`);
      const selector = a.interface_id.startsWith("*")
        ? `.id=${quoted(a.interface_id)}`
        : `interface=${quoted(a.interface_id)}`;
      const cmd = new Cmd(`/queue interface set [find ${selector}]`)
        .set("queue", a.queue)
        .unset(a.unset)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update queue interface: ${result}`;

      const details = await executeMikrotikCommand(
        `/queue interface print detail where ${selector}`,
        ctx,
      );
      return `Queue interface updated successfully:\n\n${details}`;
    },
  }),
];
