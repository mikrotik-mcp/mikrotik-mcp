/**
 * CAPsMAN Orchestrator engine — pure analysis, zero device I/O.
 *
 * Consumes an already-fetched {@link CapsmanState} (the tool layer in
 * `src/tools/capsman.ts` does the fetching via `src/utils/wifi-query.ts`) and
 * produces:
 *   • a floor/zone model (explicit tags + signal-inferred adjacency — plan §3),
 *   • coverage / co-channel findings + a proposed manual channel plan (§4.A),
 *   • weak-signal client findings with a best-neighbor recommendation (§4.B),
 *   • a resource-aware load model + rebalance plan (§4.C),
 *   • FT (802.11r) and HA roam/redundancy audits (§4.D),
 *   • one merged, severity-ranked report ({@link runCapsmanAudit}).
 *
 * Kept import-free of `connector.ts` so it's unit-tested without a live device,
 * mirroring `security-hardening.ts` / `port-scan-detection.ts`. Every finding
 * carries `finding_id`/`severity`/`confidence`; steering/balance actions are
 * ADVISORY (RouterOS has no force-move primitive — plan §1), so anything that
 * depends on client behaviour is `needs_live_verification`, never `proven`.
 */
import { quoted } from "./routeros";

// ── Result types ────────────────────────────────────────────────────────────

export type Confidence = "proven" | "needs_live_verification";
export type Severity = "critical" | "high" | "medium" | "low";
export type CapsmanCategory = "coverage" | "weak_signal" | "load" | "ft" | "ha";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface CapsmanFinding {
  finding_id: string;
  category: CapsmanCategory;
  severity: Severity;
  confidence: Confidence;
  title: string;
  /** The radio / CAP / client / config the finding is about. */
  target: string;
  detail: string;
  /** Proposed action (advisory). */
  recommendation: string;
}

export interface CapsmanReport {
  findings: CapsmanFinding[];
  summary: Record<Severity, number>;
  total: number;
}

// ── Device state (populated by the tool layer) ──────────────────────────────

export type Band = "2ghz" | "5ghz" | "unknown";

/** One radio on a managed CAP, as seen from the manager. */
export interface CapRadio {
  /** CAP identity/name (e.g. "AP-F3-E"). */
  cap: string;
  /** Radio/interface name on the manager (e.g. "cap-2ghz-1"). Unique key. */
  radioId: string;
  band: Band;
  /** Channel/frequency (number: MHz like 2412/5180, or a small channel index). */
  channel?: number;
  width?: string;
  txPower?: number;
  clientCount: number;
  /** Parsed floor/zone from the CAP identity or a comment tag (may be absent). */
  floor?: string;
  zone?: string;
  /** Owning CAP resources (percent 0–100), when the tool could read them. */
  cpuLoad?: number;
  memUsedPct?: number;
}

/** One associated client, merged from every CAP's registration-table. */
export interface WifiClient {
  mac: string;
  /** Radio it is currently associated to (a `CapRadio.radioId`). */
  radioId: string;
  /** Signal on the current radio, dBm (negative; higher = stronger). */
  signal: number;
  band: Band;
  txRate?: string;
  rxRate?: string;
  uptime?: string;
  /**
   * Signal (dBm) this client's MAC is ALSO seen at on other radios — the raw
   * material for adjacency + the best-neighbor recommendation. Keyed by radioId.
   * Absent/empty when the client is only visible on its current radio.
   */
  seenOn?: Record<string, number>;
}

/** One SSID/security configuration relevant to the FT audit. */
export interface WifiSecurityConfig {
  name: string;
  ssid?: string;
  /** 802.11r fast-transition enabled. */
  ft?: boolean;
  ftOverDs?: boolean;
  /** Mobility domain id (must match across all CAPs for seamless FT). */
  ftMobilityDomain?: string;
  /** 802.11k neighbor reports. */
  rrm?: boolean;
  /** 802.11v BSS transition. */
  wnm?: boolean;
}

export interface CapsmanState {
  /** True when a CAPsMAN manager is enabled on this device. */
  managerEnabled: boolean;
  /** Count of configured managers reachable by the CAPs (1 = no HA). */
  managerCount: number;
  /** True when CAPs are configured to fail over to a backup manager. */
  capsHaveBackupManager: boolean;
  /** True when the manager requires peer certificates (HA hardening). */
  requirePeerCertificate: boolean;
  radios: CapRadio[];
  clients: WifiClient[];
  securityConfigs: WifiSecurityConfig[];
  /** Existing access-list entries — for idempotency of steer/load-balance writes. */
  accessList: WifiAccessListEntry[];
  /** The resolved wifi command family for this device (write-command prefix). */
  path: WifiPathLike;
}

