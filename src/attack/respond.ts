/**
 * Should we do anything about this incident, and what? PURE — decides only.
 *
 * Auto-blocking is the most dangerous thing this repo can ship, so the decision
 * is separated from the act: every refusal below is unit-testable offline, with
 * no router in the loop. `execute.ts` is the only module allowed to touch a
 * device, and it may only carry out a plan this module produced.
 *
 * The three failure modes this exists to prevent (`docs/tasks/11` §4):
 *
 * 1. **Locking the operator out.** The admin's VPN reconnect loop and an
 *    attacker's retry loop look similar from a log line.
 * 2. **Blocking a forged source.** A flood with spoofed addresses turns any
 *    auto-blocker into a weapon aimed at whoever the attacker names — the
 *    upstream gateway, the resolver, a customer.
 * 3. **Blocking the monitoring.** This server's own management session logs a
 *    successful login every few seconds.
 *
 * Every guard here is enforced in code and cannot be configured away.
 */
import type { Incident } from "./correlate";
import { isPublicSource } from "./detectors";

export type ResponseAction = "watch" | "block" | "quarantine" | "escalate";

export type ResponseMode = "detect" | "respond";

export interface ResponsePolicy {
  /**
   * `detect` records and alerts but never changes a device. The default, and
   * the only value the docs suggest starting with.
   */
  mode: ResponseMode;
  /** Minimum confidence before anything but `watch` is considered. */
  minConfidence: "medium" | "high" | "confirmed";
  /** How long a block lasts. A wrong block must expire on its own. */
  blockTimeout: string;
  /** Blocks per device per hour. Beyond this, refuse loudly. */
  maxBlocksPerHour: number;
  /** Addresses and CIDRs that may never be blocked, whatever the evidence. */
  neverBlock: string[];
  /** Detectors permitted to trigger an automatic response. */
  autoRespondTo: string[];
}

export const DEFAULT_POLICY: ResponsePolicy = {
  mode: "detect",
  minConfidence: "high",
  blockTimeout: "1h",
  maxBlocksPerHour: 6,
  neverBlock: [],
  autoRespondTo: ["brute-force", "credential-spray"],
};

export interface ResponsePlan {
  incidentId: string;
  action: ResponseAction;
  source: string;
  devices: string[];
  /** Empty for a permanent entry — which needs an explicit confirmation. */
  timeout: string;
  /** Address-list the block lives in. One list, never a rule per attacker. */
  list: string;
  reason: string;
}

export interface Refusal {
  incidentId: string;
  action: "watch";
  /** Why nothing was done, in the operator's words. */
  reason: string;
  /** True when the refusal is a guard rather than a policy choice. */
  guard: boolean;
}

export type Decision = ResponsePlan | Refusal;

export function isPlan(decision: Decision): decision is ResponsePlan {
  return decision.action !== "watch";
}

/** The address-list every automatic block goes into. */
export const BLOCK_LIST = "mcp-attack-block";

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2, confirmed: 3 };

/**
 * Addresses that must never be blocked, whatever any policy says.
 *
 * Seeded from the deployment itself rather than typed by hand: the operator
 * cannot be expected to remember to exclude their own gateway at three in the
 * morning, and the one time they forget is the time it matters.
 */
export interface GuardContext {
  /** Every configured device's own host/address. */
  deviceHosts: string[];
  /** This server's source address as each device sees it. */
  managementSources: string[];
  /** Each device's default gateway and DNS servers. */
  infrastructure: string[];
  /** Operator-supplied additions. */
  configured: string[];
}

/** Everything that may never be blocked, de-duplicated. */
export function neverBlockSet(ctx: GuardContext): Set<string> {
  return new Set([
    ...ctx.deviceHosts,
    ...ctx.managementSources,
    ...ctx.infrastructure,
    ...ctx.configured,
  ]);
}

/** Does `address` fall inside `entry` (a literal address or a `/nn` CIDR)? */
function covers(entry: string, address: string): boolean {
  if (entry === address) return true;
  const slash = entry.indexOf("/");
  if (slash === -1) return false;
  const bits = Number(entry.slice(slash + 1));
  const base = entry.slice(0, slash);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const toInt = (ip: string): number | null => {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      value = (value << 8) | n;
    }
    return value >>> 0;
  };
  const a = toInt(base);
  const b = toInt(address);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

