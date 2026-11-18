/**
 * Queues — `/queue type`, `/queue tree`, `/queue simple`.
 *
 * Covers queue types (qdiscs), hierarchical queue trees, and simple per-target
 * rate-limit queues, each with the full create/list/get/update/remove lifecycle
 * (trees and simple queues additionally expose enable/disable).
 */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, isEmpty, Cmd, quoted, quoteValue } from "../core/routeros";

/**
 * Shared "create, then verify" flow: when RouterOS echoes a new `.id` (`*N` or a
 * bare number) re-print by id, otherwise fall back to a lookup by name
 */
async function verifyCreate(
  result: string,
  path: string,
  name: string,
  label: string,
  ctx: ToolContext,
): Promise<string> {
  if (result.trim()) {
    if (result.includes("*") || /^\d+$/.test(result.trim())) {
      const id = result.trim();
      const details = await executeMikrotikCommand(`${path} print detail where .id=${id}`, ctx);
      if (details.trim()) return `${label} created successfully:\n\n${details}`;
      return `${label} created with ID: ${id}`;
    }
    if (looksLikeError(result)) return `Failed to create ${label.toLowerCase()}: ${result}`;
  }
  const details = await executeMikrotikCommand(
    `${path} print detail where name=${quoted(name)}`,
    ctx,
  );
  if (details.trim()) return `${label} created successfully:\n\n${details}`;
  return `${label} creation completed but unable to verify.`;
}

const QueueKind = z.enum([
  "cake",
  "fq-codel",
  "sfq",
  "red",
  "pcq",
  "pfifo",
  "bfifo",
  "pfifo-bpf",
  "mq-pfifo",
  "none",
]);
const CakeFlowmode = z.enum([
  "triple-isolate",
  "dual-srchost",
  "dual-dsthost",
  "host",
  "flow",
  "none",
]);
const CakeDiffserv = z.enum(["besteffort", "diffserv3", "diffserv4", "diffserv8"]);
const CakeAckFilter = z.enum(["filter", "aggressive", "none"]);