/** The command-path family (kept as a string union so tests need no util import). */
export type WifiPathLike =
  | "/interface wifi"
  | "/interface wifiwave2"
  | "/interface wireless"
  | "/caps-man";

/** One existing access-list row (subset we care about for idempotency). */
export interface WifiAccessListEntry {
  macAddress?: string;
  interface?: string;
  comment?: string;
}

/** An empty state — every slice absent. Handy for tests and partial audits. */
export function emptyCapsmanState(): CapsmanState {
  return {
    managerEnabled: false,
    managerCount: 0,
    capsHaveBackupManager: false,
    requirePeerCertificate: false,
    radios: [],
    clients: [],
    securityConfigs: [],
    accessList: [],
    path: "/interface wifi",
  };
}

// ── Tunables ────────────────────────────────────────────────────────────────

/** Default weak-signal threshold (dBm). A client below this should be steered. */
export const DEFAULT_WEAK_DBM = -70;
/** A neighbor radio must beat the current one by at least this (dB) to recommend it. */
export const MIN_STEER_GAIN_DB = 8;
/** Per-radio client count above which a radio is "overloaded". */
export const OVERLOAD_CLIENTS = 25;
/** CPU load (%) above which a CAP is resource-constrained. */
export const CPU_CONSTRAINED_PCT = 80;

// ── Floor / zone model (plan §3: A explicit tag + C signal adjacency) ────────

/**
 * Parse a floor/zone from a CAP identity or comment tag. Supports:
 *   • identity convention `AP-F3-E` / `ap_f3_east` → floor "3", zone "E"/"east"
 *   • an explicit `floor=3 zone=east` key run (from a comment).
 * Returns `{}` when nothing parses — the engine then leans on signal adjacency.
 */
export function parseFloorTag(text: string | undefined): { floor?: string; zone?: string } {
  if (!text) return {};
  const kvFloor = text.match(/floor\s*[=:]\s*([\w-]+)/i)?.[1];
  const kvZone = text.match(/zone\s*[=:]\s*([\w-]+)/i)?.[1];
  if (kvFloor || kvZone) return { floor: kvFloor, zone: kvZone };
  // Identity convention: an `F<digit>` (floor) and an optional trailing zone token.
  const f = text.match(/\bF(\d{1,2})\b/i) ?? text.match(/floor[-_]?(\d{1,2})/i);
  const z = text.match(/\b(?:F\d{1,2}|floor[-_]?\d{1,2})[-_]([A-Za-z]+)\b/i);
  const out: { floor?: string; zone?: string } = {};
  if (f) out.floor = f[1];
  if (z) out.zone = z[1];
  return out;
}

/**
 * Physical-adjacency graph between radios, inferred from clients that are visible
 * on more than one radio: if many clients on radio A are also seen (at a decent
 * signal) on radio B, A and B are physically adjacent. Returns, per radio, the
 * set of adjacent radioIds. Symmetric.
 */
export function buildAdjacency(clients: WifiClient[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const c of clients) {
    if (!c.seenOn) continue;
    for (const [other, sig] of Object.entries(c.seenOn)) {
      // Only count a neighbor the client can actually hear (not noise floor).
      if (other !== c.radioId && sig > -85) link(c.radioId, other);
    }
  }
  return adj;
}

/** Index radios by their radioId for O(1) lookup. */
function radioIndex(radios: CapRadio[]): Map<string, CapRadio> {
  return new Map(radios.map((r) => [r.radioId, r]));
}

/** Map a RouterOS frequency/channel to a band when the band field is unknown. */
export function bandOf(radio: CapRadio): Band {
  if (radio.band !== "unknown") return radio.band;
  const ch = radio.channel ?? 0;
  if (ch >= 5000 || (ch >= 36 && ch <= 177)) return "5ghz";
  if ((ch >= 2400 && ch <= 2500) || (ch >= 1 && ch <= 14)) return "2ghz";
  return "unknown";
}

// ── §4.A Coverage / co-channel ───────────────────────────────────────────────

/** Non-overlapping 2.4 GHz channels (the only three that don't overlap). */
export const CLEAN_24_CHANNELS = [1, 6, 11];

