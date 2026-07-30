/**
 * Two narratives → what changed, and what it MEANS. PURE.
 *
 * `diff_config_snapshots` already shows a line diff, and a line diff is exactly
 * what a reviewer cannot act on: it says a rule moved, not that the forward
 * chain stopped dropping. This reports consequences — "VLAN 40 was added and can
 * reach the internet through the existing masquerade rule" — because that is the
 * sentence someone approves or rejects a change on.
 *
 * Deterministic, like everything else here: same pair in, same prose out.
 */
import { actionPastTense } from "./analyze";
import type { DeviceNarrative, NarrativeExposure, NarrativeSubnet } from "./analyze";

export type ChangeImpact = "security" | "connectivity" | "structure" | "cosmetic";

export interface NarrativeChange {
  /** One sentence, in consequence terms. */
  summary: string;
  impact: ChangeImpact;
  /** Worse means "read this one first". */
  severity: "critical" | "high" | "medium" | "low";
  /** Supporting detail, when the one-liner needs backing. */
  detail?: string;
}

export interface NarrativeDiff {
  changes: NarrativeChange[];
  /** True when the two narratives describe the same configuration. */
  identical: boolean;
  before?: string;
  after?: string;
}

const IMPACT_ORDER: Record<ChangeImpact, number> = {
  security: 0,
  connectivity: 1,
  structure: 2,
  cosmetic: 3,
};
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/** Does anything in the config source-NAT traffic out to the internet? */
function hasInternetNat(n: DeviceNarrative): boolean {
  return n.wans.some((w) => w.nat !== "none");
}

function subnetKey(s: NarrativeSubnet): string {
  return `${s.cidr}@${s.interface}`;
}

function exposureKey(e: NarrativeExposure): string {
  return `${e.kind}:${e.what}:${e.detail}`;
}

