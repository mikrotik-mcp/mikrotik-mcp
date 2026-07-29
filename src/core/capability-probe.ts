/**
 * Device capability probe — the I/O half of `capability.ts`.
 *
 * Runs a handful of read-only commands once per device and normalizes the
 * console output into a {@link Capabilities} model. Every individual probe is
 * allowed to fail: an absent menu (`/system/device-mode` before 7.13, `/system
 * routerboard` on CHR) is *information*, not an error, so each is wrapped and
 * degrades to its neutral default rather than aborting the probe.
 *
 * Parsing is split out as pure functions so the whole normalisation path is
 * testable from fixture strings without a device — only {@link probeDevice}
 * touches the wire.
 */
import { executeMikrotikCommand } from "./connector";
import { channelOf, unknownCapabilities } from "./capability";
import type { Capabilities, WirelessStack } from "./capability";
import { commandUnsupported, looksLikeError } from "./routeros";
import { parseVersion } from "./firmware-lifecycle";
import { logger } from "../logger";
import type { ToolContext } from "./context";

/**
 * Pull `key: value` out of a RouterOS settings-style print. RouterOS pads keys
 * with leading spaces and separates with `: `, e.g. `      version: 7.16.2`.
 */
export function parseSettings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([\w-]+):\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Enabled package names from `/system package print`.
 *
 * The listing marks a disabled package with the `X` flag in the flags column:
 *
 * ```
 *  # NAME                 VERSION  SCHEDULED
 *  0 routeros             7.16.2
 *  1 X container          7.16.2
 * ```
 *
 * A disabled package cannot serve its menu, so it is excluded — treating it as
 * present would reintroduce exactly the failure this feature removes.
 */
export function parsePackages(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    // ` 1 X container 7.16.2` → index, optional flags, name.
    const m = line.match(/^\s*\d+\s+([A-Z*\s]*?)\s*([a-z][\w-]*)\s/);
    if (!m) continue;
    const flags = m[1] ?? "";
    if (flags.includes("X")) continue; // disabled
    out.add(m[2]);
  }
  return out;
}

/**
 * Which wireless stack answered. Order matters: a v7 device may still carry the
 * legacy `/interface wireless` menu for compatibility, so the modern stack is
 * tested first and wins.
 */
export function pickWirelessStack(probes: {
  wifi: boolean;
  wireless: boolean;
  capsmanLegacy: boolean;
}): WirelessStack {
  if (probes.wifi) return "wifi";
  if (probes.wireless) return "wireless";
  if (probes.capsmanLegacy) return "capsman-legacy";
  return "none";
}

/** `yes`/`no` → boolean, defaulting to `fallback` for anything unrecognised. */
function yesNo(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return fallback;
}

/**
 * Build the model from already-fetched probe output. Pure — every argument is
 * the raw text (or null when that probe did not answer).
 */
export function normalizeProbe(raw: {
  resource: string | null;
  packages: string | null;
  routerboard: string | null;
  deviceMode: string | null;
  wifi: boolean;
  wireless: boolean;
  capsmanLegacy: boolean;
  now: number;
}): Capabilities {
  const caps = unknownCapabilities();
  caps.probedAt = raw.now;

  if (raw.resource) {
    const r = parseSettings(raw.resource);
    caps.version = parseVersion(r.version);
    caps.channel = channelOf(caps.version);
    caps.board = r["board-name"] ?? "";
    caps.arch = r["architecture-name"] ?? "";
  }

  if (raw.packages) caps.packages = parsePackages(raw.packages);

  // A `/system routerboard` print that answers with `routerboard: yes` is the
  // only positive proof; CHR and x86 either lack the menu or report `no`.
  if (raw.routerboard) {
    const rb = parseSettings(raw.routerboard);
    caps.isRouterBoard = yesNo(rb.routerboard, false);
  }

  // Absent before 7.13 — and absence means unrestricted, so the defaults from
  // unknownCapabilities() (all true) are correct and left alone.
  if (raw.deviceMode) {
    const dm = parseSettings(raw.deviceMode);
    caps.deviceMode = {
      container: yesNo(dm.container, true),
      scheduler: yesNo(dm.scheduler, true),
      fetch: yesNo(dm.fetch, true),
    };
  }

  caps.wirelessStack = pickWirelessStack(raw);
  return caps;
}

/** Run one probe command, returning null when the menu is absent or errored. */
async function tryProbe(command: string, ctx: ToolContext): Promise<string | null> {
  try {
    const out = await executeMikrotikCommand(command, ctx);
    if (commandUnsupported(out) || looksLikeError(out)) return null;
    return out;
  } catch (e) {
    logger.debug(`[capability] probe '${command}' failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** True when a `print count-only` answered with a number (menu exists). */
async function menuExists(command: string, ctx: ToolContext): Promise<boolean> {
  const out = await tryProbe(command, ctx);
  return out !== null && /\d/.test(out);
}

/**
 * Probe one device. Never throws: a device that answers nothing yields
 * {@link unknownCapabilities} with `probedAt` set, which the predicates read as
 * "unknown, so do not block".
 */
export async function probeDevice(ctx: ToolContext, now: number): Promise<Capabilities> {
  const [resource, packages, routerboard, deviceMode] = await Promise.all([
    tryProbe("/system resource print", ctx),
    tryProbe("/system package print", ctx),
    tryProbe("/system routerboard print", ctx),
    tryProbe("/system device-mode print", ctx),
  ]);

  const [wifi, wireless, capsmanLegacy] = await Promise.all([
    menuExists("/interface wifi print count-only", ctx),
    menuExists("/interface wireless print count-only", ctx),
    menuExists("/caps-man manager print", ctx),
  ]);

  return normalizeProbe({
    resource,
    packages,
    routerboard,
    deviceMode,
    wifi,
    wireless,
    capsmanLegacy,
    now,
  });
}
