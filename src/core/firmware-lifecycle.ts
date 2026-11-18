/**
 * Firmware lifecycle engine — pure analysis, zero device I/O.
 *
 * Parses RouterOS version strings, compares installed vs. available firmware,
 * evaluates upgrade readiness, captures health snapshots for pre/post checks,
 * and renders human-readable status and upgrade reports.
 *
 * The tool layer (`src/tools/firmware-lifecycle.ts`) handles all device
 * interaction; this module stays import-free of `connector.ts` so it's testable
 * without a live device.
 */
import { parseSize } from "./routeros-parse";

// ── Version parsing ─────────────────────────────────────────────────────────

/** Parsed RouterOS version: `7.16.2` → { major: 7, minor: 16, patch: 2, raw: "7.16.2" } */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Suffix like "beta3", "rc1", "testing" — empty for stable releases. */
  suffix: string;
  /** The original unparsed string. */
  raw: string;
}

/**
 * Parse a RouterOS version string.
 *
 * Handles: `7.16.2`, `6.49.17`, `7.17beta3`, `7.17rc1`, `7.16.2 (stable)`.
 * Returns `null` for unparseable input.
 */
export function parseVersion(raw: string | undefined): ParsedVersion | null {
  if (!raw) return null;
  // Strip "(stable)" etc. by position, and refuse an over-long string, so no
  // pattern can backtrack on hostile input from a device.
  const paren = raw.indexOf("(");
  const cleaned = (paren >= 0 ? raw.slice(0, paren) : raw).trim();
  if (cleaned.length > 64) return null;
  const m = cleaned.match(/^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] != null ? Number(m[3]) : 0,
    suffix: (m[4] ?? "").replace(/^[.-]/, "").trim(),
    raw: cleaned,
  };
}

/**
 * Compare two versions. Returns:
 * - negative if `a < b` (a is older)
 * - positive if `a > b` (a is newer)
 * - `0` if equal
 *
 * Suffixed versions (beta/rc) sort before the same clean version:
 * `7.17beta3 < 7.17rc1 < 7.17`
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // No suffix = release → sorts higher than any suffixed pre-release
  if (!a.suffix && b.suffix) return 1;
  if (a.suffix && !b.suffix) return -1;
  return a.suffix.localeCompare(b.suffix);
}

/** True when `available` is strictly newer than `current`. */
export function isUpgradeAvailable(
  current: ParsedVersion | null,
  available: ParsedVersion | null,
): boolean {
  if (!current || !available) return false;
  return compareVersions(available, current) > 0;
}

// ── Update channel ──────────────────────────────────────────────────────────

export type UpdateChannel = "stable" | "long-term" | "testing";

export const UPDATE_CHANNELS: UpdateChannel[] = ["stable", "long-term", "testing"];

// ── Device firmware state ───────────────────────────────────────────────────

export interface PackageInfo {
  name: string;
  version: string;
  disabled: boolean;
}

export interface RouterboardInfo {
  model: string;
  serialNumber: string;
  currentFirmware: string;
  upgradeFirmware: string;
  /** True when routerboard firmware can be upgraded. */
  firmwareUpgradeAvailable: boolean;
}

