/**
 * Device capability model and requirement predicates.
 *
 * RouterOS is not one platform. `/interface wifi` (v7 wifiwave2), `/interface
 * wireless` (legacy) and `/caps-man` are mutually exclusive per device;
 * `/container` needs both a package and device-mode permission; PoE and switch
 * menus depend on the board, not the OS. Today a tool discovers all of this by
 * running and failing — `commandUnsupported()` reads the parser error *after*
 * the round-trip, and the model often burns two more calls reacting to it.
 *
 * This module is the **pure** half: the shape of what was probed, and whether a
 * tool's declared `requires` is satisfied by it. `capability-probe.ts` does the
 * I/O; `registry.ts` consults the result.
 *
 * Version parsing deliberately reuses `parseVersion`/`compareVersions` from
 * `firmware-lifecycle.ts` rather than defining a second comparator — two version
 * orderings in one codebase drift apart, and that one already handles
 * `7.17beta3`, `7.16.2 (stable)` and absent patch numbers.
 */
import { compareVersions, parseVersion } from "./firmware-lifecycle";
import type { ParsedVersion } from "./firmware-lifecycle";

/** Which wireless stack a device actually answers on. */
export type WirelessStack = "wifi" | "wireless" | "capsman-legacy" | "none";

/** RouterOS release channel, from the version suffix or `/system package update`. */
export type ReleaseChannel = "stable" | "long-term" | "testing" | "development" | "unknown";

/** What one probe learned about a device. */
export interface Capabilities {
  version: ParsedVersion | null;
  channel: ReleaseChannel;
  board: string;
  arch: string;
  isRouterBoard: boolean;
  /** Enabled packages only — a disabled package cannot serve its menu. */
  packages: Set<string>;
  wirelessStack: WirelessStack;
  /** RouterOS 7.13+ device-mode permissions; all true when the menu is absent. */
  deviceMode: { container: boolean; scheduler: boolean; fetch: boolean };
  probedAt: number;
}

/**
 * What a tool needs from the device. Every field is optional and ANDed; an
 * absent `requires` means universally available, which is true of the large
 * majority of the catalog.
 */
export interface ToolRequires {
  /** Inclusive lower bound, e.g. `"7.13"`. */
  minVersion?: string;
  /** Exclusive upper bound, for menus removed in a later release. */
  maxVersion?: string;
  /** Every named package must be installed AND enabled. */
  packages?: string[];
  /** The device must answer on one of these wireless stacks. */
  wirelessStack?: WirelessStack | WirelessStack[];
  /** Board-name test, e.g. `/^CRS3/` for a switch-chip-only menu. */
  board?: RegExp;
  /** A device-mode permission that must be granted. */
  deviceMode?: "container" | "scheduler" | "fetch";
  /** The device must be a RouterBOARD (excludes CHR and x86). */
  routerBoard?: boolean;
}

/** An empty model, used before a probe has run or when one failed entirely. */
export function unknownCapabilities(): Capabilities {
  return {
    version: null,
    channel: "unknown",
    board: "",
    arch: "",
    isRouterBoard: false,
    packages: new Set(),
    wirelessStack: "none",
    // Absent device-mode menu (pre-7.13) means unrestricted, not forbidden.
    deviceMode: { container: true, scheduler: true, fetch: true },
    probedAt: 0,
  };
}

/**
 * Every reason `requires` is not met by `caps`, as human sentences. Empty array
 * means satisfied.
 *
 * **An unknown capability never blocks.** When the probe could not determine
 * something (no version, no board), the corresponding check passes rather than
 * failing closed: refusing to run a tool because we could not probe would be a
 * worse failure than letting RouterOS answer for itself. The probe is an
 * optimisation, not an authority.
 */