function auditCoverage(state: CapsmanState): CapsmanFinding[] {
  const findings: CapsmanFinding[] = [];
  const adj = buildAdjacency(state.clients);
  const byId = radioIndex(state.radios);

  // Co-channel: two ADJACENT radios on the same band + same channel interfere.
  const seenPairs = new Set<string>();
  for (const r of state.radios) {
    const neighbors = adj.get(r.radioId);
    if (!neighbors) continue;
    for (const nId of neighbors) {
      const n = byId.get(nId);
      if (!n) continue;
      if (bandOf(r) !== bandOf(n) || r.channel == null || r.channel !== n.channel) continue;
      const key = [r.radioId, nId].sort().join("|");
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      findings.push({
        finding_id: `cochannel:${key}`,
        category: "coverage",
        severity: "high",
        confidence: "proven",
        title: `Co-channel overlap on ${bandOf(r)} channel ${r.channel}`,
        target: `${r.cap}/${r.radioId} ↔ ${n.cap}/${n.radioId}`,
        detail:
          `Adjacent radios ${r.cap} and ${n.cap} both use ${bandOf(r)} channel ${r.channel}; ` +
          "clients in the overlap contend for the same airtime, cutting throughput.",
        recommendation:
          bandOf(r) === "2ghz"
            ? `Move one radio to a non-overlapping 2.4 GHz channel (${CLEAN_24_CHANNELS.join("/")}).`
            : "Assign the two radios different 5 GHz channels (DFS-aware).",
      });
    }
  }
  return findings;
}

/**
 * Propose a non-overlapping manual channel plan: greedily assign each adjacent
 * 2.4 GHz radio a clean channel (1/6/11) different from its already-assigned
 * neighbors. Returns `radioId → channel`. (5 GHz has many non-overlapping
 * channels; a simple round-robin over adjacency avoids collisions there.)
 */
export function proposeChannelPlan(state: CapsmanState): Map<string, number> {
  const adj = buildAdjacency(state.clients);
  const plan = new Map<string, number>();
  const order = [...state.radios].sort((a, b) => b.clientCount - a.clientCount);
  for (const r of order) {
    const band = bandOf(r);
    const palette = band === "2ghz" ? CLEAN_24_CHANNELS : [36, 40, 44, 48, 149, 153, 157, 161];
    const used = new Set<number>();
    for (const nId of adj.get(r.radioId) ?? []) {
      const nc = plan.get(nId);
      if (nc != null) used.add(nc);
    }
    plan.set(r.radioId, palette.find((c) => !used.has(c)) ?? palette[0]);
  }
  return plan;
}

/**
 * Convert a Wi-Fi channel number to its centre frequency (MHz), which is what
 * RouterOS's `channel.frequency` wants. 2.4 GHz: 2407 + n·5 (ch1=2412 … ch11=2462);
 * 5 GHz: 5000 + n·5 (ch36=5180 … ch161=5805). Returns null for an unknown mapping.
 */
export function channelToFrequencyMhz(channel: number, band: Band): number | null {
  if (band === "2ghz") return channel >= 1 && channel <= 14 ? 2407 + channel * 5 : channel;
  if (band === "5ghz") return channel >= 36 && channel <= 177 ? 5000 + channel * 5 : channel;
  return null;
}

/**
 * Build the write commands to apply the proposed manual channel plan. v7
 * `/interface wifi` only — the frequency is set on each provisioned radio
 * interface. Skips radios already on the proposed channel (idempotent) and radios
 * not in `onlyRadioIds` (when given). Returns `[]` for a legacy `/caps-man` device
 * (its channels live in named channel objects the tool can't map 1:1 — the audit
 * still surfaces the plan for a manual edit).
 */
export function buildChannelPlanCommands(
  state: CapsmanState,
  onlyRadioIds?: Set<string>,
): string[] {
  if (state.path === "/caps-man") return [];
  const plan = proposeChannelPlan(state);
  const byId = radioIndex(state.radios);
  const cmds: string[] = [];
  for (const [radioId, ch] of plan) {
    if (onlyRadioIds && !onlyRadioIds.has(radioId)) continue;
    const radio = byId.get(radioId);
    if (!radio || radio.channel === ch) continue; // already on target → no-op
    const freq = channelToFrequencyMhz(ch, bandOf(radio));
    if (freq == null) continue;
    cmds.push(`${state.path} set [find name=${quoted(radioId)}] channel.frequency=${freq}`);
  }
  return cmds;
}

// ── §4.B Weak-signal clients + best-neighbor recommendation ──────────────────

export interface WeakClient {
  mac: string;
  currentRadio: string;
  currentCap: string;
  signal: number;
  band: Band;
  /** Best neighbor radio to steer toward, or null when none is meaningfully better. */
  recommendRadioId?: string;
  recommendCap?: string;
  gainDb?: number;
}

