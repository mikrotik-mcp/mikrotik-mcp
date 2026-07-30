/**
 * Log events → attack signals. PURE, no I/O, `now` is always a parameter.
 *
 * Each detector states three things in code, not in a comment: its threshold,
 * whether its evidence is **spoofable**, and what it does when its input source
 * is absent. That last one matters most — a detector that quietly finds nothing
 * because logging was never enabled reports a calm network, which is the most
 * dangerous output this module could produce. Those say `unavailable` and name
 * the one-line fix instead.
 *
 * Nothing here decides to block anything. Signals are evidence; `respond.ts`
 * decides, and only after the guards in `docs/tasks/11` §4.
 */
import type { LogEvent } from "./parse";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const DETECTOR_IDS = [
  "brute-force",
  "credential-spray",
  "successful-after-fail",
  "new-admin-source",
  "port-scan",
  "firewall-drop-storm",
  "service-exposure-hit",
  "post-compromise",
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

/** One log line kept as proof, so a finding can always show its work. */
export interface Evidence {
  ts: number | null;
  device: string;
  message: string;
  detector: DetectorId;
}

export interface Signal {
  detector: DetectorId;
  device: string;
  /** The attacker's address, and the key everything groups by. */
  source: string;
  firstTs: number;
  lastTs: number;
  /** How many pieces of evidence support it. */
  count: number;
  severity: Severity;
  /**
   * True when the evidence is a source address that can be forged.
   *
   * `respond.ts` refuses to act on these regardless of configuration: a flood
   * with forged sources would otherwise turn the responder into a weapon
   * pointed at whoever the attacker names.
   */
  spoofable: boolean;
  summary: string;
  evidence: Evidence[];
  users?: string[];
  apps?: string[];
}

/** A detector that could not run, and the single thing that would fix it. */
export interface Unavailable {
  detector: DetectorId;
  reason: string;
  fix?: string;
}

export interface DetectorConfig {
  bruteForce: { failures: number; windowMs: number };
  credentialSpray: { users: number; windowMs: number };
  successAfterFail: { windowMs: number };
  dropStorm: { drops: number; windowMs: number };
  serviceExposure: { managementPorts: number[] };
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  bruteForce: { failures: 10, windowMs: 5 * 60_000 },
  credentialSpray: { users: 3, windowMs: 10 * 60_000 },
  successAfterFail: { windowMs: 15 * 60_000 },
  dropStorm: { drops: 100, windowMs: 5 * 60_000 },
  // Winbox, SSH, API, API-SSL, telnet, FTP, HTTP, HTTPS.
  serviceExposure: { managementPorts: [8291, 22, 8728, 8729, 23, 21, 80, 443] },
};

/**
 * A config change observed on the device.
 *
 * NOT taken from the log: RouterOS does not audit configuration changes to the
 * log by default, which was confirmed against a live device — the `system` topic
 * carries account events only. The real source is Drift Guard
 * (`config_check_drift`), which already computes exactly this against the golden
 * baseline. When no drift input is supplied the detector reports itself
 * unavailable rather than reporting a clean device.
 */
export interface ConfigChange {
  /** Menu path, e.g. `/user` or `/ip/service`. */
  section: string;
  /** What changed, in the reader's words. */
  detail: string;
  ts?: number;
  /** True when this server made the change — then it is not a compromise. */
  byThisServer?: boolean;
}

export interface DetectionInput {
  device: string;
  events: LogEvent[];
  now: number;
  /** Addresses the on-device `detect-portscan` list has tagged. */
  scanList?: string[];
  /** Config changes from Drift Guard; absent means the detector cannot run. */
  configChanges?: ConfigChange[];
  /** Sources that authenticated successfully during the learning window. */
  baseline?: { sources: string[]; ready: boolean };
  /** Addresses that are the operator's own — never evidence of an attack. */
  trusted?: string[];
  config?: DetectorConfig;
}

export interface DetectionResult {
  signals: Signal[];
  unavailable: Unavailable[];
  /** Events with no readable clock, which no windowed detector can use. */
  clocklessEvents: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Sections whose change means someone established a foothold. */
const SENSITIVE_SECTIONS = [
  "/user",
  "/user/ssh-keys",
  "/ip/service",
  "/system/scheduler",
  "/system/script",
  "/ip/firewall/filter",
  "/ip/firewall/nat",
  "/tool/romon",
  "/ip/socks",
];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** RFC1918, loopback, link-local, CGNAT, and IPv6 loopback/ULA. */
const PRIVATE =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd])/i;

