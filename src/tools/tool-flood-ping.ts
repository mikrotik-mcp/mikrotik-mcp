/** Flood ping — `/tool flood-ping`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, isEmpty, flattenLiveOutput, Cmd, quoteValue } from "../core/routeros";

export const floodPingTools: ToolModule = [
  defineTool({
    name: "flood_ping",
    title: "Flood Ping Host",
    annotations: READ,
    description:
      "Sends a burst of ICMP echo requests as fast as possible to a target host or IP " +
      "(`/tool flood-ping`). Use to stress-test packet loss and measure raw round-trip " +
      "latency under maximum-rate load rather than at a timed interval; the run terminates " +
      "after `count` packets (default 1000) so it does not stream indefinitely. " +
      "Returns sent/received packet counts and min/avg/max round-trip times. " +
      "Optional: `size` (packet size in bytes), `interface` (outgoing interface), " +
      "`src_address` (source IP address to use).",
    inputSchema: {
      address: z.string().describe("Target host or IP"),
      count: z
        .number()
        .int()
        .min(1)
        .max(1000000)
        .default(1000)
        .describe("Number of packets to send (bounds the run)"),
      size: z.number().int().optional().describe("Packet size in bytes"),
      interface: z.string().optional().describe("Outgoing interface"),
      src_address: z.string().optional().describe("Source address"),
    },
    async handler(a, ctx) {
      ctx.info(`Flood-pinging ${a.address} (count=${a.count})`);
      const cmd = new Cmd(`/tool flood-ping ${quoteValue(a.address)}`)
        .set("count", a.count)
        .opt("size", a.size)
        .opt("interface", a.interface)
        .opt("src-address", a.src_address)
        .build();
      // Flood-ping is fast but high-volume; bound the read and flatten the live
      // redraw so it always returns a summary instead of streaming/hanging.
      const result = flattenLiveOutput(await executeMikrotikCommand(cmd, ctx, { maxMs: 30_000 }));
      if (looksLikeError(result)) return `Failed to flood-ping ${a.address}: ${result}`;
      return isEmpty(result)
        ? `No response from ${a.address}.`
        : `FLOOD PING ${a.address}:\n\n${result}`;
    },
  }),
];