/** Compute weak clients and their best-neighbor steer target. Pure. */
export function reportWeakClients(state: CapsmanState, weakDbm = DEFAULT_WEAK_DBM): WeakClient[] {
  const byId = radioIndex(state.radios);
  const out: WeakClient[] = [];
  for (const c of state.clients) {
    if (c.signal >= weakDbm) continue;
    const cur = byId.get(c.radioId);
    let bestId: string | undefined;
    let bestSig = c.signal;
    for (const [rid, sig] of Object.entries(c.seenOn ?? {})) {
      if (rid === c.radioId) continue;
      if (sig > bestSig) {
        bestSig = sig;
        bestId = rid;
      }
    }
    const gain = bestId ? bestSig - c.signal : 0;
    const rec = bestId && gain >= MIN_STEER_GAIN_DB ? byId.get(bestId) : undefined;
    out.push({
      mac: c.mac,
      currentRadio: c.radioId,
      currentCap: cur?.cap ?? "?",
      signal: c.signal,
      band: c.band,
      recommendRadioId: rec ? rec.radioId : undefined,
      recommendCap: rec ? rec.cap : undefined,
      gainDb: rec ? gain : undefined,
    });
  }
  return out.sort((a, b) => a.signal - b.signal);
}

function auditWeakSignal(state: CapsmanState, weakDbm = DEFAULT_WEAK_DBM): CapsmanFinding[] {
  return reportWeakClients(state, weakDbm).map((w) => ({
    finding_id: `weak:${w.mac}`,
    category: "weak_signal",
    severity: w.signal < weakDbm - 15 ? "high" : "medium",
    // Steering depends on the client obeying the hint → never "proven".
    confidence: "needs_live_verification",
    title: `Weak client ${w.mac} at ${w.signal} dBm on ${w.currentCap}`,
    target: `${w.mac} @ ${w.currentCap}/${w.currentRadio}`,
    detail: `Client signal ${w.signal} dBm is below the ${weakDbm} dBm threshold${
      w.recommendCap
        ? `; it sees ${w.recommendCap} ~${w.gainDb} dB stronger.`
        : "; no neighbor radio hears it meaningfully better (coverage gap here)."
    }`,
    recommendation: w.recommendCap
      ? `Steer ${w.mac} toward ${w.recommendCap} (soft 802.11k/v, or hard signal-range).`
      : "Coverage hole — add/relocate an AP or raise tx-power; steering won't help.",
  }));
}

// ── §4.C Resource-aware load ─────────────────────────────────────────────────

interface RadioLoad {
  radio: CapRadio;
  overloaded: boolean;
  cpuConstrained: boolean;
}

function loadModel(state: CapsmanState): RadioLoad[] {
  return state.radios.map((radio) => ({
    radio,
    overloaded: radio.clientCount > OVERLOAD_CLIENTS,
    cpuConstrained: (radio.cpuLoad ?? 0) > CPU_CONSTRAINED_PCT,
  }));
}

function auditLoad(state: CapsmanState): CapsmanFinding[] {
  const findings: CapsmanFinding[] = [];
  const adj = buildAdjacency(state.clients);
  const byId = radioIndex(state.radios);
  const loads = loadModel(state);

  for (const l of loads) {
    if (!l.overloaded && !l.cpuConstrained) continue;
    // Find an adjacent radio with spare capacity to offload toward.
    let target: CapRadio | undefined;
    for (const nId of adj.get(l.radio.radioId) ?? []) {
      const n = byId.get(nId);
      if (!n) continue;
      if (n.clientCount < OVERLOAD_CLIENTS && (n.cpuLoad ?? 0) < CPU_CONSTRAINED_PCT) {
        if (!target || n.clientCount < target.clientCount) target = n;
      }
    }
    const why = l.cpuConstrained
      ? `CAP CPU at ${l.radio.cpuLoad}% (>${CPU_CONSTRAINED_PCT}%)`
      : `${l.radio.clientCount} clients (>${OVERLOAD_CLIENTS})`;
    findings.push({
      finding_id: `load:${l.radio.radioId}`,
      category: "load",
      severity: l.cpuConstrained ? "high" : "medium",
      confidence: "needs_live_verification",
      title: `Overloaded radio ${l.radio.cap}/${l.radio.radioId}`,
      target: `${l.radio.cap}/${l.radio.radioId}`,
      detail: `${why}.${target ? ` Neighbor ${target.cap} has spare capacity.` : ""}`,
      recommendation: target
        ? `Rebalance some clients toward ${target.cap}; steer dual-band clients to 5 GHz.`
        : "No adjacent radio has spare capacity — the whole zone is saturated; add an AP.",
    });
  }
  return findings;
}

// ── §4.D FT (802.11r) + HA ───────────────────────────────────────────────────

