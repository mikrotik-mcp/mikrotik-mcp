/**
 * Config Drift Guardian — golden-config baselines, drift detection, and
 * reconciliation tools.
 *
 * Builds on existing primitives:
 * - `src/snapshots/store.ts` for snapshot + baseline persistence (same DB)
 * - `src/snapshots/format.ts` for normalisation and hashing
 * - `src/core/diff.ts` for unified line-level diffs
 * - `src/backups/vault.ts` for `exportToCommands()` (.rsc → command list)
 * - `src/ssh/safe-mode.ts` for transactional config restore
 *
 * No code is duplicated from `config-snapshot.ts` — the export command builder
 * and live-export runner are trivially small inline helpers using the same
 * `Cmd.raw()` pattern, and the snapshot store / diff engine are imported.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { diffLines } from "../core/diff";
import { DANGEROUS, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, isEmpty, looksLikeError } from "../core/routeros";
import { resolveDeviceName, getDevice } from "../core/runtime";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { noteDriftResult } from "../drift/alert";
import { analyzeDrift, attributeChanges, renderDriftReport } from "../drift/engine";
import { contentSha, countLines, normalizeExport, parseExportMeta } from "../snapshots/format";
import { openSnapshotStore } from "../snapshots/store";
import type { Snapshot, SnapshotStore } from "../snapshots/store";
import { exportToCommands } from "../backups/vault";
import { getSafeModeManager } from "../ssh/safe-mode";

// ── Lazy store singleton (shares snapshots.db with config-snapshot tools) ────

let storePromise: Promise<SnapshotStore> | null = null;
function store(): Promise<SnapshotStore> {
  if (!storePromise) storePromise = openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

// ── Inline helpers (same trivial Cmd.raw() pattern as config-snapshot.ts) ────

function buildExport(opts: { section?: string; terse: boolean; showSensitive: boolean }): string {
  const base = opts.section ? `/${opts.section} export` : "/export";
  return new Cmd(base)
    .raw(opts.terse ? "terse" : undefined)
    .raw(opts.showSensitive ? "show-sensitive" : undefined)
    .build();
}

async function runExport(
  ctx: ToolContext,
  opts: { section?: string; terse: boolean; showSensitive: boolean },
): Promise<string> {
  const body = await executeMikrotikCommand(buildExport(opts), ctx);
  if (isEmpty(body) || looksLikeError(body)) {
    throw new Error(`device returned no usable export: ${body.trim() || "(empty)"}`);
  }
  return body;
}

function makeSnapshot(device: string, body: string, label?: string): Snapshot {
  const meta = parseExportMeta(body);
  const sha = contentSha(normalizeExport(body));
  const ts = Date.now();
  return {
    id: `snap_${ts}_${sha.slice(0, 8)}`,
    device,
    ts,
    label,
    rosVersion: meta.rosVersion,
    body,
    bytes: Buffer.byteLength(body, "utf8"),
    lines: countLines(body),
    sha,
  };
}

function describeBaseline(snap: Snapshot): string {
  const when = new Date(snap.ts).toISOString();
  const ver = snap.rosVersion ? ` ros=${snap.rosVersion}` : "";
  return `${snap.id}  ${when}  ${snap.lines} lines, ${snap.bytes} bytes${ver}  sha=${snap.sha}`;
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const configDriftTools: ToolModule = [
  // ── Set Baseline ──────────────────────────────────────────────────────────
  defineTool({
    name: "config_set_baseline",
    title: "Set Golden Config Baseline",
    annotations: WRITE,
    description:
      "Capture the current device `/export` and designate it as the golden-config baseline — " +
      "the known-good reference point for drift detection. A device can have exactly one " +
      "baseline; setting a new one replaces the previous. The export is also stored as a " +
      "regular config snapshot in `~/.mikrotik-mcp/snapshots.db`. Use `config_check_drift` " +
      "to compare the live config against this baseline; use `config_promote_drift` to accept " +
      "the current (drifted) config as the new baseline. Optionally limit to one RouterOS " +
      "section via `section` (e.g. 'ip firewall filter').",
    inputSchema: {
      label: z.string().optional().describe("Human label for this baseline, e.g. 'production-v2'."),
      notes: z.string().optional().describe("Free-text notes about why this baseline was set."),
      section: z
        .string()
        .optional()
        .describe("RouterOS path without leading slash. Omit for full config."),
      terse: z
        .boolean()
        .default(true)
        .describe("Use `/export terse` for cleaner diffs. Default true."),
      show_sensitive: z.boolean().default(false),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Setting golden baseline for ${device}${a.section ? ` (${a.section})` : ""}`);

      const body = await runExport(ctx, {
        section: a.section,
        terse: a.terse,
        showSensitive: a.show_sensitive,
      });

      const snap = makeSnapshot(device, body, a.label ?? "baseline");
      const s = await store();
      s.insert(snap);
      s.setBaseline(device, snap.id, "agent", a.label, a.notes);

      const notesLine = a.notes ? `\nNotes: ${a.notes}` : "";
      return `Golden baseline set for ${device}:\n${describeBaseline(snap)}${notesLine}`;
    },
  }),

  // ── Check Drift ───────────────────────────────────────────────────────────
  defineTool({
    name: "config_check_drift",
    title: "Check Config Drift Against Baseline",
    annotations: READ,
    description:
      "Compare the live device configuration against its golden baseline and return a drift " +
      "report with: severity score (0–100), per-section breakdown of what changed, change " +
      "attribution from system logs (who changed what and when), and a unified diff. " +
      "Requires a baseline to be set first via `config_set_baseline`. Set `include_logs=false` " +
      "to skip log-based change attribution (faster). Use `config_reconcile` to push the " +
      "baseline back onto the device, or `config_promote_drift` to accept the drift.",
    inputSchema: {
      include_logs: z
        .boolean()
        .default(true)
        .describe("Fetch system logs for change attribution. Default true."),
      log_duration: z
        .string()
        .default("7d")
        .describe("How far back to search logs. RouterOS duration (e.g. '7d', '24h')."),
      max_output_lines: z
        .number()
        .int()
        .min(50)
        .max(5000)
        .default(800)
        .describe("Truncate the unified diff beyond this many lines."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Checking config drift for ${device}`);

      const s = await store();
      const baseline = s.getBaseline(device);
      if (!baseline) {
        return `No golden baseline set for '${device}'. Use config_set_baseline first.`;
      }
      const baselineSnap = s.get(baseline.snapshotId);
      if (!baselineSnap) {
        return (
          `Baseline snapshot '${baseline.snapshotId}' for '${device}' has been deleted. ` +
          `Set a new baseline with config_set_baseline.`
        );
      }

      // Live export
      const liveBody = await runExport(ctx, { terse: true, showSensitive: false });

      // Diff
      const diff = diffLines(normalizeExport(baselineSnap.body), normalizeExport(liveBody), {
        contextLines: 3,
        fromLabel: `baseline:${baselineSnap.id}`,
        toLabel: `${device}@live`,
      });

      // Analyze
      const report = analyzeDrift(diff, device, baseline.snapshotId, baseline.setAt);

      // Feed alerting. Transition-only, so re-running a check while
      // investigating does not emit a fresh alert each time.
      noteDriftResult(report);

      // Change attribution from system logs
      if (a.include_logs && report.sections.length > 0) {
        try {
          const logCmd = `/log print where topics~"system" and time > ([:timestamp] - ${a.log_duration})`;
          const logText = await executeMikrotikCommand(logCmd, ctx);
          if (!isEmpty(logText) && !looksLikeError(logText)) {
            report.attributions = attributeChanges(report.sections, logText);
          }
        } catch {
          // Log fetching is best-effort; don't fail the drift check
        }
      }

      return renderDriftReport(report, a.max_output_lines);
    },
  }),

  // ── Reconcile ─────────────────────────────────────────────────────────────
  defineTool({
    name: "config_reconcile",
    title: "Reconcile Device to Golden Baseline",
    annotations: DANGEROUS,
    description:
      "Push the golden baseline configuration back onto the device, reverting all drift. " +
      "Replays the baseline's `/export` commands through RouterOS Safe Mode — if any command " +
      "fails or the device becomes unreachable, all changes are automatically rolled back. " +
      "With `confirm=false` (default) this is a DRY RUN: commands are applied and then " +
      "rolled back, showing what would change. Set `confirm=true` to actually commit. " +
      "Requires SSH (not MAC-Telnet). After a successful commit, a verification snapshot " +
      "is captured to confirm the state.",
    inputSchema: {
      confirm: z
        .boolean()
        .default(false)
        .describe("false = dry-run (apply + rollback); true = commit for real."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Reconciling ${device} to golden baseline (confirm=${a.confirm})`);

      // Check for MAC-Telnet device
      if (getDevice(device).mac) {
        return "Reconcile uses Safe Mode (SSH-only); not available for MAC-Telnet devices.";
      }

      const s = await store();
      const baseline = s.getBaseline(device);
      if (!baseline) {
        return `No golden baseline set for '${device}'. Use config_set_baseline first.`;
      }
      const baselineSnap = s.get(baseline.snapshotId);
      if (!baselineSnap) {
        return `Baseline snapshot '${baseline.snapshotId}' has been deleted. Set a new baseline.`;
      }

      const commands = exportToCommands(baselineSnap.body);
      if (commands.length === 0) {
        return "Baseline contains no applicable commands.";
      }

      const safe = getSafeModeManager(device);
      const enabled = await safe.enable();
      if (enabled.startsWith("Error")) {
        return `Failed to enable Safe Mode: ${enabled}`;
      }

      try {
        let applied = 0;
        for (const command of commands) {
          const out = await safe.execute(command);
          if (looksLikeError(out)) {
            await safe.rollback();
            return (
              `Reconcile failed at command ${applied + 1}/${commands.length} — rolled back.\n` +
              `Command: ${command}\nError: ${out.trim()}`
            );
          }
          applied++;
        }

        if (!a.confirm) {
          await safe.rollback();
          return (
            `DRY RUN: applied ${applied}/${commands.length} commands from baseline ` +
            `${baselineSnap.id}, then rolled back.\n` +
            `Pass confirm=true to commit for real.`
          );
        }

        // Verify the device is still reachable before committing
        const probe = await safe.execute("/system identity print");
        if (looksLikeError(probe)) {
          await safe.rollback();
          return (
            `Device stopped responding after applying ${applied} commands — rolled back ` +
            `to prevent lock-out.`
          );
        }

        const committed = await safe.commit();
        if (!committed.ok) {
          return `Applied ${applied} command(s) but COMMIT FAILED — not saved: ${committed.message}`;
        }

        // Capture a verification snapshot
        try {
          const verifyBody = await runExport(ctx, { terse: true, showSensitive: false });
          const verifySnap = makeSnapshot(device, verifyBody, "post-reconcile");
          s.insert(verifySnap);
        } catch {
          // Verification snapshot is best-effort
        }

        return (
          `Reconciled ${device}: committed ${applied} command(s) from baseline ` +
          `${baselineSnap.id}. ${committed.message}`
        );
      } catch (e) {
        await safe.rollback();
        return `Reconcile failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  }),

  // ── Promote Drift ─────────────────────────────────────────────────────────
  defineTool({
    name: "config_promote_drift",
    title: "Promote Current Config as New Baseline",
    annotations: WRITE,
    description:
      "Accept the device's current (drifted) configuration as the new golden baseline. " +
      "Captures a fresh `/export` snapshot and replaces the existing baseline pointer. " +
      "Use this after reviewing drift with `config_check_drift` and deciding the changes " +
      "are intentional. The old baseline snapshot is preserved in snapshot history.",
    inputSchema: {
      label: z.string().optional().describe("Label for the new baseline."),
      notes: z.string().optional().describe("Why the drift is being accepted."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Promoting current config as new baseline for ${device}`);

      const s = await store();
      const oldBaseline = s.getBaseline(device);
      if (!oldBaseline) {
        return (
          `No existing baseline for '${device}'. Use config_set_baseline to set one ` +
          `(promote is for replacing an existing baseline with the current live config).`
        );
      }

      const body = await runExport(ctx, { terse: true, showSensitive: false });
      const snap = makeSnapshot(device, body, a.label ?? "promoted-baseline");
      s.insert(snap);
      s.setBaseline(device, snap.id, "agent", a.label, a.notes);

      const notesLine = a.notes ? `\nNotes: ${a.notes}` : "";
      return `Drift promoted as new baseline for ${device}:\nOld: ${oldBaseline.snapshotId}\nNew: ${describeBaseline(snap)}${notesLine}`;
    },
  }),
];
