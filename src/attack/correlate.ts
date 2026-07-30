/**
 * Signals → incidents. PURE.
 *
 * A signal is a fact. An incident is a **story**: this address scanned you, then
 * tried two hundred passwords, then got in, then added a user. Told as four
 * separate findings, nobody acts on it; told as one sentence with a stage, it is
 * the most urgent thing on the screen.
 *
 * Correlation is deliberately cross-device. One source hitting three routers is
 * ONE incident with three affected devices — that is the pattern no single
 * router can ever see, and the whole argument for doing this on the host.
 */
import { createHash } from "node:crypto";
import type { DetectorId, Evidence, Severity, Signal } from "./detectors";

/**
 * How far along the attacker is. Inferred from which detectors fired, and the
 * reason an incident reads as a sentence rather than a list.
 */
export type Stage = "recon" | "attempt" | "breach" | "persistence";

export const STAGE_ORDER: Stage[] = ["recon", "attempt", "breach", "persistence"];

/** How much the evidence justifies believing it. */
export type Confidence = "low" | "medium" | "high" | "confirmed";

const STAGE_OF: Record<DetectorId, Stage> = {
  "port-scan": "recon",
  "service-exposure-hit": "recon",
  "brute-force": "attempt",
  "credential-spray": "attempt",
  "firewall-drop-storm": "attempt",
  "successful-after-fail": "breach",
  "new-admin-source": "breach",
  "post-compromise": "persistence",
};

/**
 * The existing tool that addresses each detector.
 *
 * Always a real tool name, never freeform advice: "consider tightening your
 * firewall" is what a report says when it has nothing to offer.
 */
const RECOMMENDATION: Record<DetectorId, string> = {
  "brute-force":
    "harden_firewall installs the SSH/Winbox rate limiting that stops this at the door",
  "credential-spray": "harden_ip_service_exposure restricts management services to known addresses",
  "successful-after-fail":
    "change_password and list_users NOW — then audit_account_hygiene for anything added",
  "new-admin-source": "list_users and audit_account_hygiene to confirm who that was",
  "port-scan": "add_port_scan_detection_rules is already tagging them; harden_firewall drops them",
  "firewall-drop-storm": "harden_firewall rate-limits volumetric traffic at the router",
  "service-exposure-hit":
    "harden_ip_service_exposure — a management port answering the internet is the actual bug",
  "post-compromise":
    "diff_config_snapshots against your last known-good snapshot, then audit_account_hygiene",
};

