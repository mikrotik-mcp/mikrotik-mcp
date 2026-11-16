/**
 * Change Plan & Dry-Run — `plan_changes` + `apply_plan`.
 *
 * `plan_changes` is a read-only "terraform plan": it parses the intended
 * RouterOS commands and returns a risk-scored, lock-out-aware, safely-ordered
 * plan WITHOUT touching the device.
 *
 * `apply_plan` executes that plan inside RouterOS **Safe Mode** (every change is
 * held in memory and auto-reverts on disconnect). It captures `/export terse`
 * before and after, returns the exact diff (via the snapshot diff engine), and
 * then either commits — but only if the device is still reachable, so a lock-out
 * auto-reverts instead of sticking — or rolls back when `confirm` is false (a
 * true dry-run that shows precisely what would change).
 */
import { z } from "zod";
import { buildChangePlan, renderPlan, splitCommands } from "../core/change-plan";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { diffLines } from "../core/diff";
import { DANGEROUS, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError } from "../core/routeros";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { captureSnapshot } from "../snapshots/capture";
import { normalizeExport } from "../snapshots/format";
import { getSafeModeManager } from "../ssh/safe-mode";

/**
 * RouterOS reverts Safe Mode changes when the session closes, but not always
 * before the next connection reads the config. Wait this long before the second
 * read-back when the first one still differs from the pre-change export.
 */
export const REVERT_SETTLE_MS = 2_000;

/**
 * `/export terse` on a connection of its own — never through the Safe Mode
 * shell. The interactive shell wraps lines at the terminal width and pages
 * output, which breaks the diff; a separate exec channel returns the raw text
 * and still sees uncommitted Safe Mode changes (they are live in the running
 * config).
 */
async function exportConfig(readCtx: ToolContext): Promise<string> {
  const body = await executeMikrotikCommand("/export terse", readCtx);
  if (looksLikeError(body) || !/^\/[a-z]/m.test(body)) {
    throw new Error("could not read `/export terse` from the device");
  }
  return normalizeExport(body);
}

type LiveKind = "unchanged" | "applied" | "different" | "unreadable";

/**
 * Read the real device state on a fresh connection and compare it with the
 * pre-change export (and, when known, the post-change export). This is what
 * turns "outcome unknown" into a definite answer after a failed session.
 */
async function liveState(
  readCtx: ToolContext,
  before: string,
  after?: string,
  /** False for a direct write: nothing reverts, so one read is the answer. */
  mayRevert = true,
): Promise<{ kind: LiveKind; text: string }> {
  const read = (): Promise<string | null> => exportConfig(readCtx).catch(() => null);
  let live = await read();
  if (mayRevert && live !== null && live !== before) {
    await new Promise((resolve) => setTimeout(resolve, REVERT_SETTLE_MS));
    live = await read();
  }
  const label = "DEVICE STATE (read back on a fresh connection)";
  if (live === null) {
    return {
      kind: "unreadable",
      text: `${label}: could not be read. The device did not answer; check it before retrying.`,
    };
  }
  if (live === before) {
    return {
      kind: "unchanged",
      text: `${label}: identical to the pre-change export. No change is on the device.`,
    };
  }
  if (after !== undefined && live === after) {
    return { kind: "applied", text: `${label}: the change IS on the device.` };
  }
  const diff = diffLines(before, live, { fromLabel: "before", toLabel: "live" });
  return {
    kind: "different",
    text: `${label}: differs from the pre-change export (+${diff.summary.added}/-${diff.summary.removed}):\n${diff.unified}`,
  };
}

/** Accept commands as an array and/or a newline-delimited script. */
function collectCommands(a: { commands?: string[]; script?: string }): string[] {
  const fromArray = (a.commands ?? []).map((c) => c.trim()).filter(Boolean);
  const fromScript = a.script ? splitCommands(a.script) : [];
  return [...fromArray, ...fromScript];
}