export const queueTools: ToolModule = [
  // ── Queue Types ───────────────────────────────────────────────
  defineTool({
    name: "create_queue_type",
    title: "Create Queue Type (Qdisc)",
    annotations: WRITE,
    description:
      "Creates a named queue discipline (`/queue type`) — the algorithm (cake, fq-codel, sfq, red, pcq, pfifo, bfifo, pfifo-bpf, mq-pfifo, none) that controls how packets within a queue are scheduled and dropped. Queue types are referenced by name in `create_queue_tree` and `create_simple_queue` via their `queue` parameter. `kind` selects the discipline; remaining params are per-discipline options (e.g. cake_flowmode, cake_nat, pcq_rate, pcq_classifier, fq_codel_target). For hierarchical bandwidth shaping use `create_queue_tree`; for flat per-target rate limiting use `create_simple_queue`. Returns details of the created queue type.",
    inputSchema: {
      name: z.string(),
      kind: QueueKind.default("cake"),
      cake_flowmode: CakeFlowmode.optional(),
      cake_nat: z.boolean().optional(),
      cake_overhead: z.number().int().optional(),
      cake_mpu: z.number().int().optional(),
      cake_diffserv: CakeDiffserv.optional(),
      cake_ack_filter: CakeAckFilter.optional(),
      cake_rtt: z.string().optional().describe('Round-trip time e.g. "50ms", "100ms"'),
      cake_wash: z.boolean().optional(),
      cake_overhead_scheme: z.string().optional(),
      cake_bandwidth: z
        .string()
        .optional()
        .describe('CAKE shaper bandwidth e.g. "100M", "0" for unlimited'),
      cake_atm: z
        .enum(["none", "atm", "ptm"])
        .optional()
        .describe("Link-layer ATM/PTM compensation"),
      cake_autorate_ingress: z.boolean().optional().describe("Automatic ingress rate estimation"),
      cake_memlimit: z.string().optional().describe("Override CAKE buffer memory limit"),
      pcq_rate: z.string().optional().describe('Bandwidth per flow e.g. "1M", "512k"'),
      pcq_limit: z.number().int().optional(),
      pcq_classifier: z
        .string()
        .optional()
        .describe('Comma-separated classifiers e.g. "src-address,dst-address"'),
      pcq_total_limit: z
        .number()
        .int()
        .optional()
        .describe("Total packet limit across all PCQ sub-queues"),
      pcq_burst_rate: z.string().optional().describe('PCQ burst rate e.g. "1M"'),
      pcq_burst_threshold: z.string().optional().describe('PCQ burst threshold e.g. "512k"'),
      pcq_burst_time: z.string().optional().describe('PCQ burst time e.g. "10s"'),
      pcq_src_address_mask: z
        .number()
        .int()
        .optional()
        .describe("IPv4 src classifier mask bits (0-32)"),
      pcq_dst_address_mask: z
        .number()
        .int()
        .optional()
        .describe("IPv4 dst classifier mask bits (0-32)"),
      pcq_src_address6_mask: z
        .number()
        .int()
        .optional()
        .describe("IPv6 src classifier mask bits (0-128)"),
      pcq_dst_address6_mask: z
        .number()
        .int()
        .optional()
        .describe("IPv6 dst classifier mask bits (0-128)"),
      pfifo_limit: z.number().int().optional(),
      bfifo_limit: z.number().int().optional(),
      sfq_perturb: z.number().int().optional(),
      sfq_allot: z.number().int().optional(),
      fq_codel_limit: z.number().int().optional(),
      fq_codel_quantum: z.number().int().optional(),
      fq_codel_target: z.string().optional().describe('Time e.g. "5ms", "100ms"'),
      fq_codel_interval: z.string().optional().describe('Time e.g. "5ms", "100ms"'),
      red_limit: z.number().int().optional(),
      red_min_threshold: z.number().int().optional(),
      red_max_threshold: z.number().int().optional(),
      red_burst: z.number().int().optional(),
      red_avg_packet: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Creating queue type: name=${a.name}, kind=${a.kind}`);
      const cmd = new Cmd("/queue type add")
        .set("name", a.name)
        .set("kind", a.kind)
        // CAKE parameters
        .opt("cake-flowmode", a.cake_flowmode)
        .bool("cake-nat", a.cake_nat)
        .opt("cake-overhead", a.cake_overhead)
        .opt("cake-mpu", a.cake_mpu)
        .opt("cake-diffserv", a.cake_diffserv)
        .opt("cake-ack-filter", a.cake_ack_filter)
        .opt("cake-rtt", a.cake_rtt)
        .bool("cake-wash", a.cake_wash)
        .opt("cake-overhead-scheme", a.cake_overhead_scheme)
        .opt("cake-bandwidth", a.cake_bandwidth)
        .opt("cake-atm", a.cake_atm)
        .bool("cake-autorate-ingress", a.cake_autorate_ingress)
        .opt("cake-memlimit", a.cake_memlimit)
        // PCQ parameters
        .opt("pcq-rate", a.pcq_rate)
        .opt("pcq-limit", a.pcq_limit)
        .opt("pcq-classifier", a.pcq_classifier)
        .opt("pcq-total-limit", a.pcq_total_limit)
        .opt("pcq-burst-rate", a.pcq_burst_rate)
        .opt("pcq-burst-threshold", a.pcq_burst_threshold)
        .opt("pcq-burst-time", a.pcq_burst_time)
        .opt("pcq-src-address-mask", a.pcq_src_address_mask)
        .opt("pcq-dst-address-mask", a.pcq_dst_address_mask)
        .opt("pcq-src-address6-mask", a.pcq_src_address6_mask)
        .opt("pcq-dst-address6-mask", a.pcq_dst_address6_mask)
        // PFIFO/BFIFO parameters
        .opt("pfifo-limit", a.pfifo_limit)
        .opt("bfifo-limit", a.bfifo_limit)
        // SFQ parameters
        .opt("sfq-perturb", a.sfq_perturb)
        .opt("sfq-allot", a.sfq_allot)
        // FQ-CoDel parameters
        .opt("fq-codel-limit", a.fq_codel_limit)
        .opt("fq-codel-quantum", a.fq_codel_quantum)
        .opt("fq-codel-target", a.fq_codel_target)
        .opt("fq-codel-interval", a.fq_codel_interval)
        // RED parameters
        .opt("red-limit", a.red_limit)
        .opt("red-min-threshold", a.red_min_threshold)
        .opt("red-max-threshold", a.red_max_threshold)
        .opt("red-burst", a.red_burst)
        .opt("red-avg-packet", a.red_avg_packet)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      return verifyCreate(result, "/queue type", a.name, "Queue type", ctx);
    },
  }),

  defineTool({
    name: "list_queue_types",
    title: "List Queue Types (Qdiscs)",
    annotations: READ,
    description:
      "Lists all queue disciplines (`/queue type print`) configured on the device. Use `name_filter` (substring match) or `kind_filter` (exact kind) to narrow results. Returns all built-in and custom queue type entries. Use `get_queue_type` for full detail on a single entry. To list scheduling hierarchies use `list_queue_trees`; to list per-target rate limits use `list_simple_queues`.",
    inputSchema: {
      name_filter: z.string().optional(),
      kind_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing queue types");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.kind_filter) filters.push(`kind=${quoteValue(a.kind_filter)}`);

      let cmd = "/queue type print";
      if (filters.length) cmd += ` where ${filters.join(" ")}`;

      const result = await executeMikrotikCommand(cmd, ctx);
      return isEmpty(result)
        ? "No queue types found matching the criteria."
        : `QUEUE TYPES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_queue_type",
    title: "Get Queue Type Detail",
    annotations: READ,
    description:
      "Retrieves full detail for a single queue discipline (`/queue type print detail where name=...`). Resolves the `name` referenced in `create_queue_tree` or `create_simple_queue` via the `queue` field. Returns all parameters of that type, or a not-found message. Use `list_queue_types` to discover available names.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting queue type details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue type print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Queue type '${a.name}' not found.`
        : `QUEUE TYPE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_queue_type",
    title: "Update Queue Type Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing queue discipline (`/queue type set [find name=...]`). Supports renaming (`new_name`) and changing CAKE- or PCQ-specific parameters (cake_flowmode, cake_nat, cake_overhead, pcq_rate, pcq_classifier, etc.). Does not change the queue `kind` — to switch algorithm, remove and recreate the type with `remove_queue_type` then `create_queue_type`. Returns updated detail; if no parameters are provided returns 'No updates specified.' Use `get_queue_type` to confirm current values first.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string(),
      new_name: z.string().optional(),
      cake_flowmode: z.string().optional(),
      cake_nat: z.boolean().optional(),
      cake_overhead: z.number().int().optional(),
      cake_mpu: z.number().int().optional(),
      cake_diffserv: z.string().optional(),
      cake_ack_filter: z.string().optional(),
      cake_rtt: z.string().optional(),
      cake_wash: z.boolean().optional(),
      cake_overhead_scheme: z.string().optional(),
      cake_bandwidth: z.string().optional(),
      cake_atm: z.string().optional(),
      cake_autorate_ingress: z.boolean().optional(),
      cake_memlimit: z.string().optional(),
      pcq_rate: z.string().optional(),
      pcq_limit: z.number().int().optional(),
      pcq_classifier: z.string().optional(),
      pcq_total_limit: z.number().int().optional(),
      pcq_burst_rate: z.string().optional(),
      pcq_burst_threshold: z.string().optional(),
      pcq_burst_time: z.string().optional(),
      pcq_src_address_mask: z.number().int().optional(),
      pcq_dst_address_mask: z.number().int().optional(),
      pcq_src_address6_mask: z.number().int().optional(),
      pcq_dst_address6_mask: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating queue type: name=${a.name}`);
      const cmd = new Cmd(`/queue type set [find name=${quoted(a.name)}]`)
        .opt("name", a.new_name)
        .opt("cake-flowmode", a.cake_flowmode)
        .bool("cake-nat", a.cake_nat)
        .opt("cake-overhead", a.cake_overhead)
        .opt("cake-mpu", a.cake_mpu)
        .opt("cake-diffserv", a.cake_diffserv)
        .opt("cake-ack-filter", a.cake_ack_filter)
        .opt("cake-rtt", a.cake_rtt)
        .bool("cake-wash", a.cake_wash)
        .opt("cake-overhead-scheme", a.cake_overhead_scheme)
        .opt("cake-bandwidth", a.cake_bandwidth)
        .opt("cake-atm", a.cake_atm)
        .bool("cake-autorate-ingress", a.cake_autorate_ingress)
        .opt("cake-memlimit", a.cake_memlimit)
        .opt("pcq-rate", a.pcq_rate)
        .opt("pcq-limit", a.pcq_limit)
        .opt("pcq-classifier", a.pcq_classifier)
        .opt("pcq-total-limit", a.pcq_total_limit)
        .opt("pcq-burst-rate", a.pcq_burst_rate)
        .opt("pcq-burst-threshold", a.pcq_burst_threshold)
        .opt("pcq-burst-time", a.pcq_burst_time)
        .opt("pcq-src-address-mask", a.pcq_src_address_mask)
        .opt("pcq-dst-address-mask", a.pcq_dst_address_mask)
        .opt("pcq-src-address6-mask", a.pcq_src_address6_mask)
        .opt("pcq-dst-address6-mask", a.pcq_dst_address6_mask)
        .unset(a.unset)
        .build();

      if (!/[=!]/.test(cmd.slice(cmd.indexOf("]")))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update queue type: ${result}`;

      const lookupName = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/queue type print detail where name=${quoted(lookupName)}`,
        ctx,
      );
      return `Queue type updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_queue_type",
    title: "Remove Queue Type",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a named queue discipline (`/queue type remove [find name=...]`). Will fail if the type is still referenced by an active queue tree or simple queue — remove those references first. Built-in types (e.g. 'default', 'default-small') cannot be removed. Returns a success or error message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing queue type: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue type remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove queue type: ${result}`;
      return `Queue type '${a.name}' removed successfully.`;
    },
  }),

  // ── Queue Trees ───────────────────────────────────────────────
  defineTool({
    name: "create_queue_tree",
    title: "Create Queue Tree Entry",
    annotations: WRITE,
    description:
      "Creates a hierarchical bandwidth-shaping node (`/queue tree add`) attached to a `parent` interface or another queue tree entry — the HTB-style tree for multi-level QoS. Use this when you need nested queues with shared bandwidth pools and packet-mark-based classification (marks produced by mangle tools). `max_limit` caps peak throughput (e.g. '10M', '512k', '1G'); `limit_at` guarantees minimum bandwidth; `priority` sets preemption order (1 highest, 8 lowest); `queue` names the qdisc from `create_queue_type`. For flat per-IP/CIDR rate limiting without a hierarchy use `create_simple_queue` instead. Returns the created entry's detail.",
    inputSchema: {
      name: z.string(),
      parent: z.string().describe('Interface name e.g. "ether1" or parent queue name'),
      queue: z.string().optional(),
      packet_mark: z.string().optional(),
      max_limit: z.string().optional().describe('Bandwidth e.g. "10M", "512k", "1G"'),
      limit_at: z.string().optional().describe('Bandwidth e.g. "10M", "512k", "1G"'),
      burst_limit: z.string().optional().describe('Bandwidth e.g. "10M", "512k", "1G"'),
      burst_threshold: z.string().optional().describe('Bandwidth e.g. "10M", "512k", "1G"'),
      burst_time: z.string().optional().describe('Duration e.g. "8s"'),
      bucket_size: z.string().optional(),
      priority: z.number().int().optional().describe("1 (highest) – 8 (lowest)"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating queue tree: name=${a.name}, parent=${a.parent}`);
      const cmd = new Cmd("/queue tree add")
        .set("name", a.name)
        .set("parent", a.parent)
        .opt("queue", a.queue)
        .opt("packet-mark", a.packet_mark)
        .opt("max-limit", a.max_limit)
        .opt("limit-at", a.limit_at)
        .opt("burst-limit", a.burst_limit)
        .opt("burst-threshold", a.burst_threshold)
        .opt("burst-time", a.burst_time)
        .opt("bucket-size", a.bucket_size)
        .opt("priority", a.priority)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      return verifyCreate(result, "/queue tree", a.name, "Queue tree", ctx);
    },
  }),

  defineTool({
    name: "list_queue_trees",
    title: "List Queue Tree Entries",
    annotations: READ,
    description:
      "Lists all hierarchical queue tree nodes (`/queue tree print`) on the device. Supports filtering by `name_filter` (substring match), `parent_filter` (exact interface or parent queue name), `disabled_only`, and `invalid_only`. Returns the shaping hierarchy; use `get_queue_tree` for full detail on one node. For flat per-target rate-limiting queues use `list_simple_queues`.",
    inputSchema: {
      name_filter: z.string().optional(),
      parent_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing queue trees");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.parent_filter) filters.push(`parent=${quoted(a.parent_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");

      let cmd = "/queue tree print";
      if (filters.length) cmd += ` where ${filters.join(" ")}`;

      const result = await executeMikrotikCommand(cmd, ctx);
      return isEmpty(result)
        ? "No queue trees found matching the criteria."
        : `QUEUE TREES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_queue_tree",
    title: "Get Queue Tree Entry Detail",
    annotations: READ,
    description:
      "Retrieves full detail for a single queue tree node (`/queue tree print detail where name=...`). Returns all attributes including bandwidth limits, parent, packet-mark, priority, qdisc reference, and enabled state, or a not-found message. Use `list_queue_trees` to discover names and `update_queue_tree` to modify. For simple per-target queues use `get_simple_queue`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting queue tree details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue tree print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Queue tree '${a.name}' not found.`
        : `QUEUE TREE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_queue_tree",
    title: "Update Queue Tree Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing queue tree node (`/queue tree set [find name=...]`). Accepts `new_name`, `parent`, `queue` (qdisc reference from `create_queue_type`), `packet_mark`, bandwidth params (`max_limit`, `limit_at`, `burst_limit`, `burst_threshold` as RouterOS rate strings e.g. '10M', '512k', '1G'; `burst_time` e.g. '8s'), `priority` (1 highest – 8 lowest), `comment`, and `disabled`. Returns updated detail; if no parameters are specified returns 'No updates specified.' Use `get_queue_tree` to confirm current state before updating. For simple per-target queues use `update_simple_queue`.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string(),
      new_name: z.string().optional(),
      parent: z.string().optional(),
      queue: z.string().optional(),
      packet_mark: z.string().optional(),
      max_limit: z.string().optional().describe('Bandwidth e.g. "10M", "512k"'),
      limit_at: z.string().optional().describe('Bandwidth e.g. "10M", "512k"'),
      burst_limit: z.string().optional().describe('Bandwidth e.g. "10M", "512k"'),
      burst_threshold: z.string().optional().describe('Bandwidth e.g. "10M", "512k"'),
      burst_time: z.string().optional().describe('Duration e.g. "8s"'),
      bucket_size: z.string().optional(),
      priority: z.number().int().optional().describe("1 (highest) – 8 (lowest)"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating queue tree: name=${a.name}`);
      const cmd = new Cmd(`/queue tree set [find name=${quoted(a.name)}]`)
        .opt("name", a.new_name)
        .opt("parent", a.parent)
        .opt("queue", a.queue)
        .opt("packet-mark", a.packet_mark)
        .opt("max-limit", a.max_limit)
        .opt("limit-at", a.limit_at)
        .opt("burst-limit", a.burst_limit)
        .opt("burst-threshold", a.burst_threshold)
        .opt("burst-time", a.burst_time)
        .opt("bucket-size", a.bucket_size)
        .opt("priority", a.priority)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .unset(a.unset)
        .build();

      if (!/[=!]/.test(cmd.slice(cmd.indexOf("]")))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update queue tree: ${result}`;

      const lookupName = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/queue tree print detail where name=${quoted(lookupName)}`,
        ctx,
      );
      return `Queue tree updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_queue_tree",
    title: "Remove Queue Tree Entry",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a queue tree node (`/queue tree remove [find name=...]`). Child nodes that reference this entry as their `parent` will become invalid — remove or reparent them first. Returns a success or error message. Use `list_queue_trees` to identify the name. For simple per-target queues use `remove_simple_queue`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing queue tree: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue tree remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove queue tree: ${result}`;
      return `Queue tree '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_queue_tree",
    title: "Enable Queue Tree Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-activates a disabled queue tree node (`/queue tree set [find name=...] disabled=no`). Restores the node's bandwidth-shaping rules in the hierarchy without modifying any other parameters. Returns the updated detail. To deactivate use `disable_queue_tree`. For simple per-target queues use `enable_simple_queue`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling queue tree: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue tree set [find name=${quoted(a.name)}] disabled=no`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable queue tree: ${result}`;

      const details = await executeMikrotikCommand(
        `/queue tree print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `Queue tree enabled:\n\n${details}`;
    },
  }),

  defineTool({
    name: "disable_queue_tree",
    title: "Disable Queue Tree Entry",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Deactivates a queue tree node without removing it (`/queue tree set [find name=...] disabled=yes`). Suspends that node's bandwidth constraints while preserving its configuration; re-activate with `enable_queue_tree`. Returns the updated detail. For simple per-target queues use `disable_simple_queue`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling queue tree: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue tree set [find name=${quoted(a.name)}] disabled=yes`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable queue tree: ${result}`;

      const details = await executeMikrotikCommand(
        `/queue tree print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `Queue tree disabled:\n\n${details}`;
    },
  }),

  // ── Simple Queues ─────────────────────────────────────────────
  defineTool({
    name: "create_simple_queue",
    title: "Create Simple Queue",
    annotations: WRITE,
    description:
      "Creates a flat per-target rate-limiting entry (`/queue simple add`) that shapes traffic for a specific IP address, CIDR subnet, or interface — the quickest way to cap upload/download bandwidth without building a queue tree hierarchy. `target` is the IP/CIDR or interface (e.g. '192.168.1.0/24', 'ether1'); `max_limit` caps bandwidth as 'UL/DL' or a single value (e.g. '10M/10M', '5M'); `limit_at` guarantees minimum bandwidth; `burst_limit`, `burst_threshold`, `burst_time` (e.g. '8s') allow short-term speed above `max_limit`; `queue` names the qdisc from `create_queue_type`. For packet-mark-based multi-level shaping use `create_queue_tree` instead. Returns the created entry's detail.",
    inputSchema: {
      name: z.string(),
      target: z.string().describe('IP/CIDR or interface e.g. "192.168.1.0/24" or "ether1"'),
      dst: z.string().optional(),
      max_limit: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      limit_at: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      burst_limit: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      burst_threshold: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      burst_time: z.string().optional().describe('Duration e.g. "8s"'),
      bucket_size: z.string().optional(),
      queue: z.string().optional(),
      parent: z.string().optional(),
      priority: z.string().optional().describe("1 (highest) – 8 (lowest)"),
      packet_marks: z.string().optional(),
      time: z
        .string()
        .optional()
        .describe('Active time/days e.g. "0s-1d,sun,mon,tue,wed,thu,fri,sat"'),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating simple queue: name=${a.name}, target=${a.target}`);
      const cmd = new Cmd("/queue simple add")
        .set("name", a.name)
        .set("target", a.target)
        .opt("dst", a.dst)
        .opt("max-limit", a.max_limit)
        .opt("limit-at", a.limit_at)
        .opt("burst-limit", a.burst_limit)
        .opt("burst-threshold", a.burst_threshold)
        .opt("burst-time", a.burst_time)
        .opt("bucket-size", a.bucket_size)
        .opt("queue", a.queue)
        .opt("parent", a.parent)
        .opt("priority", a.priority)
        .opt("packet-marks", a.packet_marks)
        .opt("time", a.time)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      return verifyCreate(result, "/queue simple", a.name, "Simple queue", ctx);
    },
  }),

  defineTool({
    name: "list_simple_queues",
    title: "List Simple Queues",
    annotations: READ,
    description:
      "Lists all per-target rate-limiting entries (`/queue simple print`) on the device. Supports filtering by `name_filter` (substring match), `target_filter` (substring match on IP/interface), `disabled_only`, and `invalid_only`. Returns all matching simple queue entries. Use `get_simple_queue` for full detail on a single entry. For the hierarchical shaping tree use `list_queue_trees`.",
    inputSchema: {
      name_filter: z.string().optional(),
      target_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing simple queues");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.target_filter) filters.push(`target~${quoted(a.target_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");

      let cmd = "/queue simple print";
      if (filters.length) cmd += ` where ${filters.join(" ")}`;

      const result = await executeMikrotikCommand(cmd, ctx);
      return isEmpty(result)
        ? "No simple queues found matching the criteria."
        : `SIMPLE QUEUES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_simple_queue",
    title: "Get Simple Queue Detail",
    annotations: READ,
    description:
      "Retrieves full detail for a single simple queue entry (`/queue simple print detail where name=...`). Returns target, bandwidth limits, burst parameters, qdisc reference, and enabled state, or a not-found message. Use `list_simple_queues` to discover names. For hierarchical queue nodes use `get_queue_tree`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting simple queue details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue simple print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Simple queue '${a.name}' not found.`
        : `SIMPLE QUEUE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_simple_queue",
    title: "Update Simple Queue",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing per-target rate-limiting entry (`/queue simple set [find name=...]`). Accepts `new_name`, `target` (IP/CIDR or interface e.g. '192.168.1.0/24', 'ether1'), `dst`, bandwidth params (`max_limit`, `limit_at`, `burst_limit`, `burst_threshold` as 'UL/DL' or single value e.g. '10M/10M', '5M'; `burst_time` e.g. '8s'), `queue` (qdisc reference), `parent`, `priority` (1 highest – 8 lowest), `packet_marks`, `comment`, and `disabled`. Returns updated detail; if no parameters are provided returns 'No updates specified.' Use `get_simple_queue` to confirm current state first. For hierarchical queue nodes use `update_queue_tree`.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string(),
      new_name: z.string().optional(),
      target: z
        .string()
        .optional()
        .describe('IP/CIDR or interface e.g. "192.168.1.0/24" or "ether1"'),
      dst: z.string().optional(),
      max_limit: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      limit_at: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      burst_limit: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      burst_threshold: z
        .string()
        .optional()
        .describe(
          'Upload/download bandwidth as "UL/DL" e.g. "10M/10M", or single value e.g. "10M"',
        ),
      burst_time: z.string().optional().describe('Duration e.g. "8s"'),
      bucket_size: z.string().optional(),
      queue: z.string().optional(),
      parent: z.string().optional(),
      priority: z.string().optional().describe("1 (highest) – 8 (lowest)"),
      packet_marks: z.string().optional(),
      time: z
        .string()
        .optional()
        .describe('Active time/days e.g. "0s-1d,sun,mon,tue,wed,thu,fri,sat"'),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating simple queue: name=${a.name}`);
      const cmd = new Cmd(`/queue simple set [find name=${quoted(a.name)}]`)
        .opt("name", a.new_name)
        .opt("target", a.target)
        .opt("dst", a.dst)
        .opt("max-limit", a.max_limit)
        .opt("limit-at", a.limit_at)
        .opt("burst-limit", a.burst_limit)
        .opt("burst-threshold", a.burst_threshold)
        .opt("burst-time", a.burst_time)
        .opt("bucket-size", a.bucket_size)
        .opt("queue", a.queue)
        .opt("parent", a.parent)
        .opt("priority", a.priority)
        .opt("packet-marks", a.packet_marks)
        .opt("time", a.time)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .unset(a.unset)
        .build();

      if (!/[=!]/.test(cmd.slice(cmd.indexOf("]")))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update simple queue: ${result}`;

      const lookupName = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/queue simple print detail where name=${quoted(lookupName)}`,
        ctx,
      );
      return `Simple queue updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_simple_queue",
    title: "Remove Simple Queue",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a simple queue entry (`/queue simple remove [find name=...]`). Removes the per-target rate limit for that IP/CIDR or interface. Returns a success or error message. Use `list_simple_queues` to identify the name. For hierarchical queue nodes use `remove_queue_tree`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing simple queue: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue simple remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove simple queue: ${result}`;
      return `Simple queue '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_simple_queue",
    title: "Enable Simple Queue",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-activates a disabled simple queue entry (`/queue simple set [find name=...] disabled=no`). Restores the per-target bandwidth shaping without altering any other parameters. Returns the updated detail. To deactivate use `disable_simple_queue`. For hierarchical queue nodes use `enable_queue_tree`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Enabling simple queue: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue simple set [find name=${quoted(a.name)}] disabled=no`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to enable simple queue: ${result}`;

      const details = await executeMikrotikCommand(
        `/queue simple print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `Simple queue enabled:\n\n${details}`;
    },
  }),

  defineTool({
    name: "disable_simple_queue",
    title: "Disable Simple Queue",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Deactivates a simple queue entry without removing it (`/queue simple set [find name=...] disabled=yes`). Suspends the per-target rate limit while preserving its configuration; re-activate with `enable_simple_queue`. Returns the updated detail. For hierarchical queue nodes use `disable_queue_tree`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disabling simple queue: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/queue simple set [find name=${quoted(a.name)}] disabled=yes`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to disable simple queue: ${result}`;

      const details = await executeMikrotikCommand(
        `/queue simple print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `Simple queue disabled:\n\n${details}`;
    },
  }),
];
