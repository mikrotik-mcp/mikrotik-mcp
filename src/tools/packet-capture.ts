/**
 * Packet Capture Studio — drive RouterOS `/tool sniffer` (TZSP streaming) and
 * `action=sniff-tzsp` mangle mirrors, received and decoded on this host.
 *
 * `start_packet_capture` opens the host-side TZSP receiver and points the device
 * at it; the live packets are decoded in `src/observability/capture.ts` and
 * shown in the dashboard's Packet Capture panel (or read back with
 * `packet_capture_status` when running headless). `mirror_traffic_to_capture`
 * adds a surgical per-flow mirror; `stop_packet_capture` tears it all down.
 *
 * The receiver runs in this process, which is the same process as the dashboard
 * when `--dashboard` is set, so both share one capture session.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, Cmd, quoted } from "../core/routeros";
import { capture, DEFAULT_TZSP_PORT } from "../observability/capture";

const MIRROR_TAG = "mcp-capture";

export const packetCaptureTools: ToolModule = [
  defineTool({
    name: "start_packet_capture",
    title: "Start Packet Capture (TZSP Streaming)",
    annotations: WRITE,
    description:
      "Opens a host-side TZSP receiver and configures the device's `/tool sniffer` (`/tool sniffer set` + `/tool sniffer start`) " +
      "to stream mirrored packets to it — enables live capture of router traffic for protocol debugging or traffic inspection. " +
      "Call this before `mirror_traffic_to_capture`, which adds per-flow `/ip firewall mangle action=sniff-tzsp` rules " +
      "for surgical filtering of specific flows; `start_packet_capture` must be running first for those mirrors to deliver packets here. " +
      "`receiver_host` must be the IP this host has on a segment the device can reach (the TZSP UDP destination). " +
      "Optional `interface` sets `filter-interface`, `protocol` sets `filter-ip-protocol`, `port_filter` sets `filter-port`. " +
      "View packets live in the dashboard Packet Capture panel or poll with `packet_capture_status`. " +
      "Stop and tear down everything with `stop_packet_capture`.",
    inputSchema: {
      receiver_host: z
        .string()
        .describe("IP this host is reachable at from the device (the TZSP stream destination)."),
      port: z.number().int().min(1).max(65535).default(DEFAULT_TZSP_PORT),
      interface: z
        .string()
        .optional()
        .describe("Capture interface, or omit for all (`filter-interface`)."),
      protocol: z.string().optional().describe('Limit to an IP protocol, e.g. "tcp", "icmp".'),
      port_filter: z.string().optional().describe("Limit to a TCP/UDP port number."),
    },
    async handler(a, ctx) {
      const started = await capture.start(a.port);
      if (!started.ok) {
        return `Failed to start the host TZSP receiver on UDP ${a.port}: ${started.error ?? "bind failed"}`;
      }
      ctx.info(`TZSP receiver listening on UDP ${a.port}; configuring device sniffer`);

      const cfg = new Cmd("/tool sniffer set")
        .set("streaming-enabled", "yes")
        .set("streaming-server", `${a.receiver_host}:${a.port}`)
        // Exclude the sniffer's own TZSP stream so capturing doesn't feed back on itself.
        .set("filter-stream", "yes")
        .opt("filter-interface", a.interface)
        .opt("filter-ip-protocol", a.protocol)
        .opt("filter-port", a.port_filter)
        .build();
      const setOut = await executeMikrotikCommand(cfg, ctx);
      if (looksLikeError(setOut)) {
        capture.stop();
        return `Failed to configure the device sniffer: ${setOut}`;
      }
      const startOut = await executeMikrotikCommand("/tool sniffer start", ctx);
      if (looksLikeError(startOut)) {
        capture.stop();
        return `Failed to start the device sniffer: ${startOut}`;
      }
      return (
        `Capture started. Device is streaming TZSP to ${a.receiver_host}:${a.port}` +
        `${a.interface ? ` on ${a.interface}` : ""}${a.protocol ? ` (protocol ${a.protocol})` : ""}.\n` +
        "Open the dashboard's Packet Capture panel, or call packet_capture_status to read packets."
      );
    },
  }),

  defineTool({
    name: "mirror_traffic_to_capture",
    title: "Mirror Specific Traffic Flow to Capture",
    annotations: WRITE,
    description:
      "Adds a per-flow packet mirror (`/ip firewall mangle add action=sniff-tzsp`) that copies only " +
      "matching packets to the active TZSP capture receiver without affecting the original traffic. " +
      "Use after `start_packet_capture` to focus on a specific host, port, or protocol — `start_packet_capture` " +
      "must already be running; without it, packets have nowhere to go. For broad unfiltered capture " +
      "without per-flow selection, use only `start_packet_capture` with its built-in interface/protocol/port filters. " +
      "Accepts `chain` (forward/input/output/prerouting/postrouting, default forward), optional `src_address`, " +
      "`dst_address`, `protocol`, and `dst_port` to match the desired flow. Rules are tagged `mcp-capture` " +
      "so `stop_packet_capture` removes them all automatically. Returns confirmation of the chain and destination.",
    inputSchema: {
      receiver_host: z.string().describe("TZSP stream destination (this host's IP)."),
      port: z.number().int().min(1).max(65535).default(DEFAULT_TZSP_PORT),
      chain: z.enum(["forward", "input", "output", "prerouting", "postrouting"]).default("forward"),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      protocol: z.string().optional(),
      dst_port: z.string().optional(),
    },
    async handler(a, ctx) {
      const cmd = new Cmd("/ip firewall mangle add")
        .set("chain", a.chain)
        .set("action", "sniff-tzsp")
        .set("sniff-target", a.receiver_host)
        .set("sniff-target-port", a.port)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("protocol", a.protocol)
        .opt("dst-port", a.dst_port)
        .set("comment", MIRROR_TAG)
        .build();
      const out = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(out)) return `Failed to add the mirror rule: ${out}`;
      return `Mirror added on chain ${a.chain} → ${a.receiver_host}:${a.port}. Remove with stop_packet_capture.`;
    },
  }),

  defineTool({
    name: "packet_capture_status",
    title: "Get Packet Capture Status and Recent Packets",
    annotations: READ,
    description:
      "Reads the current state of the in-process TZSP capture receiver — whether it is running, " +
      "cumulative packet and byte totals, per-protocol breakdown, top talker IP addresses, and the " +
      "most recently decoded packets (up to `limit`, default 40, max 500) with timestamps, byte lengths, and info strings. " +
      "Does not query the device; reads only the local capture session started by `start_packet_capture`. " +
      "Works headlessly without the dashboard. " +
      "To start or stop the session use `start_packet_capture` or `stop_packet_capture`.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(40).describe("Recent packets to include."),
    },
    async handler(a) {
      const stats = capture.stats();
      const recent = capture.recent(a.limit);
      if (!stats.running && stats.packets === 0) {
        return "Packet capture is not running. Start it with start_packet_capture.";
      }
      const protocols = Object.entries(stats.protocols)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      const talkers = stats.topTalkers.map((t) => `${t.addr} (${t.count})`).join(", ");
      const lines = recent.map(
        (p) => `  ${new Date(p.ts).toLocaleTimeString()}  ${p.len}B  ${p.info}`,
      );
      const text =
        `PACKET CAPTURE — ${stats.running ? "RUNNING" : "stopped"} on UDP ${stats.port}\n` +
        `${stats.packets} packets, ${stats.bytes} bytes${protocols ? `\nProtocols: ${protocols}` : ""}` +
        `${talkers ? `\nTop talkers: ${talkers}` : ""}\n\nRecent:\n${lines.join("\n") || "  (none yet)"}`;
      return { text, structuredContent: { stats, recent } as unknown as Record<string, unknown> };
    },
  }),

  defineTool({
    name: "stop_packet_capture",
    title: "Stop Packet Capture and Remove Mirror Rules",
    annotations: DESTRUCTIVE,
    description:
      "Tears down the entire capture session: stops the device sniffer (`/tool sniffer stop`), " +
      "disables streaming (`/tool sniffer set streaming-enabled=no`), removes all per-flow mirror " +
      "rules that were added by `mirror_traffic_to_capture` " +
      '(`/ip firewall mangle remove [find action=sniff-tzsp and comment="mcp-capture"]`), ' +
      "and closes the host-side TZSP receiver. " +
      "Returns the final cumulative packet and byte totals from the session. " +
      "To inspect the session without stopping it use `packet_capture_status`.",
    async handler(_a, ctx) {
      await executeMikrotikCommand("/tool sniffer stop", ctx);
      await executeMikrotikCommand("/tool sniffer set streaming-enabled=no", ctx);
      await executeMikrotikCommand(
        `/ip firewall mangle remove [find action=sniff-tzsp and comment=${quoted(MIRROR_TAG)}]`,
        ctx,
      );
      const stats = capture.stats();
      capture.stop();
      return `Capture stopped. Collected ${stats.packets} packets (${stats.bytes} bytes); receiver closed.`;
    },
  }),
];