function auditFt(state: CapsmanState): CapsmanFinding[] {
  const findings: CapsmanFinding[] = [];
  if (state.securityConfigs.length === 0) return findings;

  for (const c of state.securityConfigs) {
    if (!c.ft) {
      findings.push({
        finding_id: `ft-off:${c.name}`,
        category: "ft",
        severity: "medium",
        confidence: "proven",
        title: `802.11r fast-transition off on "${c.ssid ?? c.name}"`,
        target: c.name,
        detail:
          "Without FT, roaming re-does the full auth handshake — a visible stall for VoIP/video as people move between floors.",
        recommendation:
          "Enable ft + a shared ft-mobility-domain across all CAPs, and 802.11k/v steering.",
      });
    }
    if (c.ft && (!c.rrm || !c.wnm)) {
      findings.push({
        finding_id: `ft-nosteer:${c.name}`,
        category: "ft",
        severity: "low",
        confidence: "proven",
        title: `FT on but 802.11k/v steering incomplete on "${c.ssid ?? c.name}"`,
        target: c.name,
        detail: `rrm(k)=${c.rrm ? "on" : "off"}, wnm(v)=${c.wnm ? "on" : "off"} — clients get no neighbor hints to roam early.`,
        recommendation:
          "Enable both rrm (802.11k) and wnm (802.11v) so clients roam before the signal collapses.",
      });
    }
  }

  // Mobility-domain consistency: every FT-enabled config should share ONE domain.
  const domains = new Set(
    state.securityConfigs.filter((c) => c.ft && c.ftMobilityDomain).map((c) => c.ftMobilityDomain),
  );
  if (domains.size > 1) {
    findings.push({
      finding_id: "ft-domain-mismatch",
      category: "ft",
      severity: "high",
      confidence: "proven",
      title: "Inconsistent FT mobility domains across CAPs",
      target: [...domains].join(", "),
      detail: `Found ${domains.size} distinct ft-mobility-domain values — fast roaming only works WITHIN a domain, so clients still do a full handshake crossing the boundary.`,
      recommendation: "Set the SAME ft-mobility-domain on every CAP that shares an SSID.",
    });
  }
  return findings;
}

function auditHa(state: CapsmanState): CapsmanFinding[] {
  const findings: CapsmanFinding[] = [];
  if (!state.managerEnabled) return findings; // not a controller → HA N/A

  if (state.managerCount < 2 || !state.capsHaveBackupManager) {
    findings.push({
      finding_id: "ha-single-manager",
      category: "ha",
      severity: "high",
      confidence: "proven",
      title: "CAPsMAN has no backup manager (single point of failure)",
      target: "capsman manager",
      detail:
        "Only one manager is configured / the CAPs aren't pointed at a backup. If it reboots or the link drops, every AP in the building goes dark.",
      recommendation:
        "Stand up a second manager and point the CAPs at both (caps-man-addresses / discovery), cert-based.",
    });
  }
  if ((state.managerCount >= 2 || state.capsHaveBackupManager) && !state.requirePeerCertificate) {
    findings.push({
      finding_id: "ha-no-cert",
      category: "ha",
      severity: "medium",
      confidence: "proven",
      title: "CAPsMAN HA without peer-certificate enforcement",
      target: "capsman manager",
      detail:
        "A backup manager exists but require-peer-certificate is off — a rogue manager could adopt your CAPs.",
      recommendation: "Enable require-peer-certificate and provision CA/manager certificates.",
    });
  }
  return findings;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface AuditOptions {
  categories?: CapsmanCategory[];
  weakDbm?: number;
}

/** Run the requested category audits (default: all) into one ranked report. */
export function runCapsmanAudit(state: CapsmanState, opts: AuditOptions = {}): CapsmanReport {
  const want = new Set(
    opts.categories ?? (["coverage", "weak_signal", "load", "ft", "ha"] as const),
  );
  const findings: CapsmanFinding[] = [];
  if (want.has("coverage")) findings.push(...auditCoverage(state));
  if (want.has("weak_signal"))
    findings.push(...auditWeakSignal(state, opts.weakDbm ?? DEFAULT_WEAK_DBM));
  if (want.has("load")) findings.push(...auditLoad(state));
  if (want.has("ft")) findings.push(...auditFt(state));
  if (want.has("ha")) findings.push(...auditHa(state));

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.category.localeCompare(b.category) ||
      a.finding_id.localeCompare(b.finding_id),
  );
  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity]++;
  return { findings, summary, total: findings.length };
}