export interface UpdateInfo {
  channel: string;
  installedVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export interface FirmwareState {
  /** RouterOS version from `/system resource print`. */
  rosVersion: string;
  /** Board architecture (e.g. "arm", "tile", "x86", "mipsbe"). */
  architecture: string;
  /** Board name (e.g. "RB4011iGS+"). */
  boardName: string;
  /** System uptime string. */
  uptime: string;
  /** CPU load percentage. */
  cpuLoad: string;
  /** Free/total memory. */
  freeMemory: string;
  totalMemory: string;
  /** Installed packages. */
  packages: PackageInfo[];
  /** RouterBOARD hardware info (null if not a routerboard device). */
  routerboard: RouterboardInfo | null;
  /** Update check result (null if check failed/skipped). */
  updateInfo: UpdateInfo | null;
}

// ── Health snapshot (pre/post upgrade comparison) ───────────────────────────

export interface HealthSnapshot {
  timestamp: string;
  version: string;
  uptime: string;
  cpuLoad: string;
  freeMemory: string;
  totalMemory: string;
  /** Count of active routes. */
  routeCount: number;
  /** Count of active interfaces (running state). */
  activeInterfaces: number;
  /** Total interfaces. */
  totalInterfaces: number;
  /** System health sensor readings (raw text). */
  healthSensors: string;
  /** Active PPP sessions count. */
  pppSessions: number;
  /** Active DHCP leases count. */
  dhcpLeases: number;
}

/** Compare pre and post health snapshots, return a diff report. */
export function compareHealthSnapshots(pre: HealthSnapshot, post: HealthSnapshot): HealthDiff {
  const issues: string[] = [];
  const improvements: string[] = [];
  const neutral: string[] = [];

  // Version change
  if (pre.version !== post.version) {
    improvements.push(`RouterOS version: ${pre.version} → ${post.version}`);
  } else {
    neutral.push(`RouterOS version unchanged: ${post.version}`);
  }

  // Interface count
  if (post.activeInterfaces < pre.activeInterfaces) {
    issues.push(
      `Active interfaces dropped: ${pre.activeInterfaces} → ${post.activeInterfaces} ` +
        `(of ${post.totalInterfaces} total)`,
    );
  } else if (post.activeInterfaces > pre.activeInterfaces) {
    improvements.push(`Active interfaces: ${pre.activeInterfaces} → ${post.activeInterfaces}`);
  }

  // Route count — allow ±10% tolerance
  const routeDelta = post.routeCount - pre.routeCount;
  const routeThreshold = Math.max(1, Math.round(pre.routeCount * 0.1));
  if (routeDelta < -routeThreshold) {
    issues.push(`Route count dropped: ${pre.routeCount} → ${post.routeCount}`);
  } else if (Math.abs(routeDelta) <= routeThreshold) {
    neutral.push(`Route count stable: ${pre.routeCount} → ${post.routeCount}`);
  }

  // PPP sessions
  if (post.pppSessions < pre.pppSessions) {
    issues.push(`PPP sessions dropped: ${pre.pppSessions} → ${post.pppSessions}`);
  }

  // DHCP leases — informational only
  if (post.dhcpLeases !== pre.dhcpLeases) {
    neutral.push(`DHCP leases: ${pre.dhcpLeases} → ${post.dhcpLeases}`);
  }

  const healthy = issues.length === 0;

  return { healthy, issues, improvements, neutral, pre, post };
}

export interface HealthDiff {
  healthy: boolean;
  issues: string[];
  improvements: string[];
  neutral: string[];
  pre: HealthSnapshot;
  post: HealthSnapshot;
}

// ── Upgrade readiness assessment ────────────────────────────────────────────

export type ReadinessLevel = "ready" | "caution" | "blocked";

export interface ReadinessCheck {
  label: string;
  status: ReadinessLevel;
  detail?: string;
}

/** Assess whether a device is ready to upgrade. */
export function assessUpgradeReadiness(state: FirmwareState): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  // 1. Is an update available?
  if (!state.updateInfo) {
    checks.push({
      label: "Update availability",
      status: "blocked",
      detail: "Could not check for updates — run firmware_check first",
    });
  } else if (!state.updateInfo.updateAvailable) {
    checks.push({
      label: "Update availability",
      status: "blocked",
      detail: `Already running latest version (${state.updateInfo.installedVersion}) on ${state.updateInfo.channel} channel`,
    });
  } else {
    checks.push({
      label: "Update availability",
      status: "ready",
      detail: `${state.updateInfo.installedVersion} → ${state.updateInfo.latestVersion} (${state.updateInfo.channel})`,
    });
  }

  // 2. CPU load — warn if high
  const cpuNum = Number.parseInt(state.cpuLoad, 10);
  if (!Number.isNaN(cpuNum) && cpuNum > 80) {
    checks.push({
      label: "CPU load",
      status: "caution",
      detail: `CPU at ${cpuNum}% — consider upgrading during low-traffic period`,
    });
  } else {
    checks.push({
      label: "CPU load",
      status: "ready",
      detail: `${state.cpuLoad}`,
    });
  }

  // 3. Memory — warn if < 20% free
  const free = parseSize(state.freeMemory) ?? 0;
  const total = parseSize(state.totalMemory) ?? 0;
  if (free > 0 && total > 0) {
    const pct = Math.round((free / total) * 100);
    if (pct < 20) {
      checks.push({
        label: "Free memory",
        status: "caution",
        detail: `Only ${pct}% free (${state.freeMemory} of ${state.totalMemory}) — upgrade may need more`,
      });
    } else {
      checks.push({
        label: "Free memory",
        status: "ready",
        detail: `${pct}% free (${state.freeMemory} of ${state.totalMemory})`,
      });
    }
  }