/** True when this address is protected from blocking. */
export function isNeverBlock(address: string, never: Set<string>): boolean {
  if (never.has(address)) return true;
  for (const entry of never) {
    if (covers(entry, address)) return true;
  }
  return false;
}

export interface DecideInput {
  incident: Incident;
  policy: ResponsePolicy;
  guards: GuardContext;
  /** Blocks already applied on these devices within the last hour. */
  recentBlockCount: number;
  /** Set by an operator calling `block_attacker` by hand. */
  manual?: boolean;
  /** Required for a permanent (timeout-free) block. */
  confirm?: boolean;
  /** Overrides the policy timeout; empty string means permanent. */
  timeout?: string;
}

/**
 * Decide what to do about one incident.
 *
 * Guards are checked before policy, and in the order that fails safest. A
 * refusal always says which rule stopped it — a tool that quietly declines is
 * worse than one that explains itself.
 */
export function decide(input: DecideInput): Decision {
  const { incident, policy, guards } = input;
  const watch = (reason: string, guard = false): Refusal => ({
    incidentId: incident.id,
    action: "watch",
    reason,
    guard,
  });

  // ── Guards: these cannot be configured away ─────────────────────────────

  if (incident.source === "") {
    return watch(
      "this incident has no attacker address — a configuration change is evidence, not a connection to block",
      true,
    );
  }

  if (incident.spoofableOnly) {
    // The weapon-pointed-at-a-third-party case. Volume is never enough.
    return watch(
      "every signal here rests on a source address that can be forged; blocking it would let the attacker choose the victim",
      true,
    );
  }

  const never = neverBlockSet(guards);
  if (isNeverBlock(incident.source, never)) {
    return watch(
      `${incident.source} is protected: it is this server's own management path, a device, or infrastructure it depends on`,
      true,
    );
  }

  const wantsPermanent = input.timeout === "";
  if (wantsPermanent && !input.confirm) {
    return watch(
      "a permanent block needs confirm=true — a timed block expires on its own if it turns out to be wrong",
      true,
    );
  }

  if (input.recentBlockCount >= policy.maxBlocksPerHour) {
    // Loudly, not silently: hitting the cap is itself a finding.
    return watch(
      `the response cap of ${policy.maxBlocksPerHour} blocks/hour has been reached — ${incident.source} was NOT blocked, and something is either very wrong or spoofing you`,
      true,
    );
  }

  // ── Policy: the operator's choices ──────────────────────────────────────

  if (!input.manual) {
    if (policy.mode === "detect") {
      return watch(
        "detection-only mode: nothing is changed on a device until you enable responses",
      );
    }
    if (CONFIDENCE_RANK[incident.confidence] < CONFIDENCE_RANK[policy.minConfidence]) {
      return watch(
        `confidence is ${incident.confidence}, below the configured ${policy.minConfidence}`,
      );
    }
    const allowed = incident.detectors.filter((d) => policy.autoRespondTo.includes(d));
    if (allowed.length === 0) {
      return watch(
        `no detector here (${incident.detectors.join(", ")}) is configured for an automatic response`,
      );
    }
  }

  // A confirmed breach is not a blocking problem — the attacker is already in,
  // and a human has to look at the box.
  if (incident.stage === "breach" || incident.stage === "persistence") {
    if (!input.manual) {
      return {
        incidentId: incident.id,
        action: "escalate",
        source: incident.source,
        devices: incident.devices,
        timeout: "",
        list: "",
        reason:
          "someone appears to have got in; blocking the source now does not undo that, and a human has to check the device",
      };
    }
  }

  // A LAN source is quarantined by MAC so it survives a DHCP change, which an
  // address-list entry would not.
  const action: ResponseAction = isPublicSource(incident.source) ? "block" : "quarantine";

  return {
    incidentId: incident.id,
    action,
    source: incident.source,
    devices: incident.devices,
    timeout: input.timeout ?? policy.blockTimeout,
    list: BLOCK_LIST,
    reason: incident.narrative,
  };
}