export interface Incident {
  /** Content-derived and stable across runs — see {@link incidentId}. */
  id: string;
  /** Attacker address; empty for evidence that is not a connection. */
  source: string;
  /** Every device this source touched. */
  devices: string[];
  stage: Stage;
  confidence: Confidence;
  severity: Severity;
  firstTs: number;
  lastTs: number;
  detectors: DetectorId[];
  /** One sentence a human can act on. */
  narrative: string;
  /** Existing tools that address it, most relevant first. */
  recommendations: string[];
  evidence: Evidence[];
  /** True when NO signal in it can be acted on automatically. */
  spoofableOnly: boolean;
  signalCount: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Stable identity for an incident.
 *
 * Keyed on the source and the day, not on the signal set: an incident that
 * gains a new detector is the SAME incident escalating, and a new id would make
 * the dashboard show two rows for one attacker mid-attack.
 */
export function incidentId(source: string, dayBucket: number): string {
  const digest = createHash("sha256")
    .update(`${source}|${dayBucket}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `atk_${digest}`;
}

/** Worst severity present. */
function worst(values: Severity[]): Severity {
  return values.reduce((a, b) => (SEVERITY_RANK[b] < SEVERITY_RANK[a] ? b : a), "info");
}

/** Furthest stage reached. */
function furthest(stages: Stage[]): Stage {
  return stages.reduce(
    (a, b) => (STAGE_ORDER.indexOf(b) > STAGE_ORDER.indexOf(a) ? b : a),
    "recon" as Stage,
  );
}

/**
 * How much to believe it.
 *
 * `confirmed` requires evidence that something actually happened — a login that
 * succeeded after failures, or a configuration change nobody can account for.
 * Volume alone never confirms anything, however much of it there is.
 */
function confidenceOf(detectors: Set<DetectorId>, deviceCount: number): Confidence {
  if (detectors.has("successful-after-fail") || detectors.has("post-compromise")) {
    return "confirmed";
  }
  if (detectors.has("new-admin-source")) return "high";
  // Several independent detectors, or the same source on several routers, is
  // corroboration; one noisy detector on one box is not.
  if (detectors.size >= 3 || deviceCount >= 3) return "high";
  if (detectors.size >= 2 || deviceCount >= 2) return "medium";
  return "low";
}

/** The sentence. Ordered by the kill chain, so it reads as a progression. */
function narrate(source: string, signals: Signal[], devices: string[]): string {
  const byStage = [...signals].sort(
    (a, b) => STAGE_ORDER.indexOf(STAGE_OF[a.detector]) - STAGE_ORDER.indexOf(STAGE_OF[b.detector]),
  );
  const where =
    devices.length === 1
      ? `on ${devices[0]}`
      : `across ${devices.length} devices (${devices.join(", ")})`;
  const who = source === "" ? "An unattributed change" : source;
  const parts = byStage.map((s) => s.summary);
  return `${who} ${where}: ${parts.join("; then ")}.`;
}

/**
 * Group signals into incidents.
 *
 * `windowMs` bounds how long a quiet source stays part of the same incident;
 * `dayBucketMs` decides when a persistent attacker rolls into a fresh incident
 * rather than one that grows forever.
 */
export function correlate(
  signals: Signal[],
  options: { now: number; dayBucketMs?: number } = { now: Date.now() },
): Incident[] {
  const bucketMs = options.dayBucketMs ?? 86_400_000;
  const groups = new Map<string, Signal[]>();

  for (const signal of signals) {
    // Bucket by the signal's own time, so replaying an old window rebuilds the
    // incident it belonged to instead of folding it into today.
    const bucket = Math.floor(signal.firstTs / bucketMs);
    const key = `${signal.source}|${bucket}`;
    const list = groups.get(key);
    if (list) list.push(signal);
    else groups.set(key, [signal]);
  }

  const incidents: Incident[] = [];
  for (const [key, group] of groups) {
    const source = group[0].source;
    const bucket = Number(key.slice(key.lastIndexOf("|") + 1));
    const devices = [...new Set(group.map((s) => s.device))].sort();
    const detectors = new Set(group.map((s) => s.detector));
    const stage = furthest(group.map((s) => STAGE_OF[s.detector]));
    const confidence = confidenceOf(detectors, devices.length);

    incidents.push({
      id: incidentId(source, bucket),
      source,
      devices,
      stage,
      confidence,
      severity: worst(group.map((s) => s.severity)),
      firstTs: Math.min(...group.map((s) => s.firstTs)),
      lastTs: Math.max(...group.map((s) => s.lastTs)),
      detectors: [...detectors].sort(),
      narrative: narrate(source, group, devices),
      recommendations: [...detectors]
        .sort((a, b) => STAGE_ORDER.indexOf(STAGE_OF[b]) - STAGE_ORDER.indexOf(STAGE_OF[a]))
        .map((d) => RECOMMENDATION[d]),
      evidence: group
        .flatMap((s) => s.evidence)
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
        .slice(0, 100),
      // An incident whose every signal is spoofable can never be auto-actioned.
      spoofableOnly: group.every((s) => s.spoofable),
      signalCount: group.length,
    });
  }

  return incidents.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.lastTs - a.lastTs ||
      a.id.localeCompare(b.id),
  );
}

/** Merge a freshly-correlated incident into a stored one of the same id. */
export function mergeIncident(stored: Incident, fresh: Incident): Incident {
  const detectors = [...new Set([...stored.detectors, ...fresh.detectors])].sort();
  const devices = [...new Set([...stored.devices, ...fresh.devices])].sort();
  const detectorSet = new Set(detectors);
  return {
    ...fresh,
    devices,
    detectors,
    // An incident only ever escalates: an attacker who got in yesterday did not
    // un-get-in because today's poll only saw scanning.
    stage: furthest([stored.stage, fresh.stage]),
    confidence: confidenceOf(detectorSet, devices.length),
    severity: worst([stored.severity, fresh.severity]),
    firstTs: Math.min(stored.firstTs, fresh.firstTs),
    lastTs: Math.max(stored.lastTs, fresh.lastTs),
    evidence: [...stored.evidence, ...fresh.evidence]
      .filter(
        (e, i, all) =>
          all.findIndex(
            (o) => o.ts === e.ts && o.message === e.message && o.device === e.device,
          ) === i,
      )
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
      .slice(-100),
    spoofableOnly: stored.spoofableOnly && fresh.spoofableOnly,
    signalCount: stored.signalCount + fresh.signalCount,
  };
}