/** True for a routable public address — the only kind an outsider comes from. */
export function isPublicSource(address: string): boolean {
  if (address === "") return false;
  if (PRIVATE.test(address)) return false;
  return IPV4.test(address) || address.includes(":");
}

/**
 * The largest number of timestamps falling inside any `windowMs` slice.
 *
 * A plain "count in the last N minutes" would miss a burst that ended just
 * before the poll — which is exactly when an attacker stops because they got in.
 */
export function maxInWindow(sorted: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end] - sorted[start] > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

function evidenceOf(events: LogEvent[], detector: DetectorId, limit = 20): Evidence[] {
  return events.slice(0, limit).map((e) => ({
    ts: e.ts,
    device: e.device,
    message: e.message,
    detector,
  }));
}

function bounds(events: LogEvent[], now: number): { firstTs: number; lastTs: number } {
  const stamps = events.map((e) => e.ts).filter((t): t is number => t !== null);
  return {
    firstTs: stamps.length > 0 ? Math.min(...stamps) : now,
    lastTs: stamps.length > 0 ? Math.max(...stamps) : now,
  };
}

/** Group events by their source address, skipping those without one. */
function bySource(events: LogEvent[]): Map<string, LogEvent[]> {
  const map = new Map<string, LogEvent[]>();
  for (const event of events) {
    if (!event.source) continue;
    const list = map.get(event.source);
    if (list) list.push(event);
    else map.set(event.source, [event]);
  }
  return map;
}

// ── Firewall log lines ──────────────────────────────────────────────────────

export interface FirewallHit {
  prefix: string;
  inInterface?: string;
  protocol?: string;
  src?: string;
  srcPort?: number;
  dst?: string;
  dstPort?: number;
}

// `out:(unknown 0)` contains a SPACE inside the parentheses, so the out-interface
// must be read up to the comma rather than as a non-space run.
const FW_RE =
  /^([\w-]*):\s*in:(\S*)\s+out:([^,]*),\s*(?:connection-state:\S*[,\s]\s*)?proto\s+([^,(]+?)\s*(?:\([^)]*\))?,\s*(\S+?):(\d+)->(\S+?):(\d+)/i;

/**
 * A `log=yes` firewall rule's line.
 *
 * `input: in:ether1 out:(unknown 0), proto TCP (SYN), 203.0.113.90:51222->192.0.2.1:8291, len 60`
 *
 * Returns null for anything else — the caller must never assume a shape.
 */
export function parseFirewallLog(message: string): FirewallHit | null {
  const m = message.match(FW_RE);
  if (!m) return null;
  return {
    prefix: m[1],
    inInterface: m[2] || undefined,
    protocol: m[4],
    src: m[5],
    srcPort: Number(m[6]),
    dst: m[7],
    dstPort: Number(m[8]),
  };
}

// ── Detectors ───────────────────────────────────────────────────────────────

/**
 * Run every detector.
 *
 * Ordering within the result is stable (detector, then source) so two runs over
 * the same window produce the same signals — the incident ids downstream depend
 * on it.
 */
