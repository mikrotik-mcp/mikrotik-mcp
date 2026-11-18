/** Packet sniffer — `/tool sniffer`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const snifferTools: ToolModule = [
  defineTool({
    name: "get_sniffer_settings",
    title: "Get Packet Sniffer Settings",
    annotations: READ,
    description:
      "Reads the current packet sniffer configuration and running state (`/tool sniffer`). " +
      "Use this to inspect active filter rules (interface, IP/CIDR, port, MAC protocol), " +
      "TZSP streaming target, memory buffer limit, and file output name before starting a capture. " +
      "To change settings use update_sniffer_settings; to start or stop the sniffer use " +
      "start_sniffer / stop_sniffer. Returns the full `/tool sniffer print` output.",
    async handler(_a, ctx) {
      ctx.info("Getting sniffer settings");
      const result = await executeMikrotikCommand("/tool sniffer print", ctx);
      return isEmpty(result)
        ? "Unable to read sniffer settings."
        : `SNIFFER SETTINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_sniffer_settings",
    title: "Update Packet Sniffer Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Configures the packet sniffer (`/tool sniffer set`) — sets capture filters, TZSP streaming, " +
      "buffer size, and output file before a capture session. " +
      "Call this before start_sniffer to narrow what traffic is captured or where it is forwarded. " +
      "For reading already-captured data use list_sniffer_packets, list_sniffer_hosts, " +
      "list_sniffer_protocols, or list_sniffer_connections. " +
      "Returns the updated sniffer settings after applying.\n\n" +
      "Notes:\n" +
      "    streaming_enabled + streaming_server: forward captured packets as\n" +
      "        TZSP to a remote analyzer (e.g. Wireshark); streaming_server e.g. '192.168.88.2'.\n" +
      "    memory_limit: capture buffer size, e.g. '10M'.\n" +
      "    filter_ip_address: match IP/CIDR, e.g. '10.0.0.0/24'.\n" +
      "    only_headers: capture packet headers only (smaller buffer).\n" +
      "    file_name: file name for continuous on-disk packet output during capture (RouterOS writes\n" +
      "        packets to this file while the sniffer runs); save_sniffer takes its own independent\n" +
      "        file_name parameter and does not use this value.",
    inputSchema: {
      filter_interface: z.string().optional(),
      filter_ip_address: z.string().optional().describe("Match IP/CIDR, e.g. '10.0.0.0/24'"),
      filter_ipv6_address: z
        .string()
        .optional()
        .describe("Match IPv6/prefix, e.g. '2001:db8::/64'"),
      filter_mac_address: z.string().optional().describe("Match MAC address"),
      filter_port: z.string().optional(),
      filter_mac_protocol: z.string().optional(),
      filter_direction: z
        .enum(["any", "rx", "tx"])
        .optional()
        .describe("Capture direction: any, rx, or tx"),
      filter_operator_between_entries: z
        .enum(["and", "or"])
        .optional()
        .describe("How filter entries combine: and / or"),
      filter_stream: z.boolean().optional().describe("Capture only TZSP-streamed packets"),
      streaming_enabled: z.boolean().optional(),
      streaming_server: z.string().optional().describe("TZSP target, e.g. '192.168.88.2'"),
      memory_limit: z.string().optional().describe("Buffer size, e.g. '10M'"),
      memory_scroll: z
        .boolean()
        .optional()
        .describe("Overwrite oldest packets when buffer is full"),
      file_name: z.string().optional().describe("Capture file name (.pcap)"),
      file_limit: z.number().int().optional().describe("Max capture file size in KiB"),
      only_headers: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Updating sniffer settings");
      const cmd = new Cmd("/tool sniffer set")
        .opt("filter-interface", a.filter_interface)
        .opt("filter-ip-address", a.filter_ip_address)
        .opt("filter-ipv6-address", a.filter_ipv6_address)
        .opt("filter-mac-address", a.filter_mac_address)
        .opt("filter-port", a.filter_port)
        .opt("filter-mac-protocol", a.filter_mac_protocol)
        .opt("filter-direction", a.filter_direction)
        .opt("filter-operator-between-entries", a.filter_operator_between_entries)
        .bool("filter-stream", a.filter_stream)
        .bool("streaming-enabled", a.streaming_enabled)
        .opt("streaming-server", a.streaming_server)
        .opt("memory-limit", a.memory_limit)
        .bool("memory-scroll", a.memory_scroll)
        .opt("file-name", a.file_name)
        .opt("file-limit", a.file_limit)
        .bool("only-headers", a.only_headers);

      const built = cmd.build();
      if (built === "/tool sniffer set") return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update sniffer settings: ${result}`;
      const details = await executeMikrotikCommand("/tool sniffer print", ctx);
      return `Sniffer settings updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "start_sniffer",
    title: "Start Packet Sniffer",
    annotations: WRITE,
    description:
      "Starts the packet sniffer (`/tool sniffer start`) — begins capturing packets into the " +
      "in-memory ring buffer (and to file if file_name was set via update_sniffer_settings). " +
      "Required before list_sniffer_packets, list_sniffer_hosts, list_sniffer_protocols, or " +
      "list_sniffer_connections can return live data. Stop the capture with stop_sniffer.",
    async handler(_a, ctx) {
      ctx.info("Starting sniffer");
      const result = await executeMikrotikCommand("/tool sniffer start", ctx);
      if (looksLikeError(result)) return `Failed to start sniffer: ${result}`;
      return "Packet sniffer started.";
    },
  }),

  defineTool({
    name: "stop_sniffer",
    title: "Stop Packet Sniffer",
    annotations: WRITE,
    description:
      "Stops the packet sniffer (`/tool sniffer stop`) — halts an active capture session started " +
      "with start_sniffer. The in-memory buffer remains readable via list_sniffer_packets, " +
      "list_sniffer_hosts, list_sniffer_protocols, and list_sniffer_connections after stopping. " +
      "To save the buffer to a .pcap file on the device filesystem use save_sniffer.",
    async handler(_a, ctx) {
      ctx.info("Stopping sniffer");
      const result = await executeMikrotikCommand("/tool sniffer stop", ctx);
      if (looksLikeError(result)) return `Failed to stop sniffer: ${result}`;
      return "Packet sniffer stopped.";
    },
  }),

  defineTool({
    name: "save_sniffer",
    title: "Save Packet Sniffer Capture to File",
    annotations: WRITE,
    description:
      "Saves the current in-memory sniffer buffer to a .pcap file on the device filesystem " +
      "(`/tool sniffer save`) — use after stop_sniffer to persist a capture for later download " +
      "or off-device analysis. The file is stored on the router's local storage. " +
      "To read individual packets from the in-memory buffer without saving use list_sniffer_packets. " +
      "Requires file_name (basename without extension, e.g. 'capture').",
    inputSchema: {
      file_name: z.string().describe("Output file name, e.g. 'capture'"),
    },
    async handler(a, ctx) {
      ctx.info(`Saving sniffer capture to ${a.file_name}`);
      const result = await executeMikrotikCommand(
        `/tool sniffer save file-name=${quoted(a.file_name)}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to save sniffer capture: ${result}`;
      return `Sniffer capture saved to '${a.file_name}'.`;
    },
  }),

  defineTool({
    name: "list_sniffer_packets",
    title: "List Captured Sniffer Packets",
    annotations: READ,
    description:
      "Lists individual packets from the sniffer's in-memory ring buffer (`/tool sniffer packet print`) " +
      "— use to inspect packet-level detail (src/dst address, protocol, size, timestamp) after " +
      "start_sniffer. Optionally filter by partial src/dst address (address_filter) or protocol name " +
      "(protocol_filter). For per-host byte/packet aggregates use list_sniffer_hosts; for protocol " +
      "distribution use list_sniffer_protocols; for connection-pair (flow) view use " +
      "list_sniffer_connections. Requires an active or recently stopped sniffer session.",
    inputSchema: {
      address_filter: z.string().optional().describe("Partial src/dst address match"),
      protocol_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing sniffer packets");
      const filters: string[] = [];
      if (a.address_filter)
        filters.push(
          `(src-address~${quoted(a.address_filter)} or dst-address~${quoted(a.address_filter)})`,
        );
      if (a.protocol_filter) filters.push(`protocol~${quoted(a.protocol_filter)}`);

      const result = await executeMikrotikCommand(
        `/tool sniffer packet print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No captured packets found matching the criteria."
        : `SNIFFER PACKETS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_sniffer_hosts",
    title: "List Sniffer Observed Hosts",
    annotations: READ,
    description:
      "Lists hosts observed by the packet sniffer with per-host byte and packet counts " +
      "(`/tool sniffer host print`) — use to identify the most active talkers in the current capture. " +
      "Optionally filter by partial address string (address_filter). " +
      "For individual packet detail use list_sniffer_packets; for protocol breakdown use " +
      "list_sniffer_protocols; for connection-pair (flow) view use list_sniffer_connections. " +
      "Requires an active or recently stopped sniffer session started with start_sniffer.",
    inputSchema: {
      address_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info("Listing sniffer hosts");
      const filters: string[] = [];
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);

      const result = await executeMikrotikCommand(
        `/tool sniffer host print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No sniffer hosts found matching the criteria."
        : `SNIFFER HOSTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_sniffer_protocols",
    title: "List Sniffer Protocol Distribution",
    annotations: READ,
    description:
      "Lists the protocol breakdown of traffic observed by the packet sniffer " +
      "(`/tool sniffer protocol print`) — returns each protocol with its byte and packet share. " +
      "Use to identify which protocols dominate the captured traffic. " +
      "For per-host statistics use list_sniffer_hosts; for individual packet detail use " +
      "list_sniffer_packets; for connection-pair (flow) view use list_sniffer_connections. " +
      "Requires an active or recently stopped sniffer session started with start_sniffer.",
    async handler(_a, ctx) {
      ctx.info("Listing sniffer protocols");
      const result = await executeMikrotikCommand("/tool sniffer protocol print", ctx);
      return isEmpty(result)
        ? "No sniffer protocol data found."
        : `SNIFFER PROTOCOLS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_sniffer_connections",
    title: "List Sniffer Observed Connections",
    annotations: READ,
    description:
      "Lists connection pairs (src/dst address and port tuples) observed by the packet sniffer " +
      "(`/tool sniffer connection print`) — use to identify active or recent flows at a session level. " +
      "For individual packet detail use list_sniffer_packets; for per-host byte/packet aggregates use " +
      "list_sniffer_hosts; for protocol breakdown use list_sniffer_protocols. " +
      "Requires an active or recently stopped sniffer session started with start_sniffer.",
    async handler(_a, ctx) {
      ctx.info("Listing sniffer connections");
      const result = await executeMikrotikCommand("/tool sniffer connection print", ctx);
      return isEmpty(result)
        ? "No sniffer connections found."
        : `SNIFFER CONNECTIONS:\n\n${result}`;
    },
  }),
];
