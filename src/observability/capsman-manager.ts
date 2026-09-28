import { z } from "zod";
import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { Cmd, commandUnsupported, looksLikeError } from "../core/routeros";
import { parseKeyValues } from "../core/routeros-parse";
import { resolveDeviceName } from "../core/runtime";
import { captureSnapshot } from "../snapshots/capture";
import { getSafeModeManager } from "../ssh/safe-mode";
import { applyWritesSafely } from "../utils/safe-mode-apply";

const MANAGERS = [
  { path: "/interface wifi capsman", label: "WiFi CAPsMAN" },
  { path: "/interface wifiwave2 capsman", label: "WiFiWave2 CAPsMAN" },
  { path: "/caps-man manager", label: "Legacy CAPsMAN" },
] as const;

export interface CapsmanManager {
  path: (typeof MANAGERS)[number]["path"];
  label: string;
  enabled: boolean;
}

export const capsmanManagerChange = z.object({
  device: z.string().trim().min(1),
  path: z.enum([MANAGERS[0].path, MANAGERS[1].path, MANAGERS[2].path]),
  enabled: z.boolean(),
  confirm: z.literal(true),
});

/** Unlike the optional fabric collector, unreadable settings must never mean "off". */
async function readManager(
  ctx: ToolContext,
  manager: (typeof MANAGERS)[number],
): Promise<CapsmanManager | null> {
  const out = await executeMikrotikCommand(new Cmd(`${manager.path} print`).build(), ctx);
  if (commandUnsupported(out)) return null;
  if (looksLikeError(out)) throw new Error(`Cannot read ${manager.label}: ${out}`);
  const enabled = parseKeyValues(out).enabled;
  if (enabled !== "yes" && enabled !== "no")
    throw new Error(`Cannot determine ${manager.label} status. Refresh before changing it.`);
  return { ...manager, enabled: enabled === "yes" };
}

/** Modern and legacy managers may coexist; wifiwave2 is the older modern menu. */
export async function readCapsmanManagers(ctx: ToolContext): Promise<CapsmanManager[]> {
  const modern = (await readManager(ctx, MANAGERS[0])) ?? (await readManager(ctx, MANAGERS[1]));
  const legacy = await readManager(ctx, MANAGERS[2]);
  return [modern, legacy].filter((m): m is CapsmanManager => m !== null);
}

/** Only touches the selected manager's enabled flag; never radios, CAP mode or provisioning. */
export async function setCapsmanManager(ctx: ToolContext, input: unknown) {
  const change = capsmanManagerChange.parse(input);
  const device = resolveDeviceName(change.device);
  if (ctx.device !== device) throw new Error("CAPsMAN target does not match the selected device.");
  const manager = MANAGERS.find((m) => m.path === change.path)!;
  const current = await readManager(ctx, manager);
  if (!current) return { ok: false, error: `${manager.label} is not supported on ${device}.` };
  if (current.enabled === change.enabled)
    return { ok: true, manager: current, applied: 0, message: "Already in the requested state." };
  if (getSafeModeManager(device).isActive)
    return { ok: false, error: "Finish the active Safe Mode session before changing CAPsMAN." };

  const snapshotId = await captureSnapshot(ctx, "pre-capsman-manager", true);
  const result = await applyWritesSafely(
    ctx,
    device,
    [new Cmd(`${manager.path} set`).bool("enabled", change.enabled).build()],
    { allowDirectFallback: false },
  );
  if (!result.committed || result.error)
    return { ok: false, snapshotId, error: result.error ?? result.safeMode };
  // Never replay a write if readback fails after commit: its outcome is uncertain.
  try {
    const verified = await readManager(ctx, manager);
    if (verified?.enabled === change.enabled)
      return { ok: true, snapshotId, manager: verified, applied: result.applied };
  } catch {
    // Surface a reconciliation instruction below, not an invitation to blindly retry.
  }
  return {
    ok: false,
    snapshotId,
    error:
      "CAPsMAN change was sent, but its final state could not be verified. Refresh before trying again.",
  };
}