export function runDetectors(input: DetectionInput): DetectionResult {
  const cfg = input.config ?? DEFAULT_DETECTOR_CONFIG;
  const trusted = new Set(input.trusted ?? []);
  const signals: Signal[] = [];
  const unavailable: Unavailable[] = [];

  const usable = input.events.filter((e) => !e.source || !trusted.has(e.source));
  const clocklessEvents = usable.filter((e) => e.ts === null).length;
  const timed = usable.filter((e) => e.ts !== null);

  const failures = timed.filter((e) => e.outcome === "failure");
  const successes = timed.filter((e) => e.outcome === "success");

  // ── brute-force ─────────────────────────────────────────────────────────
  for (const [source, events] of bySource(failures)) {
    const stamps = events.map((e) => e.ts as number).sort((a, b) => a - b);
    const peak = maxInWindow(stamps, cfg.bruteForce.windowMs);
    if (peak < cfg.bruteForce.failures) continue;
    const { firstTs, lastTs } = bounds(events, input.now);
    signals.push({
      detector: "brute-force",
      device: input.device,
      source,
      firstTs,
      lastTs,
      count: events.length,
      severity: peak >= cfg.bruteForce.failures * 5 ? "high" : "medium",
      spoofable: false,
      summary: `${peak} failed logins within ${Math.round(cfg.bruteForce.windowMs / 60_000)} min (${events.length} total)`,
      evidence: evidenceOf(events, "brute-force"),
      users: [...new Set(events.map((e) => e.user).filter((u): u is string => !!u))],
      apps: [...new Set(events.map((e) => e.app).filter((a): a is string => !!a))],
    });
  }

  // ── credential-spray ────────────────────────────────────────────────────
  for (const [source, events] of bySource(failures)) {
    const recent = events.filter(
      (e) => (e.ts as number) >= input.now - cfg.credentialSpray.windowMs,
    );
    const users = [...new Set(recent.map((e) => e.user).filter((u): u is string => !!u))];
    if (users.length < cfg.credentialSpray.users) continue;
    const { firstTs, lastTs } = bounds(recent, input.now);
    signals.push({
      detector: "credential-spray",
      device: input.device,
      source,
      firstTs,
      lastTs,
      count: recent.length,
      severity: "medium",
      spoofable: false,
      summary: `tried ${users.length} different usernames: ${users.slice(0, 6).join(", ")}`,
      evidence: evidenceOf(recent, "credential-spray"),
      users,
      apps: [...new Set(recent.map((e) => e.app).filter((a): a is string => !!a))],
    });
  }

  // ── successful-after-fail ───────────────────────────────────────────────
  // The one that matters. Never auto-responds; it pages a human.
  const failuresBySource = bySource(failures);
  for (const [source, hits] of bySource(successes)) {
    const priorFailures = failuresBySource.get(source) ?? [];
    for (const hit of hits) {
      const near = priorFailures.filter(
        (f) =>
          (f.ts as number) <= (hit.ts as number) &&
          (hit.ts as number) - (f.ts as number) <= cfg.successAfterFail.windowMs,
      );
      if (near.length === 0) continue;
      signals.push({
        detector: "successful-after-fail",
        device: input.device,
        source,
        firstTs: Math.min(...near.map((f) => f.ts as number)),
        lastTs: hit.ts as number,
        count: near.length + 1,
        severity: "critical",
        spoofable: false,
        summary: `logged in as ${hit.user ?? "?"} after ${near.length} failed attempt(s) — treat this device as compromised until proven otherwise`,
        evidence: evidenceOf([...near, hit], "successful-after-fail"),
        users: [hit.user].filter((u): u is string => !!u),
        apps: [hit.app].filter((a): a is string => !!a),
      });
      break;
    }
  }

  // ── new-admin-source ────────────────────────────────────────────────────
  if (!input.baseline || !input.baseline.ready) {
    unavailable.push({
      detector: "new-admin-source",
      reason: "still learning which sources normally administer this device",
      fix: "no action needed — it becomes available once the learning window has data",
    });
  } else {
    const known = new Set(input.baseline.sources);
    for (const [source, hits] of bySource(successes)) {
      if (!isPublicSource(source) || known.has(source)) continue;
      const { firstTs, lastTs } = bounds(hits, input.now);
      signals.push({
        detector: "new-admin-source",
        device: input.device,
        source,
        firstTs,
        lastTs,
        count: hits.length,
        severity: "high",
        spoofable: false,
        summary: `first successful login from this public address as ${hits[0].user ?? "?"}`,
        evidence: evidenceOf(hits, "new-admin-source"),
        users: [...new Set(hits.map((e) => e.user).filter((u): u is string => !!u))],
        apps: [...new Set(hits.map((e) => e.app).filter((a): a is string => !!a))],
      });
    }
  }

  // ── port-scan (on-device detection; we only read its verdict) ───────────
  if (input.scanList === undefined) {
    unavailable.push({
      detector: "port-scan",
      reason: "the on-device port-scan address list was not read",
      fix: "run add_port_scan_detection_rules to install the detect-portscan signatures",
    });
  } else {
    for (const source of input.scanList) {
      if (trusted.has(source)) continue;
      signals.push({
        detector: "port-scan",
        device: input.device,
        source,
        firstTs: input.now,
        lastTs: input.now,
        count: 1,
        severity: "low",
        spoofable: false,
        summary: "tagged by the device's own port-scan signatures",
        evidence: [
          {
            ts: input.now,
            device: input.device,
            message: `address-list membership: detect-portscan contains ${source}`,
            detector: "port-scan",
          },
        ],
      });
    }
  }

  // ── firewall lines: drop storm + service exposure ────────────────────────
  const firewallEvents = timed
    .map((e) => ({ event: e, hit: parseFirewallLog(e.message) }))
    .filter((x): x is { event: LogEvent; hit: FirewallHit } => x.hit !== null);

  if (firewallEvents.length === 0) {
    unavailable.push({
      detector: "firewall-drop-storm",
      reason: "no firewall rule on this device logs its hits",
      fix: "set `log=yes log-prefix=drop` on the rules you want visibility into",
    });
    unavailable.push({
      detector: "service-exposure-hit",
      reason: "no firewall rule on this device logs its hits",
      fix: "set `log=yes` on the input-chain rules that accept management traffic",
    });
  } else {
    const drops = new Map<string, LogEvent[]>();
    for (const { event, hit } of firewallEvents) {
      const src = hit.src;
      if (!src || trusted.has(src)) continue;
      const list = drops.get(src);
      if (list) list.push(event);
      else drops.set(src, [event]);
    }

    for (const [source, events] of drops) {
      const stamps = events.map((e) => e.ts as number).sort((a, b) => a - b);
      if (maxInWindow(stamps, cfg.dropStorm.windowMs) < cfg.dropStorm.drops) continue;
      const { firstTs, lastTs } = bounds(events, input.now);
      signals.push({
        detector: "firewall-drop-storm",
        device: input.device,
        source,
        firstTs,
        lastTs,
        count: events.length,
        severity: "medium",
        // A flood's source address is whatever the attacker wrote in the packet.
        spoofable: true,
        summary: `${events.length} logged firewall hits — volume, but the source may be forged`,
        evidence: evidenceOf(events, "firewall-drop-storm"),
      });
    }

    for (const { event, hit } of firewallEvents) {
      const src = hit.src;
      if (!src || trusted.has(src) || !isPublicSource(src)) continue;
      if (hit.dstPort === undefined || !cfg.serviceExposure.managementPorts.includes(hit.dstPort)) {
        continue;
      }
      signals.push({
        detector: "service-exposure-hit",
        device: input.device,
        source: src,
        firstTs: event.ts as number,
        lastTs: event.ts as number,
        count: 1,
        severity: "high",
        spoofable: false,
        summary: `reached management port ${hit.dstPort} from the internet via ${hit.inInterface ?? "?"}`,
        evidence: evidenceOf([event], "service-exposure-hit"),
      });
    }
  }

  // ── post-compromise ─────────────────────────────────────────────────────
  if (input.configChanges === undefined) {
    unavailable.push({
      detector: "post-compromise",
      reason: "no configuration-change source — RouterOS does not audit changes to the log",
      fix: "set a Drift Guard baseline with config_set_baseline so changes can be detected",
    });
  } else {
    // A change this server made is a change someone asked for, not a foothold.
    const suspicious = input.configChanges.filter(
      (c) => !c.byThisServer && SENSITIVE_SECTIONS.some((s) => c.section.startsWith(s)),
    );
    if (suspicious.length > 0) {
      signals.push({
        detector: "post-compromise",
        device: input.device,
        // No attacker address: the change is the evidence, not a connection.
        source: "",
        firstTs: Math.min(...suspicious.map((c) => c.ts ?? input.now)),
        lastTs: Math.max(...suspicious.map((c) => c.ts ?? input.now)),
        count: suspicious.length,
        severity: "critical",
        spoofable: false,
        summary: `${suspicious.length} unexplained change(s) to security-relevant configuration: ${suspicious
          .map((c) => c.section)
          .slice(0, 4)
          .join(", ")}`,
        evidence: suspicious.slice(0, 20).map((c) => ({
          ts: c.ts ?? null,
          device: input.device,
          message: `${c.section}: ${c.detail}`,
          detector: "post-compromise" as const,
        })),
      });
    }
  }

  signals.sort((a, b) => a.detector.localeCompare(b.detector) || a.source.localeCompare(b.source));
  unavailable.sort((a, b) => a.detector.localeCompare(b.detector));
  return { signals, unavailable, clocklessEvents };
}