  // 4. Major version jump?
  if (state.updateInfo?.updateAvailable) {
    const cur = parseVersion(state.updateInfo.installedVersion);
    const avail = parseVersion(state.updateInfo.latestVersion);
    if (cur && avail && avail.major > cur.major) {
      checks.push({
        label: "Major version jump",
        status: "caution",
        detail: `Crossing major version boundary (${cur.major}.x → ${avail.major}.x) — review release notes and backup first`,
      });
    }
  }

  // 5. RouterBOARD firmware
  if (state.routerboard?.firmwareUpgradeAvailable) {
    checks.push({
      label: "RouterBOARD firmware",
      status: "caution",
      detail: `Board firmware also upgradable: ${state.routerboard.currentFirmware} → ${state.routerboard.upgradeFirmware}`,
    });
  }

  return checks;
}

// ── Report renderers ────────────────────────────────────────────────────────

/** Render a single-device firmware status report. */
export function renderFirmwareStatus(state: FirmwareState, device: string): string {
  const lines: string[] = [];

  lines.push(`FIRMWARE STATUS — ${device}`);
  lines.push("");

  // Current version
  lines.push("── SYSTEM ─────────────────────────────────────────────────────");
  lines.push(`  RouterOS version:  ${state.rosVersion}`);
  lines.push(`  Architecture:      ${state.architecture}`);
  lines.push(`  Board:             ${state.boardName}`);
  lines.push(`  Uptime:            ${state.uptime}`);
  lines.push(`  CPU load:          ${state.cpuLoad}`);
  lines.push(`  Memory:            ${state.freeMemory} free / ${state.totalMemory} total`);

  // RouterBOARD
  if (state.routerboard) {
    lines.push("");
    lines.push("── ROUTERBOARD ────────────────────────────────────────────────");
    lines.push(`  Model:             ${state.routerboard.model}`);
    lines.push(`  Serial:            ${state.routerboard.serialNumber}`);
    lines.push(`  Current firmware:  ${state.routerboard.currentFirmware}`);
    lines.push(`  Upgrade firmware:  ${state.routerboard.upgradeFirmware}`);
    if (state.routerboard.firmwareUpgradeAvailable) {
      lines.push(`  ⚠ Board firmware upgrade available`);
    }
  }

  // Update status
  if (state.updateInfo) {
    lines.push("");
    lines.push("── UPDATE STATUS ──────────────────────────────────────────────");
    lines.push(`  Channel:           ${state.updateInfo.channel}`);
    lines.push(`  Installed:         ${state.updateInfo.installedVersion}`);
    lines.push(`  Latest:            ${state.updateInfo.latestVersion}`);
    lines.push(
      `  Status:            ${state.updateInfo.updateAvailable ? "UPDATE AVAILABLE" : "Up to date"}`,
    );
  }

  // Packages
  if (state.packages.length > 0) {
    lines.push("");
    lines.push("── PACKAGES ───────────────────────────────────────────────────");
    for (const pkg of state.packages) {
      const flag = pkg.disabled ? " (disabled)" : "";
      lines.push(`  ${pkg.name.padEnd(24)} ${pkg.version}${flag}`);
    }
  }

  return lines.join("\n");
}