/** Compare two analysed configurations. */
export function diffNarratives(before: DeviceNarrative, after: DeviceNarrative): NarrativeDiff {
  const changes: NarrativeChange[] = [];

  // ── Exposure: the reason anyone reads a diff ────────────────────────────
  const beforeExposure = new Map(before.exposure.map((e) => [exposureKey(e), e]));
  const afterExposure = new Map(after.exposure.map((e) => [exposureKey(e), e]));

  for (const [key, e] of afterExposure) {
    if (beforeExposure.has(key)) continue;
    changes.push({
      summary:
        e.kind === "dst-nat"
          ? `${e.detail} is now forwarded to ${e.what}, reachable from ${e.from}`
          : `${e.what} is now reachable from ${e.from} (${e.detail})`,
      impact: "security",
      severity: e.severity,
      detail: `New ${e.kind} exposure at line ${e.line}.`,
    });
  }
  for (const [key, e] of beforeExposure) {
    if (afterExposure.has(key)) continue;
    changes.push({
      summary: `${e.what} is no longer reachable from outside`,
      impact: "security",
      severity: "low",
      detail: `The ${e.kind} exposure that was at line ${e.line} is gone.`,
    });
  }

  // ── Firewall posture: a chain that stopped dropping ─────────────────────
  const beforeChains = new Map(before.chains.map((c) => [`${c.table}/${c.chain}`, c]));
  const afterChains = new Map(after.chains.map((c) => [`${c.table}/${c.chain}`, c]));
  for (const [key, chain] of afterChains) {
    const was = beforeChains.get(key);
    if (!was) {
      changes.push({
        summary: `a new \`${chain.chain}\` chain appeared in \`${chain.table}\` with ${chain.ruleCount} rule(s)`,
        impact: "structure",
        severity: "medium",
      });
      continue;
    }
    if (was.defaultAction !== chain.defaultAction) {
      // The single most consequential firewall change there is, and the one a
      // line diff renders as an unremarkable moved rule.
      const opened = chain.defaultAction === "accept" || chain.defaultAction === "unknown";
      changes.push({
        summary: opened
          ? `the \`${chain.chain}\` chain no longer ends in a ${was.defaultAction} — anything not matched is now allowed`
          : `the \`${chain.chain}\` chain now has a catch-all: anything not matched is ${actionPastTense(chain.defaultAction)}`,
        impact: "security",
        severity: opened ? "critical" : "medium",
        detail: `\`${chain.table}\` / \`${chain.chain}\`: ${was.defaultAction} → ${chain.defaultAction}.`,
      });
    } else if (was.ruleCount !== chain.ruleCount) {
      const delta = chain.ruleCount - was.ruleCount;
      changes.push({
        summary: `\`${chain.chain}\` in \`${chain.table}\` ${delta > 0 ? "gained" : "lost"} ${Math.abs(delta)} rule(s)`,
        impact: "security",
        severity: "medium",
        detail: `Anything not matched is still ${actionPastTense(chain.defaultAction)}.`,
      });
    }
  }
  for (const [key, chain] of beforeChains) {
    if (afterChains.has(key)) continue;
    changes.push({
      summary: `the \`${chain.chain}\` chain in \`${chain.table}\` is gone — its ${chain.ruleCount} rule(s) no longer apply`,
      impact: "security",
      severity: chain.defaultAction === "drop" ? "critical" : "high",
    });
  }

  // ── Addressing ──────────────────────────────────────────────────────────
  const beforeSubnets = new Map(before.subnets.map((s) => [subnetKey(s), s]));
  const afterSubnets = new Map(after.subnets.map((s) => [subnetKey(s), s]));
  const natReaches = hasInternetNat(after);
  for (const [key, s] of afterSubnets) {
    if (beforeSubnets.has(key)) continue;
    const vlan = s.vlanId !== undefined ? `VLAN ${s.vlanId} ` : "";
    const dhcp = s.dhcp
      ? `, served by DHCP (${s.dhcp.ranges.join(", ") || s.dhcp.server})`
      : ", with no DHCP";
    changes.push({
      summary: `${vlan}${s.cidr} was added on ${s.interface}${dhcp}${
        natReaches ? " and can reach the internet through the existing NAT rule" : ""
      }`,
      impact: "connectivity",
      severity: "medium",
    });
  }
  for (const [key, s] of beforeSubnets) {
    if (afterSubnets.has(key)) continue;
    changes.push({
      summary: `${s.cidr} on ${s.interface} is gone — anything addressed there is now unreachable`,
      impact: "connectivity",
      severity: "high",
    });
  }
  for (const [key, s] of afterSubnets) {
    const was = beforeSubnets.get(key);
    if (!was) continue;
    if (!!was.dhcp !== !!s.dhcp) {
      changes.push({
        summary: s.dhcp
          ? `${s.cidr} now has a DHCP server — hosts there get addresses automatically`
          : `${s.cidr} lost its DHCP server — hosts there must be configured by hand`,
        impact: "connectivity",
        severity: s.dhcp ? "low" : "high",
      });
    }
  }

  // ── Internet path ───────────────────────────────────────────────────────
  const beforeWans = new Map(before.wans.map((w) => [w.interface, w]));
  const afterWans = new Map(after.wans.map((w) => [w.interface, w]));
  for (const [name, w] of afterWans) {
    const was = beforeWans.get(name);
    if (!was) {
      changes.push({
        summary: `${name} is now an upstream (${w.addressing}, NAT: ${w.nat})`,
        impact: "connectivity",
        severity: "medium",
      });
      continue;
    }
    if (was.nat !== w.nat) {
      changes.push({
        summary: `NAT on ${name} changed from ${was.nat} to ${w.nat}`,
        impact: "connectivity",
        severity: w.nat === "none" ? "high" : "medium",
        detail: w.nat === "none" ? "Traffic leaving this way is no longer translated." : undefined,
      });
    }
    if (was.distance !== w.distance) {
      changes.push({
        summary: `${name} changed priority (distance ${was.distance ?? "—"} → ${w.distance ?? "—"})`,
        impact: "connectivity",
        severity: "medium",
      });
    }
    if (was.checkGateway !== w.checkGateway) {
      changes.push({
        summary: w.checkGateway
          ? `${name} is now health-checked with ${w.checkGateway}`
          : `${name} is no longer health-checked — a dead upstream will not fail over`,
        impact: "connectivity",
        severity: w.checkGateway ? "low" : "high",
      });
    }
  }
  for (const [name] of beforeWans) {
    if (afterWans.has(name)) continue;
    changes.push({
      summary: `${name} is no longer an upstream`,
      impact: "connectivity",
      severity: "high",
    });
  }

  // ── Tunnels ─────────────────────────────────────────────────────────────
  const beforeTunnels = new Map(before.tunnels.map((t) => [t.name, t]));
  const afterTunnels = new Map(after.tunnels.map((t) => [t.name, t]));
  for (const [name, t] of afterTunnels) {
    const was = beforeTunnels.get(name);
    if (!was) {
      changes.push({
        summary: `a ${t.kind} tunnel \`${name}\` was added${t.peers.length > 0 ? ` to ${t.peers.join(", ")}` : ""}`,
        impact: "connectivity",
        severity: "medium",
      });
      continue;
    }
    if (was.peers.length !== t.peers.length) {
      const delta = t.peers.length - was.peers.length;
      changes.push({
        summary: `\`${name}\` ${delta > 0 ? "gained" : "lost"} ${Math.abs(delta)} peer(s)`,
        impact: "connectivity",
        severity: "medium",
      });
    }
    if (was.disabled !== t.disabled) {
      changes.push({
        summary: `\`${name}\` was ${t.disabled ? "disabled" : "enabled"}`,
        impact: "connectivity",
        severity: t.disabled ? "high" : "medium",
      });
    }
  }
  for (const [name, t] of beforeTunnels) {
    if (afterTunnels.has(name)) continue;
    changes.push({
      summary: `the ${t.kind} tunnel \`${name}\` was removed — anything that depended on it is cut off`,
      impact: "connectivity",
      severity: "high",
    });
  }

  // ── Services ────────────────────────────────────────────────────────────
  const beforeServices = new Map(before.services.map((s) => [s.name, s]));
  for (const s of after.services) {
    const was = beforeServices.get(s.name);
    if (!was) continue;
    if (was.enabled !== s.enabled) {
      changes.push({
        summary: `the ${s.name} service was ${s.enabled ? "enabled" : "disabled"}`,
        impact: "security",
        severity: s.enabled ? "high" : "low",
      });
    }
    if (was.availableFrom !== s.availableFrom) {
      changes.push({
        summary: s.availableFrom
          ? `${s.name} is now restricted to ${s.availableFrom}`
          : `${s.name} lost its address restriction — it now accepts from anywhere`,
        impact: "security",
        severity: s.availableFrom ? "low" : "critical",
      });
    }
  }

  // ── Role and identity ───────────────────────────────────────────────────
  const beforeRole = before.identity.roles.primary?.role;
  const afterRole = after.identity.roles.primary?.role;
  if (beforeRole !== afterRole) {
    changes.push({
      summary: `the device now looks like a ${after.identity.roles.primary?.label ?? "device with no recognisable role"} (was ${before.identity.roles.primary?.label ?? "unrecognised"})`,
      impact: "structure",
      severity: "medium",
    });
  }
  if (before.identity.version !== after.identity.version) {
    changes.push({
      summary: `RouterOS ${before.identity.version ?? "?"} → ${after.identity.version ?? "?"}`,
      impact: "cosmetic",
      severity: "low",
    });
  }
  if (before.identity.name !== after.identity.name) {
    changes.push({
      summary: `the device identity changed from ${before.identity.name ?? "(unset)"} to ${after.identity.name ?? "(unset)"}`,
      impact: "cosmetic",
      severity: "low",
    });
  }

  // ── Coverage ────────────────────────────────────────────────────────────
  if (after.unknowns.length > before.unknowns.length) {
    changes.push({
      summary: `${after.unknowns.length - before.unknowns.length} more part(s) of the configuration are outside what this analysis covers`,
      impact: "structure",
      severity: "low",
      detail: "Read them yourself — this comparison says nothing about them.",
    });
  }

  changes.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] ||
      a.summary.localeCompare(b.summary),
  );

  return {
    changes,
    identical: changes.length === 0,
    before: before.identity.name ?? before.device,
    after: after.identity.name ?? after.device,
  };
}

/** Render a diff as Markdown. */
export function renderDiff(diff: NarrativeDiff): string {
  const lines = ["# What changed", ""];
  if (diff.identical) {
    lines.push(
      "Nothing this analysis covers is different between the two configurations.",
      "",
      "_That is not the same as the two exports being identical — a line diff may still show",
      "changes in areas this narrative does not model. See `diff_config_snapshots` for that._",
      "",
    );
    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push(`${diff.changes.length} change(s) worth knowing about, most consequential first.`, "");
  for (const change of diff.changes) {
    lines.push(`- **[${change.severity}/${change.impact}]** ${change.summary}`);
    if (change.detail) lines.push(`  - ${change.detail}`);
  }
  lines.push(
    "",
    "_This compares consequences, not lines. For the exact text that changed, use",
    "`diff_config_snapshots`._",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