export const changePlanTools: ToolModule = [
  defineTool({
    name: "plan_changes",
    title: "Plan RouterOS Changes (Dry-Run Preview)",
    annotations: READ,
    description:
      "Parses a set of intended RouterOS CLI commands locally — without contacting the device — " +
      "and returns a risk-scored, lock-out-aware execution plan. Classifies each command as " +
      "ADD/MODIFY/REMOVE/OTHER, calculates an overall risk score, emits warnings when commands would " +
      "drop input-chain traffic or remove the management IP, and reorders steps into the safest " +
      "sequence (additive changes before destructive ones). Use this to understand what will " +
      "happen before committing; to execute the plan use apply_plan. Provide commands as an " +
      "array via `commands`, as a newline-delimited string via `script`, or both — they are " +
      "merged. Before planning a change, FIRST call capture_config_snapshot to take a restore " +
      "point — it stores a local `/export` on the MCP host (~/.mikrotik-mcp/snapshots.db) with " +
      "zero footprint on the device's disk (no file is written to the router). " +
      "Returns a human-readable plan text and a structured plan object with per-step details.",
    inputSchema: {
      commands: z.array(z.string()).optional().describe("Intended RouterOS CLI commands."),
      script: z
        .string()
        .optional()
        .describe("Newline-delimited commands (alternative to `commands`)."),
    },
    async handler(a) {
      const commands = collectCommands(a);
      if (commands.length === 0) return "No commands provided to plan.";
      const plan = buildChangePlan(commands);
      return {
        text: renderPlan(plan),
        structuredContent: plan as unknown as Record<string, unknown>,
      };
    },
  }),

  defineTool({
    name: "apply_plan",
    title: "Apply RouterOS Change Plan",
    annotations: DANGEROUS,
    description:
      "Executes intended RouterOS commands and reports the exact unified diff of what changed, " +
      "computed from `/export terse` captured before and after on a separate connection. " +
      "Default (use_safe_mode=true): the steps run inside RouterOS Safe Mode (Ctrl+X over an " +
      "interactive SSH shell). With confirm=false (default) it applies all steps, captures the " +
      "diff, then rolls everything back — a true dry-run. With confirm=true it commits, but ONLY " +
      "after a fresh connection to the device still works — a change that would lock you out " +
      "reverts instead of sticking. If any step fails, or the Safe Mode session times out, the " +
      "session is closed (RouterOS reverts uncommitted changes), the real device state is read " +
      "back and compared with the pre-change export, and the result is reported; this tool never " +
      "leaves a Safe Mode session open and needs no follow-up tool to recover. " +
      "use_safe_mode=false (only when the user explicitly asks to write without Safe Mode): " +
      "stores a restore-point snapshot on the MCP host, runs the steps directly (each one is " +
      "permanent at once, there is no automatic rollback and no dry-run, confirm=true is " +
      "required), stops at the first error, then reads back and diffs. This mode also works on " +
      "MAC-Telnet devices; Safe Mode requires SSH. Steps execute in the same safe order that " +
      "plan_changes computes (additive before destructive). For a no-device preview use " +
      "plan_changes. Returns the plan summary, per-step log, unified diff, and the outcome.",
    inputSchema: {
      commands: z.array(z.string()).optional(),
      script: z.string().optional(),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "false = apply, show diff, roll back (dry-run). true = commit if still reachable.",
        ),
      use_safe_mode: z
        .boolean()
        .default(true)
        .describe(
          "false = write directly without Safe Mode (snapshot first, read-back diff after, no " +
            "automatic rollback). Use only when the user explicitly asks for it.",
        ),
    },
    async handler(a, ctx) {
      const commands = collectCommands(a);
      if (commands.length === 0) return "No commands provided to apply.";

      const device = resolveDeviceName(ctx.device);
      const plan = buildChangePlan(commands);
      const planBody = renderPlan(plan).split("\n").slice(2).join("\n");
      const safe = getSafeModeManager(device);
      // Reads (exports, reachability) go on their own connection, never through
      // the Safe Mode shell.
      const readCtx: ToolContext = { ...ctx, risk: "READ" };

      // ── Direct write path: no Safe Mode, by explicit request ──────────────
      // Explicit `false` only: a caller that omits the field gets Safe Mode.
      if (a.use_safe_mode === false) {
        if (!a.confirm) {
          return (
            `APPLY PLAN (direct, no Safe Mode) — ${device}\n\n${planBody}\n\n` +
            "NOT APPLIED: a dry-run is not possible without Safe Mode. Re-run with confirm=true " +
            "to write directly, or keep use_safe_mode=true for a dry-run."
          );
        }
        if (safe.isActive) {
          throw new Error(
            "A Safe Mode session is open on this device. Commit it or roll it back before a direct write.",
          );
        }
        const snapshotId = await captureSnapshot(readCtx, "apply_plan direct (pre-change)", true);
        const before = await exportConfig(readCtx);
        const log: string[] = [];
        let failure: string | undefined;
        for (const step of plan.steps) {
          const out = await executeMikrotikCommand(step.command, ctx).catch(
            (e: unknown) => `failure: ${e instanceof Error ? e.message : String(e)}`,
          );
          if (looksLikeError(out) || out.startsWith("failure: ")) {
            failure = `step ${step.index} failed:\n  ${step.command}\n  → ${out.trim()}`;
            break;
          }
          log.push(`  ✓ ${step.command}`);
        }
        const state = await liveState(readCtx, before, undefined, false);
        const body =
          `APPLY PLAN (direct, no Safe Mode) — ${device}\n\n${planBody}\n\n` +
          `Restore point: snapshot ${snapshotId} (get_config_snapshot returns its export).\n` +
          `Executed ${log.length} of ${plan.steps.length} step(s) directly:\n${log.join("\n") || "  (none)"}\n\n${state.text}`;
        if (failure) {
          throw new Error(
            `${body}\n\nFAILED: ${failure}\nSteps marked ✓ are permanent; nothing was rolled back.`,
          );
        }
        if (state.kind === "unreadable") {
          throw new Error(`${body}\n\nAll steps ran, but the read-back check failed.`);
        }
        return `${body}\n\nAPPLIED: all steps ran and are permanent (verified by the read-back above).`;
      }

      // ── Safe Mode path ───────────────────────────────────────────────────
      // Genuine failures THROW so the registry reports the tool result as an
      // error (isError). Only the intended outcomes — a dry-run rollback and a
      // verified commit — return normally.
      if (getDevice(ctx.device).mac) {
        throw new Error(
          "Safe Mode requires SSH; it is not available on a MAC-Telnet device. " +
            "Use use_safe_mode=false to write directly.",
        );
      }

      const before = await exportConfig(readCtx);
      const enabled = await safe.enable();
      if (enabled.startsWith("Error")) throw new Error(enabled);

      // Overall time budget so apply_plan can never approach the MCP client's
      // patience. A wedged Safe Mode shell already aborts on the first silent
      // command (idle timeout in safe.execute); this bounds a long healthy run.
      const APPLY_BUDGET_MS = 180_000;
      const startedAt = Date.now();

      let header: string;
      let after: string;
      let reachable: boolean;
      try {
        const log: string[] = [];
        for (const step of plan.steps) {
          if (Date.now() - startedAt > APPLY_BUDGET_MS) {
            throw new Error(
              `aborted after ${Math.round((Date.now() - startedAt) / 1000)}s (time budget exceeded)`,
            );
          }
          const out = await safe.execute(step.command);
          if (looksLikeError(out)) {
            throw new Error(`step ${step.index} failed:\n  ${step.command}\n  → ${out.trim()}`);
          }
          log.push(`  ✓ ${step.command}`);
        }

        after = await exportConfig(readCtx);
        const diff = diffLines(before, after, { fromLabel: "before", toLabel: "after" });

        // Reachability gate: a NEW connection must still work before we commit.
        reachable = await executeMikrotikCommand("/system identity print", readCtx).then(
          (out) => !looksLikeError(out),
          () => false,
        );

        header =
          `APPLY PLAN — ${device}\n\n${planBody}\n\n` +
          `Executed ${plan.steps.length} step(s) in Safe Mode:\n${log.join("\n")}\n\n` +
          `EXACT DIFF (+${diff.summary.added}/-${diff.summary.removed}):\n${diff.unified || "(no config change)"}`;
      } catch (e) {
        // Close the session (RouterOS reverts), then say what is really there.
        await safe.rollback().catch(() => {});
        const msg = e instanceof Error ? e.message : String(e);
        const state = await liveState(readCtx, before);
        throw new Error(
          `apply_plan failed; the Safe Mode session was closed and nothing was committed: ${msg}\n\n${state.text}`,
        );
      }

      if (!a.confirm) {
        await safe.rollback();
        const state = await liveState(readCtx, before);
        return `${header}\n\nDRY-RUN: Safe Mode session closed to roll back. Re-run with confirm=true to commit.\n${state.text}`;
      }
      if (!reachable) {
        await safe.rollback();
        const state = await liveState(readCtx, before);
        throw new Error(
          `${header}\n\nABORTED: a new connection to the device failed after applying — Safe Mode session closed to avoid a lock-out.\n${state.text}`,
        );
      }

      let committed = await safe.commit();
      // Still in Safe Mode = the commit keystroke did not take. Try once more.
      if (!committed.ok && safe.isActive) committed = await safe.commit();
      if (committed.ok) {
        return `${header}\n\nCOMMITTED: changes are now permanent. ${committed.message}`;
      }

      // Never leave the session open: close it, then read back what is real.
      if (safe.isActive) await safe.rollback().catch(() => {});
      const state = await liveState(readCtx, before, after);
      if (state.kind === "applied") {
        return (
          `${header}\n\nCOMMITTED: the commit confirmation was lost (${committed.message}) but the ` +
          `Safe Mode session is closed and the change was not reverted.\n${state.text}`
        );
      }
      throw new Error(`${header}\n\nCOMMIT FAILED: ${committed.message}\n${state.text}`);
    },
  }),
];