export function unmetReasons(caps: Capabilities, requires: ToolRequires | undefined): string[] {
  if (!requires) return [];
  const out: string[] = [];

  if (requires.minVersion && caps.version) {
    const min = parseVersion(requires.minVersion);
    if (min && compareVersions(caps.version, min) < 0) {
      out.push(`needs RouterOS ≥ ${requires.minVersion} (device runs ${caps.version.raw})`);
    }
  }
  if (requires.maxVersion && caps.version) {
    const max = parseVersion(requires.maxVersion);
    if (max && compareVersions(caps.version, max) >= 0) {
      out.push(`removed in RouterOS ${requires.maxVersion} (device runs ${caps.version.raw})`);
    }
  }

  if (requires.packages?.length && caps.probedAt > 0) {
    const missing = requires.packages.filter((p) => !caps.packages.has(p));
    if (missing.length > 0) {
      out.push(
        `needs the ${missing.map((p) => `\`${p}\``).join(", ")} package${missing.length > 1 ? "s" : ""} installed and enabled`,
      );
    }
  }

  if (requires.wirelessStack && caps.wirelessStack !== "none") {
    const want = Array.isArray(requires.wirelessStack)
      ? requires.wirelessStack
      : [requires.wirelessStack];
    if (!want.includes(caps.wirelessStack)) {
      out.push(`needs the ${want.join(" or ")} wireless stack (device uses ${caps.wirelessStack})`);
    }
  }

  if (requires.board && caps.board && !requires.board.test(caps.board)) {
    out.push(`not supported on this board (${caps.board})`);
  }

  if (requires.routerBoard === true && caps.probedAt > 0 && !caps.isRouterBoard) {
    out.push("needs a RouterBOARD device (this is not one)");
  }

  if (requires.deviceMode && !caps.deviceMode[requires.deviceMode]) {
    out.push(
      `needs device-mode \`${requires.deviceMode}\` enabled (change it with a physical reset-button confirmation)`,
    );
  }

  return out;
}

/** True when the device satisfies every declared requirement. */
export function satisfies(caps: Capabilities, requires: ToolRequires | undefined): boolean {
  return unmetReasons(caps, requires).length === 0;
}

/**
 * One-line reason a tool is unavailable, for a description prefix or an error.
 * Returns `""` when the requirement is satisfied.
 */
export function explainUnmet(caps: Capabilities, requires: ToolRequires | undefined): string {
  const reasons = unmetReasons(caps, requires);
  return reasons.length === 0 ? "" : reasons.join("; ");
}

/** JSON-safe shape of {@link Capabilities}, for the dashboard API. */
export interface CapabilitiesJson {
  version: string | null;
  channel: ReleaseChannel;
  board: string;
  arch: string;
  isRouterBoard: boolean;
  packages: string[];
  wirelessStack: WirelessStack;
  deviceMode: { container: boolean; scheduler: boolean; fetch: boolean };
  probedAt: number;
}

/**
 * Convert a probe to JSON. Needed because `packages` is a `Set`, which
 * `JSON.stringify` silently renders as `{}` rather than failing — a serializer
 * that looks unnecessary right up until the wire payload is quietly empty.
 * Returns null for an unprobed device so the client can distinguish
 * "not probed yet" from "probed and found nothing".
 */
export function serializeCapabilities(caps: Capabilities | undefined): CapabilitiesJson | null {
  if (!caps) return null;
  return {
    version: caps.version?.raw ?? null,
    channel: caps.channel,
    board: caps.board,
    arch: caps.arch,
    isRouterBoard: caps.isRouterBoard,
    packages: [...caps.packages].sort(),
    wirelessStack: caps.wirelessStack,
    deviceMode: caps.deviceMode,
    probedAt: caps.probedAt,
  };
}

/** Derive the release channel from a version suffix. */
export function channelOf(version: ParsedVersion | null): ReleaseChannel {
  if (!version) return "unknown";
  const s = version.suffix.toLowerCase();
  if (!s) return "stable";
  if (s.includes("beta") || s.includes("alpha")) return "development";
  if (s.includes("rc") || s.includes("testing")) return "testing";
  if (s.includes("long-term") || s.includes("lts")) return "long-term";
  return "unknown";
}
