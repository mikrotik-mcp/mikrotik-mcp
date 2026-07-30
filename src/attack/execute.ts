/**
 * The only module in this feature allowed to change a device.
 *
 * It may act on nothing except a `ResponsePlan` that `respond.ts` produced —
 * every guard has already run by the time anything gets here, and this file
 * deliberately contains no policy of its own to argue with them.
 *
 * The one structural rule it does enforce: **one drop rule per device, ever.**
 * Blocking an address is an address-list insert, never a new firewall rule. A
 * responder that adds a rule per attacker builds the unreviewable thousand-rule
 * chain that `firewall_audit` exists to complain about, and it would be this
 * server's own doing.
 */
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import type { ToolContext } from "../core/context";
import { Cmd, looksLikeError } from "../core/routeros";
import { logger } from "../logger";
import { BLOCK_LIST } from "./respond";
import type { ResponsePlan } from "./respond";

/** Comment on the rule and every entry, so a human can tell where they came from. */
export const BLOCK_TAG = "mcp-attack-detection";

export interface ExecutionResult {
  device: string;
  ok: boolean;
  detail: string;
}

/**
 * Ensure the device has exactly one raw-chain drop referencing the block list.
 *
 * `/ip firewall raw` rather than `filter`: a raw prerouting drop costs less than
 * a conntrack entry per packet, which is the difference that matters when the
 * thing you are dropping is a flood.
 */
async function ensureDropRule(ctx: ToolContext, list: string): Promise<boolean> {
  const existing = await executeMikrotikCommand(
    `/ip firewall raw print count-only where src-address-list="${list}"`,
    ctx,
  );
  if (!looksLikeError(existing) && Number(existing.trim()) > 0) return true;

  const cmd = new Cmd("/ip firewall raw add")
    .set("chain", "prerouting")
    .set("action", "drop")
    .set("src-address-list", list)
    .set("comment", BLOCK_TAG)
    .build();
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) {
    logger.error(`could not create the attack drop rule: ${result.trim()}`);
    return false;
  }
  return true;
}

/**
 * Apply a plan to every device it names.
 *
 * Per device, never all-or-nothing: one unreachable router must not stop the
 * other forty-nine from being protected.
 */
export async function executePlan(plan: ResponsePlan): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];

  for (const device of plan.devices) {
    const ctx = createContext(undefined, device);
    try {
      if (plan.action === "escalate" || plan.action === "watch") {
        results.push({ device, ok: true, detail: "no device change — escalated to a human" });
        continue;
      }

      const list = plan.list || BLOCK_LIST;
      if (!(await ensureDropRule(ctx, list))) {
        results.push({ device, ok: false, detail: "the drop rule could not be created" });
        continue;
      }

      // Idempotent: an address already listed is left alone rather than
      // duplicated, so a repeated poll cannot fill the list with one attacker.
      const present = await executeMikrotikCommand(
        `/ip firewall address-list print count-only where list="${list}" address="${plan.source}"`,
        ctx,
      );
      if (!looksLikeError(present) && Number(present.trim()) > 0) {
        results.push({ device, ok: true, detail: `${plan.source} was already blocked` });
        continue;
      }

      const cmd = new Cmd("/ip firewall address-list add")
        .set("list", list)
        .set("address", plan.source)
        .opt("timeout", plan.timeout || undefined)
        .set("comment", `${BLOCK_TAG}: ${plan.incidentId}`)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) {
        results.push({ device, ok: false, detail: result.trim() });
        continue;
      }
      results.push({
        device,
        ok: true,
        detail: plan.timeout
          ? `blocked for ${plan.timeout}`
          : "blocked permanently (as explicitly confirmed)",
      });
    } catch (e) {
      results.push({ device, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}

/** Lift a block everywhere it was applied. */
export async function revokeBlock(
  source: string,
  devices: string[],
  list = BLOCK_LIST,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const device of devices) {
    const ctx = createContext(undefined, device);
    try {
      const count = await executeMikrotikCommand(
        `/ip firewall address-list print count-only where list="${list}" address="${source}"`,
        ctx,
      );
      if (looksLikeError(count) || Number(count.trim()) === 0) {
        results.push({ device, ok: true, detail: "was not blocked here" });
        continue;
      }
      const result = await executeMikrotikCommand(
        `/ip firewall address-list remove [find list="${list}" address="${source}"]`,
        ctx,
      );
      results.push(
        looksLikeError(result)
          ? { device, ok: false, detail: result.trim() }
          : { device, ok: true, detail: "unblocked" },
      );
    } catch (e) {
      results.push({ device, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/** Read the addresses the device's own port-scan detector has tagged. */
export async function readScanList(ctx: ToolContext, list = "port-scanners"): Promise<string[]> {
  const raw = await executeMikrotikCommand(
    `/ip firewall address-list print terse where list="${list}"`,
    ctx,
  );
  if (looksLikeError(raw)) return [];
  const addresses = new Set<string>();
  for (const m of raw.matchAll(/address=(\S+)/g)) addresses.add(m[1]);
  return [...addresses];
}
