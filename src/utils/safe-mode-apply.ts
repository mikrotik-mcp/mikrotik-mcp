/**
 * Reusable "apply a batch of writes, preferring Safe Mode" helper.
 *
 * Runs an ordered list of RouterOS commands through the device's persistent Safe
 * Mode session so a dropped connection auto-reverts. Safe Mode over SSH is flaky
 * on some RouterOS builds (the interactive session can go silent), so callers
 * whose writes CANNOT lock out management access — e.g. address-list tagging
 * rules behind a trust-excluding jump — may opt into a DIRECT fallback so a Safe
 * Mode failure doesn't abort the whole operation. The fallback is OFF by default:
 * for anything that could cut access (drops, service/SSH changes), a Safe Mode
 * failure must be reported, never bypassed. Callers are expected to capture a
 * snapshot BEFORE calling this (it is the rollback point for the fallback path).
 */
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { getDevice } from "../core/runtime";
import { looksLikeError } from "../core/routeros";
import { getSafeModeManager } from "../ssh/safe-mode";

export interface WriteOutcome {
  applied: number;
  total: number;
  /** Human-readable Safe-Mode disposition (committed / fell back / failed …). */
  safeMode: string;
  committed: boolean;
  /** First device error, when a write failed. */
  error?: string;
  /** True when writes were applied DIRECTLY because Safe Mode wasn't usable. */
  fellBack: boolean;
}

export interface ApplyOptions {
  /**
   * Allow falling back to DIRECT writes when Safe Mode is unavailable before writes.
   * Only safe when the commands cannot lock out management access (tagging /
   * add-to-list rules, etc.). Default false → a Safe Mode failure is reported,
   * not bypassed.
   */
  allowDirectFallback?: boolean;
}

/** Apply commands directly (no Safe Mode); stop on the first device error. */
export async function applyCommandsDirect(
  ctx: ToolContext,
  commands: string[],
): Promise<{ applied: number; error?: string }> {
  let applied = 0;
  for (const cmd of commands) {
    const out = await executeMikrotikCommand(cmd, ctx).catch((e: unknown) => `error: ${String(e)}`);
    if (looksLikeError(out) || out.startsWith("error:")) {
      return { applied, error: out.trim().split("\n")[0] };
    }
    applied++;
  }
  return { applied };
}

/**
 * Apply the ordered writes, preferring Safe Mode on SSH devices. With
 * `allowDirectFallback`, a MAC-Telnet device or Safe-Mode enable failure may
 * fall back to direct writes. Mid-apply failures always abort: rollback is
 * unverified and replaying writes could duplicate changes.
 */
export async function applyWritesSafely(
  ctx: ToolContext,
  deviceName: string,
  commands: string[],
  opts: ApplyOptions = {},
): Promise<WriteOutcome> {
  const total = commands.length;
  const fallback = opts.allowDirectFallback === true;
  if (total === 0)
    return {
      applied: 0,
      total,
      safeMode: "not used (nothing to write)",
      committed: true,
      fellBack: false,
    };

  // MAC-Telnet has no Safe Mode.
  if (getDevice(deviceName).mac) {
    if (!fallback)
      return {
        applied: 0,
        total,
        safeMode: "unavailable (MAC-Telnet device has no Safe Mode)",
        committed: false,
        fellBack: false,
      };
    const r = await applyCommandsDirect(ctx, commands);
    return {
      applied: r.applied,
      total,
      safeMode: "not used (MAC-Telnet device — no Safe Mode)",
      committed: !r.error,
      error: r.error,
      fellBack: false,
    };
  }

  const mgr = getSafeModeManager(deviceName);
  const en = await mgr.enable();
  if (en.startsWith("Error")) {
    if (!fallback)
      return {
        applied: 0,
        total,
        safeMode: `failed to enable: ${en}`,
        committed: false,
        fellBack: false,
      };
    const r = await applyCommandsDirect(ctx, commands);
    return {
      applied: r.applied,
      total,
      safeMode: `unavailable (${en.replace(/^Error:?\s*/, "")}) — applied directly; snapshot is the rollback point`,
      committed: !r.error,
      error: r.error,
      fellBack: true,
    };
  }

  // Safe Mode active — run through it.
  let applied = 0;
  let wedged: string | undefined;
  for (const cmd of commands) {
    const out = await mgr.execute(cmd).catch((e: unknown) => `error: ${String(e)}`);
    if (looksLikeError(out) || out.startsWith("error:")) {
      wedged = out.trim().split("\n")[0];
      break;
    }
    applied++;
  }
  if (wedged !== undefined) {
    await mgr.rollback().catch(() => undefined);
    return {
      applied,
      total,
      safeMode: `rollback requested, unverified (a write failed: ${wedged}); inspect the snapshot before retrying`,
      committed: false,
      error: wedged,
      fellBack: false,
    };
  }

  const c = await mgr.commit();
  return {
    applied,
    total,
    safeMode: c.ok
      ? "committed"
      : `commit unclear (${c.message}) — re-run to reconcile if the operation is idempotent`,
    committed: c.ok,
    fellBack: false,
  };
}