// ── Phase 2: steering + load-balance write plans (advisory mechanisms) ───────
//
// RouterOS has no force-move. "Hard" steering = an access-list entry that REJECTS
// a client on its current (weak) radio when its signal is in a low band, so it
// re-associates on a neighbor it hears stronger. "Soft" = 802.11k/v hints only
// (enabled per-config in the FT phase), so a soft steer here is a no-op write set
// plus guidance. Every rule is comment-tagged for idempotency + later removal.

/** Comment prefix on every steer access-list rule. */
export const STEER_TAG = "capsman-steer";
/** Comment prefix on every load-balance access-list rule. */
export const LB_TAG = "capsman-lb";

export type SteerMode = "soft" | "hard";

/** The access-list menu for a device's wifi family. */
export function accessListMenu(path: WifiPathLike): string {
  return path === "/caps-man" ? "/caps-man access-list" : `${path} access-list`;
}

/** True when a steer rule for this MAC already exists (idempotency). */
export function steerAlreadyPresent(state: CapsmanState, mac: string): boolean {
  const tag = `${STEER_TAG}: ${mac.toLowerCase()}`;
  return state.accessList.some(
    (e) =>
      (e.comment ?? "").toLowerCase().includes(tag) ||
      ((e.macAddress ?? "").toLowerCase() === mac.toLowerCase() &&
        (e.comment ?? "").toLowerCase().includes(STEER_TAG)),
  );
}

/**
 * Build the write commands to steer one client. `hard` adds a signal-range reject
 * on the current radio; `soft` returns no writes (the k/v nudge is a config-level
 * setting handled by the FT tools) — the tool reports it as advisory-only.
 * `rejectAbove` is the dBm ceiling of the reject band (default the weak threshold).
 */
export function buildSteerCommands(
  state: CapsmanState,
  mac: string,
  currentRadio: string,
  mode: SteerMode,
  rejectAbove = DEFAULT_WEAK_DBM,
): string[] {
  if (mode === "soft") return [];
  const menu = accessListMenu(state.path);
  // Reject the client on the weak radio for signals from noise floor up to the
  // threshold, forcing it to try a neighbor. `place-before=0` so it wins.
  return [
    `${menu} add mac-address=${mac} interface=${currentRadio} ` +
      `signal-range=-120..${rejectAbove} action=reject ` +
      `comment="${STEER_TAG}: ${mac}" place-before=0`,
  ];
}

export interface LoadBalancePlanItem {
  radioId: string;
  cap: string;
  targetRadioId: string;
  targetCap: string;
}

/**
 * A resource-aware rebalance plan: for each overloaded/constrained radio that has
 * an adjacent radio with spare capacity, propose offloading toward it. Pure.
 */
export function loadBalancePlan(state: CapsmanState): LoadBalancePlanItem[] {
  const adj = buildAdjacency(state.clients);
  const byId = radioIndex(state.radios);
  const out: LoadBalancePlanItem[] = [];
  for (const r of state.radios) {
    const overloaded = r.clientCount > OVERLOAD_CLIENTS || (r.cpuLoad ?? 0) > CPU_CONSTRAINED_PCT;
    if (!overloaded) continue;
    let target: CapRadio | undefined;
    for (const nId of adj.get(r.radioId) ?? []) {
      const n = byId.get(nId);
      if (!n) continue;
      if (n.clientCount < OVERLOAD_CLIENTS && (n.cpuLoad ?? 0) < CPU_CONSTRAINED_PCT) {
        if (!target || n.clientCount < target.clientCount) target = n;
      }
    }
    if (target)
      out.push({
        radioId: r.radioId,
        cap: r.cap,
        targetRadioId: target.radioId,
        targetCap: target.cap,
      });
  }
  return out;
}

/** True when a load-balance rule for this radio already exists (idempotency). */
export function loadBalanceAlreadyPresent(state: CapsmanState, radioId: string): boolean {
  const tag = `${LB_TAG}: ${radioId}`;
  return state.accessList.some((e) => (e.comment ?? "").includes(tag));
}

/**
 * Build the write commands for a load-balance plan. For each overloaded radio, add
 * a connect-priority penalty on that radio so NEW clients prefer the idle neighbor
 * (a gentle, non-disconnecting nudge). Comment-tagged, idempotent, place-before=0.
 */
export function buildLoadBalanceCommands(
  state: CapsmanState,
  plan: LoadBalancePlanItem[],
): string[] {
  const menu = accessListMenu(state.path);
  const cmds: string[] = [];
  for (const item of plan) {
    if (loadBalanceAlreadyPresent(state, item.radioId)) continue;
    cmds.push(
      `${menu} add interface=${item.radioId} action=accept connect-priority=0 ` +
        `comment="${LB_TAG}: ${item.radioId} → ${item.targetRadioId}" place-before=0`,
    );
  }
  return cmds;
}

