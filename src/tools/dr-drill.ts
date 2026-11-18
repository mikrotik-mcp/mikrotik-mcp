/**
 * DR Drill — Chaos Engineering for routers. Safely rehearse a failure before it
 * happens: the tool disables a WAN/tunnel/link, pings a verify host to check
 * whether the backup path actually carries traffic, then re-enables the target
 * — proving resilience without waiting for a real 2 a.m. outage.
 *
 * Prefers Safe Mode (auto-revert on disconnect), but falls back to direct
 * disable → ping → re-enable when the interactive PTY wedges (some RouterOS
 * builds don't support Safe Mode over SSH exec channels).
 *
 * The `parsePingSummary` helper is unit-tested.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { DANGEROUS, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, quoteValue, quoted } from "../core/routeros";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { getSafeModeManager } from "../ssh/safe-mode";

/** Sent/received/loss parsed from a RouterOS `/ping` summary. */
export interface PingSummary {
  sent: number;
  received: number;
  lossPct: number;
}

/** Parse the trailing summary of `/ping` output (`sent=5 received=5 packet-loss=0%`). */
export function parsePingSummary(output: string): PingSummary | null {
  const sent = output.match(/sent=(\d+)/)?.[1];
  const received = output.match(/received=(\d+)/)?.[1];
  const loss = output.match(/packet-loss=(\d+)\s*%/)?.[1];
  if (sent == null || received == null) return null;
  return {
    sent: Number(sent),
    received: Number(received),
    lossPct: loss != null ? Number(loss) : received === sent ? 0 : 100,
  };
}

export const drDrillTools: ToolModule = [
  defineTool({
    name: "run_failover_drill",
    title: "Run Failover DR Drill",
    annotations: DANGEROUS,
    description:
      "Rehearses a disaster: disables a target (a WAN/tunnel interface, or a route), pings " +
      "`verify_host` to check the backup path actually carries traffic, then RE-ENABLES the target. " +
      "Prefers Safe Mode (auto-revert on disconnect) but falls back to direct commands when Safe " +
      "Mode is unavailable. Proves your failover works without a real outage. Requires `confirm=true` " +
      "to run (it briefly disrupts traffic on the target); with confirm=false it just describes the " +
      "drill. Returns whether connectivity held during the simulated failure.",
    inputSchema: {
      target_type: z.enum(["interface", "route"]).default("interface"),
      target: z
        .string()
        .describe("Interface name (e.g. 'ether1-wan') or, for route, a find expression / .id"),
      verify_host: z
        .string()
        .describe("Host to ping during the outage to confirm the backup path, e.g. '8.8.8.8'"),
      ping_count: z.number().int().min(1).max(50).default(5),
      confirm: z.boolean().default(false).describe("Must be true to actually run the drill"),
    },
    async handler(a, ctx) {
      // A route target is an `.id`, or `key=value` terms of a find expression. Each
      // term is checked: free text here would run on the router as commands.
      if (
        a.target_type === "route" &&
        !a.target.startsWith("*") &&
        !/^[\w.-]+=[\w.:/,*@!-]+(?: [\w.-]+=[\w.:/,*@!-]+)*$/.test(a.target)
      )
        return "Invalid route target. Use an .id (*1A) or key=value terms such as 'dst-address=0.0.0.0/0 gateway=10.0.0.1'.";
      const findExpr = a.target.startsWith("*") ? `.id=${quoteValue(a.target)}` : a.target;
      const disableCmd =
        a.target_type === "interface"
          ? `/interface disable ${quoted(a.target)}`
          : `/ip route disable [find ${findExpr}]`;
      const enableCmd =
        a.target_type === "interface"
          ? `/interface enable ${quoted(a.target)}`
          : `/ip route enable [find ${findExpr}]`;
      const pingCmd = `/ping address=${quoteValue(a.verify_host)} count=${a.ping_count}`;

      if (!a.confirm) {
        return (
          `DRY RUN — would: (1) ${disableCmd}; (2) ${pingCmd}; (3) re-enable. ` +
          "Set confirm=true to run the drill."
        );
      }

      const device = resolveDeviceName(ctx.device);

      // ── Try Safe Mode first (auto-reverts on disconnect) ──────────────
      const isMac = !!getDevice(device).mac;
      let usedSafeMode = false;
      if (!isMac) {
        const mgr = getSafeModeManager(device);
        try {
          const en = await mgr.enable();
          if (!en.startsWith("Error")) {
            usedSafeMode = true;
            try {
              const disableOut = await mgr.execute(disableCmd);
              if (/no such item|failure:|syntax error/i.test(disableOut)) {
                return `Could not disable target '${a.target}': ${disableOut.trim()} (Safe Mode rolled back).`;
              }
              const pingOut = await mgr.execute(pingCmd);
              return formatResult(
                a,
                pingOut,
                "The change has been rolled back (Safe Mode); nothing was committed.",
              );
            } finally {
              await mgr.rollback();
            }
          }
        } catch {
          // Safe Mode unavailable (PTY wedged / timeout) — fall through to direct path.
          try {
            await mgr.rollback();
          } catch {
            /* already torn down */
          }
        }
      }

      // ── Direct fallback: disable → ping → re-enable ──────────────────
      if (!usedSafeMode) {
        ctx.info("Safe Mode unavailable — using direct disable/enable fallback");
      }
      const disableOut = await executeMikrotikCommand(disableCmd, ctx);
      if (looksLikeError(disableOut) || /no such item/i.test(disableOut)) {
        return `Could not disable target '${a.target}': ${disableOut.trim()}`;
      }
      try {
        const pingOut = await executeMikrotikCommand(pingCmd, ctx, {
          maxMs: (a.ping_count + 2) * 1500,
        });
        return formatResult(
          a,
          pingOut,
          "The target has been re-enabled (direct command); the drill is complete.",
        );
      } finally {
        // Always re-enable, even if the ping command fails.
        await executeMikrotikCommand(enableCmd, ctx);
      }
    },
  }),
];

/** Build the human-readable drill result from a ping output. */
function formatResult(
  a: { target_type: string; target: string; verify_host: string },
  pingOut: string,
  footer: string,
): string {
  const summary = parsePingSummary(pingOut);
  const held = summary != null && summary.received > 0;
  const detail = summary
    ? `${summary.received}/${summary.sent} replies (${summary.lossPct}% loss)`
    : "could not parse ping result";
  const verdict = held
    ? "PASS — Backup path HELD, failover works."
    : "FAIL — NO connectivity during the outage, failover did NOT carry traffic.";
  return `DR DRILL — disabled ${a.target_type} '${a.target}', pinged ${a.verify_host}: ${detail}.\n${verdict}\n${footer}`;
}