/** Render a fleet firmware check report. */
export function renderFleetFirmwareCheck(
  devices: { name: string; state: FirmwareState | null; error?: string }[],
): string {
  const lines: string[] = [];

  lines.push("╔═══════════════════════════════════════════════════════════════╗");
  lines.push("║               FLEET FIRMWARE STATUS REPORT                  ║");
  lines.push("╚═══════════════════════════════════════════════════════════════╝");
  lines.push("");

  // Summary table
  let upToDate = 0;
  let needsUpdate = 0;
  let errors = 0;
  const outdated: { name: string; current: string; available: string; channel: string }[] = [];

  for (const d of devices) {
    if (d.error || !d.state) {
      errors++;
      continue;
    }
    if (d.state.updateInfo?.updateAvailable) {
      needsUpdate++;
      outdated.push({
        name: d.name,
        current: d.state.updateInfo.installedVersion,
        available: d.state.updateInfo.latestVersion,
        channel: d.state.updateInfo.channel,
      });
    } else {
      upToDate++;
    }
  }

  lines.push("── SUMMARY ────────────────────────────────────────────────────");
  lines.push(`  Devices checked:   ${devices.length}`);
  lines.push(`  Up to date:        ${upToDate}`);
  lines.push(`  Needs update:      ${needsUpdate}`);
  if (errors > 0) lines.push(`  Errors:            ${errors}`);
  lines.push("");

  // Per-device table
  lines.push("── DEVICE STATUS ──────────────────────────────────────────────");
  for (const d of devices) {
    if (d.error) {
      lines.push(`  ${d.name.padEnd(20)} ERROR  ${d.error}`);
      continue;
    }
    if (!d.state) {
      lines.push(`  ${d.name.padEnd(20)} ERROR  No data`);
      continue;
    }
    const ver = d.state.rosVersion;
    if (d.state.updateInfo?.updateAvailable) {
      lines.push(
        `  ${d.name.padEnd(20)} ${ver.padEnd(12)} → ${d.state.updateInfo.latestVersion.padEnd(12)} ` +
          `[${d.state.updateInfo.channel}]`,
      );
    } else {
      lines.push(`  ${d.name.padEnd(20)} ${ver.padEnd(12)}    (up to date)`);
    }
  }

  // Outdated devices detail
  if (outdated.length > 0) {
    lines.push("");
    lines.push("── UPGRADE CANDIDATES ─────────────────────────────────────────");
    for (const d of outdated) {
      lines.push(`  ${d.name}: ${d.current} → ${d.available} (${d.channel})`);
    }
    lines.push("");
    lines.push("Use `firmware_stage` to download packages, then `firmware_upgrade` to apply.");
  }

  return lines.join("\n");
}

/** Render a health snapshot in human-readable form. */
export function renderHealthSnapshot(snap: HealthSnapshot, label: string): string {
  const lines: string[] = [];
  lines.push(`── ${label} ──`);
  lines.push(`  Timestamp:         ${snap.timestamp}`);
  lines.push(`  Version:           ${snap.version}`);
  lines.push(`  Uptime:            ${snap.uptime}`);
  lines.push(`  CPU load:          ${snap.cpuLoad}`);
  lines.push(`  Memory:            ${snap.freeMemory} free / ${snap.totalMemory} total`);
  lines.push(`  Routes:            ${snap.routeCount}`);
  lines.push(
    `  Interfaces:        ${snap.activeInterfaces} active / ${snap.totalInterfaces} total`,
  );
  lines.push(`  PPP sessions:      ${snap.pppSessions}`);
  lines.push(`  DHCP leases:       ${snap.dhcpLeases}`);
  return lines.join("\n");
}

/** Render a health diff report. */
export function renderHealthDiff(diff: HealthDiff): string {
  const lines: string[] = [];
  const verdict = diff.healthy ? "HEALTHY" : "ISSUES DETECTED";
  lines.push(`POST-UPGRADE HEALTH CHECK — ${verdict}`);
  lines.push("");

  if (diff.improvements.length > 0) {
    lines.push("  Improvements:");
    for (const i of diff.improvements) lines.push(`    + ${i}`);
  }
  if (diff.issues.length > 0) {
    lines.push("  Issues:");
    for (const i of diff.issues) lines.push(`    ! ${i}`);
  }
  if (diff.neutral.length > 0) {
    lines.push("  Unchanged:");
    for (const n of diff.neutral) lines.push(`    - ${n}`);
  }
  return lines.join("\n");
}

/** Render the readiness assessment. */
export function renderReadiness(checks: ReadinessCheck[]): string {
  const lines: string[] = [];
  const blocked = checks.some((c) => c.status === "blocked");
  const caution = checks.some((c) => c.status === "caution");
  const verdict = blocked ? "BLOCKED" : caution ? "PROCEED WITH CAUTION" : "READY";

  lines.push(`UPGRADE READINESS: ${verdict}`);
  lines.push("");

  for (const c of checks) {
    const icon = c.status === "ready" ? "OK  " : c.status === "caution" ? "WARN" : "STOP";
    lines.push(`  ${icon}  ${c.label}`);
    if (c.detail) lines.push(`        ${c.detail}`);
  }

  return lines.join("\n");
}