// ── Phase 4: enable 802.11r FT with a shared mobility domain ─────────────────

/** The security menu for a device's wifi family (FT lives here). */
export function securityMenu(path: WifiPathLike): string {
  return path === "/caps-man" ? "/caps-man security" : `${path} security`;
}

/**
 * Choose the mobility domain to converge on: an explicit override, else the first
 * existing non-empty `ft-mobility-domain` across configs (so we adopt the admin's
 * value), else a stable default. All FT-enabled configs must share ONE domain for
 * seamless roaming.
 */
export function resolveMobilityDomain(state: CapsmanState, override?: string): string {
  if (override) return override;
  const existing = state.securityConfigs.find((c) => c.ftMobilityDomain)?.ftMobilityDomain;
  return existing ?? "0001";
}

/**
 * Build the write commands to enable 802.11r fast-transition on the selected
 * security configs (all, or only `configNames`), converging every one on a single
 * `ft-mobility-domain`. Skips a config already at `ft=yes` with that domain
 * (idempotent). Fixes the `ft-off` and `ft-domain-mismatch` audit findings.
 */
export function buildFtCommands(
  state: CapsmanState,
  opts: { configNames?: string[]; mobilityDomain?: string } = {},
): string[] {
  const menu = securityMenu(state.path);
  const domain = resolveMobilityDomain(state, opts.mobilityDomain);
  const want = opts.configNames ? new Set(opts.configNames) : null;
  const cmds: string[] = [];
  for (const c of state.securityConfigs) {
    if (want && !want.has(c.name)) continue;
    if (c.ft && c.ftMobilityDomain === domain) continue; // already correct → no-op
    cmds.push(
      `${menu} set [find name=${quoted(c.name)}] ft=yes ft-over-ds=yes ft-mobility-domain=${domain}`,
    );
  }
  return cmds;
}

// ── Phase 5: HA setup + the fix-dispatch orchestrator ────────────────────────

/** The manager menu for a device's wifi family. */
export function managerMenu(path: WifiPathLike): string {
  return path === "/caps-man" ? "/caps-man manager" : `${path} capsman`;
}

/**
 * Build the manager-side HA commands this device can safely apply: enable
 * `require-peer-certificate` so a rogue manager can't adopt the CAPs. Standing up
 * the SECOND manager and pointing every CAP at both is inherently multi-device
 * (the backup manager + each CAP), so those steps are returned as guidance by
 * {@link haGuidance}, not auto-applied here. Idempotent.
 */
export function buildHaCommands(
  state: CapsmanState,
  opts: { requireCert?: boolean } = {},
): string[] {
  const cmds: string[] = [];
  if ((opts.requireCert ?? true) && !state.requirePeerCertificate) {
    cmds.push(`${managerMenu(state.path)} set require-peer-certificate=yes`);
  }
  return cmds;
}

/** The manual, multi-device HA steps this single-device tool can't perform. */
export function haGuidance(state: CapsmanState, backupAddress?: string): string[] {
  const g = [
    "Stand up a SECOND manager (a spare RouterOS box or a CHR) with the same CA/manager certificate.",
    backupAddress
      ? `On EVERY CAP, point it at both managers: /interface wifi cap set caps-man-addresses=<primary>,${backupAddress}`
      : "On EVERY CAP, add the backup manager to its caps-man-addresses (or discovery-interfaces) so it fails over.",
    "Provision the backup with an identical configuration/provisioning set so a failover is seamless.",
  ];
  if (!state.requirePeerCertificate) {
    g.unshift(
      "(This tool can enable require-peer-certificate on THIS manager — see the applied commands.)",
    );
  }
  return g;
}

/** Safe apply order across categories (coverage/channel first, HA last). */
const FIX_ORDER: CapsmanCategory[] = ["coverage", "load", "weak_signal", "ft", "ha"];

/**
 * Map one audit `finding_id` to the commands that remediate it, using the pure
 * builders. Returns `[]` for a finding with no automated fix (or already fixed).
 * The `finding_id` prefix identifies the category:
 *   cochannel:* → channel plan   load:* → load balance   weak:* → steer
 *   ft-*        → enable FT       ha-*  → HA require-cert
 */
export function fixCommandsForFinding(state: CapsmanState, findingId: string): string[] {
  if (findingId.startsWith("cochannel:")) return buildChannelPlanCommands(state);
  if (findingId.startsWith("load:")) return buildLoadBalanceCommands(state, loadBalancePlan(state));
  if (findingId.startsWith("weak:")) {
    const mac = findingId.slice("weak:".length);
    const client = state.clients.find((c) => c.mac === mac);
    return client ? buildSteerCommands(state, mac, client.radioId, "hard") : [];
  }
  if (findingId.startsWith("ft-")) return buildFtCommands(state);
  if (findingId.startsWith("ha-")) return buildHaCommands(state);
  return [];
}

