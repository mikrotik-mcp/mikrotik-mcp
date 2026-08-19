/** Speed test — `/tool speed-test`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, isEmpty, flattenLiveOutput, Cmd } from "../core/routeros";

export const speedTestTools: ToolModule = [
  defineTool({
    name: "speed_test",
    title: "Run RouterOS Speed Test",
    annotations: READ,
    description:
      "Runs a bandwidth and latency speed test from the router to a target RouterOS device " +
      "(`/tool speed-test`) — measures ping, jitter, and TCP/UDP throughput between two " +
      "MikroTik/RouterOS nodes. The target `address` must be a reachable RouterOS device; " +
      "this is NOT a general ICMP ping/traceroute (for that use the ping or traceroute tools). " +
      "The tool automatically runs both directions (receive and transmit) — there is no " +
      "direction selector on `/tool speed-test`. Each sub-test runs for `duration` seconds " +
      "(the tool runs ping + TCP recv/send + UDP recv/send, so total wall time is a few times " +
      "this). `connection_count` sets the number of parallel streams (default 20, or the core " +
      "count if higher). Optional `user`/`password` authenticate to the remote device. Returns " +
      "measured throughput and latency figures.",
    inputSchema: {
      address: z.string().describe("Target RouterOS device address"),
      duration: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe("Per-test duration in seconds (maps to RouterOS `test-duration`)"),
      connection_count: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Parallel connections to use (RouterOS `connection-count`, default 20)"),
      user: z.string().optional().describe("Username for the target device"),
      password: z.string().optional().describe("Password for the target device"),
    },
    async handler(a, ctx) {
      ctx.info(`Speed test to ${a.address} (test-duration=${a.duration}s)`);
      // `/tool speed-test` params are: address, test-duration, connection-count,
      // user, password. It has NO `direction` (it always tests both ways) and the
      // duration param is `test-duration`, not `duration`.
      const cmd = new Cmd("/tool speed-test")
        .set("address", a.address)
        .set("test-duration", `${a.duration}s`)
        .opt("connection-count", a.connection_count)
        .opt("user", a.user)
        .opt("password", a.password)
        .build();
      // speed-test runs a latency phase then a throughput phase; cap the read at
      // duration + generous slack and flatten the live redraw so it can't hang.
      const result = flattenLiveOutput(
        await executeMikrotikCommand(cmd, ctx, { maxMs: a.duration * 1000 + 15_000 }),
      );
      if (looksLikeError(result)) return `Failed to run speed test to ${a.address}: ${result}`;
      return isEmpty(result)
        ? `No speed-test results for ${a.address}.`
        : `SPEED TEST:\n\n${result}`;
    },
  }),
];
