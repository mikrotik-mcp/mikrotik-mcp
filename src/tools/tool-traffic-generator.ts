/**
 * Traffic generator — `/tool traffic-generator`.
 *
 * Covers ports and streams plus run control (start/stop). Packet-templates and
 * the interactive `monitor`/`quick` live stats are intentionally not wrapped:
 * templates need full per-header definitions and the live stats stream
 * continuously, neither of which suits a one-shot tool call.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const trafficGeneratorTools: ToolModule = [
  // ── Ports ───────────────────────────────────────────────────────────────────
  defineTool({
    name: "add_traffic_generator_port",
    title: "Add Traffic Generator Port",
    annotations: WRITE,
    description:
      "Adds a traffic-generator port (`/tool traffic-generator port add`), binding a logical " +
      "name to a physical interface — required before any stream can reference that interface. " +
      "For listing existing ports use list_traffic_generator_ports; for defining what to " +
      "transmit on a port use add_traffic_generator_stream. " +
      "Returns the newly created port's detail.",
    inputSchema: {
      name: z.string(),
      interface: z.string(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding traffic-generator port: name=${a.name}`);
      const cmd = new Cmd("/tool traffic-generator port add")
        .set("name", a.name)
        .set("interface", a.interface)
        .flag("disabled", a.disabled)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add traffic-generator port: ${result}`;
      const details = await executeMikrotikCommand(
        `/tool traffic-generator port print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `Traffic-generator port added successfully:\n\n${details}`
        : "Traffic-generator port addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_traffic_generator_ports",
    title: "List Traffic Generator Ports",
    annotations: READ,
    description:
      "Lists traffic-generator port entries (`/tool traffic-generator port print`) — returns " +
      "the name-to-interface bindings that streams reference. Optionally filter by name " +
      "substring (name_filter). For stream definitions use list_traffic_generator_streams.",
    inputSchema: {
      name_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing traffic-generator ports");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      const result = await executeMikrotikCommand(
        `/tool traffic-generator port print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No traffic-generator ports found matching the criteria."
        : `TRAFFIC GENERATOR PORTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_traffic_generator_port",
    title: "Remove Traffic Generator Port",
    annotations: DESTRUCTIVE,
    description:
      "Removes a traffic-generator port (`/tool traffic-generator port remove`) — destroys " +
      "the interface binding, which also invalidates any streams referencing it. Accepts the " +
      "port name or RouterOS `.id` (e.g. `*1`) from list_traffic_generator_ports. Verifies " +
      "existence before attempting removal. For removing streams use remove_traffic_generator_stream.",
    inputSchema: {
      port_id: z.string().describe("Port name or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing traffic-generator port: port_id=${a.port_id}`);
      const selector = a.port_id.startsWith("*")
        ? `.id=${quoted(a.port_id)}`
        : `name=${quoted(a.port_id)}`;
      const count = await executeMikrotikCommand(
        `/tool traffic-generator port print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() === "0") return `Traffic-generator port '${a.port_id}' not found.`;
      const result = await executeMikrotikCommand(
        `/tool traffic-generator port remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove traffic-generator port: ${result}`;
      return `Traffic-generator port '${a.port_id}' removed successfully.`;
    },
  }),

  // ── Streams ─────────────────────────────────────────────────────────────────
  defineTool({
    name: "add_traffic_generator_stream",
    title: "Add Traffic Generator Stream",
    annotations: WRITE,
    description:
      "Adds a traffic-generator stream (`/tool traffic-generator stream add`) — defines what " +
      "to transmit on a named port: packet template (name of an existing packet-template to " +
      "send), packet size or range, and transmit rate in bits/second. The referenced port must " +
      "already exist (use add_traffic_generator_port). For listing streams use " +
      "list_traffic_generator_streams; to begin transmission use start_traffic_generator. " +
      "Returns the created stream's detail.",
    inputSchema: {
      name: z.string(),
      port: z.string().describe("Traffic-generator port name"),
      tx_template: z.string().optional().describe("Packet-template name to transmit"),
      packet_size: z.string().optional().describe("Packet size or range"),
      tx_rate: z.string().optional().describe("Transmit rate in bits/second"),
      num: z.number().int().min(0).max(15).optional().describe("Stream number (0-15)"),
      pps: z.number().int().optional().describe("Target throughput in packets per second"),
      mbps: z.number().int().optional().describe("Target throughput in megabits per second"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding traffic-generator stream: name=${a.name}`);
      const cmd = new Cmd("/tool traffic-generator stream add")
        .set("name", a.name)
        .set("port", a.port)
        .opt("tx-template", a.tx_template)
        .opt("packet-size", a.packet_size)
        .opt("tx-rate", a.tx_rate)
        .opt("num", a.num)
        .opt("pps", a.pps)
        .opt("mbps", a.mbps)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to add traffic-generator stream: ${result}`;
      const details = await executeMikrotikCommand(
        `/tool traffic-generator stream print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `Traffic-generator stream added successfully:\n\n${details}`
        : "Traffic-generator stream addition completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_traffic_generator_streams",
    title: "List Traffic Generator Streams",
    annotations: READ,
    description:
      "Lists traffic-generator stream definitions (`/tool traffic-generator stream print`) — " +
      "shows name, port binding, packet template, packet size, and transmit rate for each " +
      "configured stream. Optionally filter by name substring (name_filter) or exact port name " +
      "(port_filter). For port bindings use list_traffic_generator_ports.",
    inputSchema: {
      name_filter: z.string().optional(),
      port_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing traffic-generator streams");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.port_filter) filters.push(`port=${quoted(a.port_filter)}`);
      const result = await executeMikrotikCommand(
        `/tool traffic-generator stream print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No traffic-generator streams found matching the criteria."
        : `TRAFFIC GENERATOR STREAMS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_traffic_generator_stream",
    title: "Remove Traffic Generator Stream",
    annotations: DESTRUCTIVE,
    description:
      "Removes a traffic-generator stream (`/tool traffic-generator stream remove`) — deletes " +
      "the transmit definition without affecting the port it referenced. Accepts the stream name " +
      "or RouterOS `.id` (e.g. `*1`) from list_traffic_generator_streams. Verifies existence " +
      "before removal. For removing the port binding use remove_traffic_generator_port.",
    inputSchema: {
      stream_id: z.string().describe("Stream name or RouterOS '.id'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing traffic-generator stream: stream_id=${a.stream_id}`);
      const selector = a.stream_id.startsWith("*")
        ? `.id=${quoted(a.stream_id)}`
        : `name=${quoted(a.stream_id)}`;
      const count = await executeMikrotikCommand(
        `/tool traffic-generator stream print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() === "0") return `Traffic-generator stream '${a.stream_id}' not found.`;
      const result = await executeMikrotikCommand(
        `/tool traffic-generator stream remove [find ${selector}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove traffic-generator stream: ${result}`;
      return `Traffic-generator stream '${a.stream_id}' removed successfully.`;
    },
  }),

  // ── Run control ─────────────────────────────────────────────────────────────
  defineTool({
    name: "start_traffic_generator",
    title: "Start Traffic Generator",
    annotations: WRITE,
    description:
      "Starts the traffic generator (`/tool traffic-generator start`) — begins transmitting " +
      "packets for all enabled streams on their configured ports. Accepts an optional duration " +
      "in seconds; omit to run until explicitly halted with stop_traffic_generator. Requires " +
      "ports (add_traffic_generator_port) and streams (add_traffic_generator_stream) to be " +
      "configured first.",
    inputSchema: {
      duration: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional run duration in seconds (else runs until stopped)"),
    },
    async handler(a, ctx) {
      ctx.info("Starting traffic generator");
      const cmd = new Cmd("/tool traffic-generator start")
        .opt("duration", a.duration ? `${a.duration}s` : undefined)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to start traffic generator: ${result}`;
      return "Traffic generator started.";
    },
  }),

  defineTool({
    name: "stop_traffic_generator",
    title: "Stop Traffic Generator",
    annotations: WRITE,
    description:
      "Stops a running traffic generator (`/tool traffic-generator stop`) — halts all active " +
      "stream transmission immediately. Use when a timed run (start_traffic_generator with " +
      "duration) needs to be aborted early, or when the generator was started without a " +
      "duration limit.",
    async handler(_a, ctx) {
      ctx.info("Stopping traffic generator");
      const result = await executeMikrotikCommand("/tool traffic-generator stop", ctx);
      if (looksLikeError(result)) return `Failed to stop traffic generator: ${result}`;
      return "Traffic generator stopped.";
    },
  }),
];