/** Category of a finding_id, for safe-ordering the fixes. */
function categoryOfFinding(findingId: string): CapsmanCategory {
  if (findingId.startsWith("cochannel:")) return "coverage";
  if (findingId.startsWith("load:")) return "load";
  if (findingId.startsWith("weak:")) return "weak_signal";
  if (findingId.startsWith("ft-")) return "ft";
  return "ha";
}

/**
 * Build the ordered, de-duplicated command list to apply a set of finding_ids in
 * a SAFE order (coverage/channel → load → steer → FT → HA). Pure — the tool wraps
 * the result in one snapshot + one Safe-Mode session.
 */
export function buildFixPlan(state: CapsmanState, findingIds: string[]): string[] {
  const ordered = [...findingIds].sort(
    (a, b) => FIX_ORDER.indexOf(categoryOfFinding(a)) - FIX_ORDER.indexOf(categoryOfFinding(b)),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ordered) {
    for (const cmd of fixCommandsForFinding(state, id)) {
      if (!seen.has(cmd)) {
        seen.add(cmd);
        out.push(cmd);
      }
    }
  }
  return out;
}

// ── Dashboard payload (structured, for the CAPsMAN page) ─────────────────────

export interface CapsmanOverview {
  managerEnabled: boolean;
  managerCount: number;
  capsHaveBackupManager: boolean;
  requirePeerCertificate: boolean;
  radios: (CapRadio & { adjacent: string[]; conflicts: string[] })[];
  /** Co-channel radio pairs (radioId ↔ radioId) for the heatmap's red edges. */
  cochannel: [string, string][];
  proposedChannels: Record<string, number>;
  bandSplit: { "2ghz": number; "5ghz": number; unknown: number };
  totals: { radios: number; clients: number; caps: number };
}

/** Structured overview for the dashboard heatmap/load board. Pure. */
export function capsmanOverview(state: CapsmanState): CapsmanOverview {
  const adj = buildAdjacency(state.clients);
  const byId = radioIndex(state.radios);
  const cochannel: [string, string][] = [];
  const seen = new Set<string>();
  const radios = state.radios.map((r) => {
    const neighbors = [...(adj.get(r.radioId) ?? [])];
    const conflicts: string[] = [];
    for (const nId of neighbors) {
      const n = byId.get(nId);
      if (!n) continue;
      if (bandOf(r) === bandOf(n) && r.channel != null && r.channel === n.channel) {
        conflicts.push(nId);
        const key = [r.radioId, nId].sort().join("|");
        if (!seen.has(key)) {
          seen.add(key);
          cochannel.push([r.radioId, nId]);
        }
      }
    }
    return { ...r, adjacent: neighbors, conflicts };
  });
  const bandSplit = { "2ghz": 0, "5ghz": 0, unknown: 0 } as Record<Band, number>;
  for (const c of state.clients) bandSplit[c.band] += 1;
  const caps = new Set(state.radios.map((r) => r.cap)).size;
  return {
    managerEnabled: state.managerEnabled,
    managerCount: state.managerCount,
    capsHaveBackupManager: state.capsHaveBackupManager,
    requirePeerCertificate: state.requirePeerCertificate,
    radios,
    cochannel,
    proposedChannels: Object.fromEntries(proposeChannelPlan(state)),
    bandSplit,
    totals: { radios: state.radios.length, clients: state.clients.length, caps },
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const SEV_TAG: Record<Severity, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED ",
  low: "LOW ",
};

/** Plain-text report for text-only hosts. */
export function renderCapsmanReport(report: CapsmanReport, device: string): string {
  const head =
    `CAPsMAN AUDIT — ${device}\n` +
    `${report.total} finding(s): ${report.summary.critical} critical, ${report.summary.high} high, ` +
    `${report.summary.medium} medium, ${report.summary.low} low`;
  if (report.total === 0) return `${head}\n\nNo findings — Wi-Fi fabric looks healthy. ✓`;
  const body = report.findings
    .map((f, i) => {
      return (
        `${i + 1}. [${SEV_TAG[f.severity]}] ${f.title}\n` +
        `   id=${f.finding_id}  category=${f.category}  confidence=${f.confidence}\n` +
        `   target : ${f.target}\n` +
        `   detail : ${f.detail}\n` +
        `   suggest: ${f.recommendation}`
      );
    })
    .join("\n\n");
  return `${head}\n\n${body}`;
}
