/**
 * Staged fleet rollout — apply one change across N routers as
 * canary → wave → fleet, halting and reverting on the first failure.
 *
 * Four tool faces over `src/rollout/`: the pure model decides, the runner
 * performs, these render. `plan_rollout` is genuinely side-effect-free and must
 * stay that way — being able to show a human exactly what a fleet-wide change
 * will do, in what order, before anything happens, is the reason this feature is
 * trustworthy at all.
 *
 * Not to be confused with the transaction tools (`begin_transaction` …): those
 * make a change atomic across devices that must AGREE; this makes a change safe
 * across devices that are INDEPENDENT.
 */
import { z } from "zod";
import { DANGEROUS, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { peekCapabilities } from "../core/capability-cache";
import { compareVersions, parseVersion } from "../core/firmware-lifecycle";
import type { ParsedVersion } from "../core/firmware-lifecycle";
import { getConfig, resolveDeviceName, tryResolveDeviceName } from "../core/runtime";
import { logger } from "../logger";
import { publishRollout } from "../observability/rollout-hub";
import {
  beginRollout,
  estimateSeconds,
  planWaves,
  requestAbort,
  summarize,
} from "../rollout/model";
import type { RolloutState, WaveStrategy } from "../rollout/model";
import { createDeviceExecutor, probeReachability, runRollout } from "../rollout/runner";
import {
  dropRollout,
  getRollout,
  listRollouts,
  logRolloutEvent,
  newRolloutId,
  persistRollout,
  putRollout,
} from "../rollout/session";
import type { LiveRollout } from "../rollout/session";

/** `targets` accepts an explicit list or a selector over the configured fleet. */
const selectorSchema = z.object({
  all: z.boolean().optional().describe("Every configured, enabled device"),
  tags: z.array(z.string()).optional().describe("Devices carrying ALL of these config tags"),
  versionBelow: z
    .string()
    .optional()
    .describe(
      'Devices whose RouterOS version is below this, e.g. "7.14" (uses the capability cache)',
    ),
  exclude: z.array(z.string()).optional().describe("Device names to leave out — composable"),
});

const strategySchema = z.object({
  canary: z.coerce.number().int().positive().optional().describe("Devices in wave 1 (default 1)"),
  wavePercent: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Percent of the remaining devices in wave 2 (default 25)"),
  soakSeconds: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Wait after each wave's health check before continuing (default 30)"),
  onFailure: z
    .enum(["halt-and-revert", "halt-and-hold", "continue"])
    .optional()
    .describe("What to do when a wave's gate fails (default halt-and-revert)"),
});

/**
 * Is a device's RouterOS version below `limit`? Uses the SAME comparator as
 * firmware lifecycle and capability gating — a second version comparison in this
 * codebase would eventually disagree with the first one about `7.14` vs
 * `7.14rc1`, and the selector that decides which routers get changed is the
 * worst place for that.
 */
function isVersionBelow(actual: ParsedVersion | null, limit: string): boolean {
  const max = parseVersion(limit);
  if (!actual || !max) return false;
  return compareVersions(actual, max) < 0;
}

interface Selection {
  devices: string[];
  notes: string[];
  error?: string;
}

/**
 * Resolve `targets` to a device list.
 *
 * `versionBelow` reads the capability cache rather than probing inline: probing
 * here would duplicate the capability subsystem and, worse, would make
 * `plan_rollout` touch devices — the one thing it must never do. A device with
 * no cached version is reported, not silently included or excluded.
 */
export function resolveTargets(targets: string[] | z.infer<typeof selectorSchema>): Selection {
  const cfg = getConfig();
  const notes: string[] = [];

  if (Array.isArray(targets)) {
    // `tryResolveDeviceName`, not `resolveDeviceName`: this branch REPORTS the
    // unknown names as a plan error rather than throwing on the first one, so it
    // needs the non-throwing resolver. (The old code called the resolver when it
    // still fell back to the default — which always returned a real key, so the
    // filter never matched and an unknown target sailed through as the default
    // device.)
    const unknown = targets.filter((t) => !tryResolveDeviceName(t));
    if (unknown.length > 0) {
      return { devices: [], notes, error: `unknown device(s): ${unknown.join(", ")}` };
    }
    return { devices: targets.map((t) => resolveDeviceName(t)), notes };
  }

  const all = Object.entries(cfg.devices)
    .filter(([, d]) => !d.disabled)
    .map(([name]) => name);
  let selected = all;

  if (targets.tags && targets.tags.length > 0) {
    const wanted = targets.tags;
    selected = selected.filter((name) => {
      const tags = cfg.devices[name].tags;
      return wanted.every((t) => tags.includes(t));
    });
    notes.push(`tags [${wanted.join(", ")}] matched ${selected.length} device(s)`);
  }

  if (targets.versionBelow) {
    const unknownVersion: string[] = [];
    selected = selected.filter((name) => {
      const caps = peekCapabilities(name);
      if (!caps || !caps.version) {
        unknownVersion.push(name);
        return false;
      }
      return isVersionBelow(caps.version, targets.versionBelow ?? "");
    });
    if (unknownVersion.length > 0) {
      notes.push(
        `EXCLUDED (no cached RouterOS version — run get_device_capabilities first): ${unknownVersion.join(", ")}`,
      );
    }
    notes.push(`versionBelow ${targets.versionBelow} matched ${selected.length} device(s)`);
  }

  if (targets.exclude && targets.exclude.length > 0) {
    const excluded = new Set(targets.exclude.map((e) => resolveDeviceName(e)));
    selected = selected.filter((name) => !excluded.has(name));
    notes.push(`excluded ${[...excluded].join(", ")}`);
  }

  if (!targets.all && !targets.tags && !targets.versionBelow) {
    return {
      devices: [],
      notes,
      error: "selector must set at least one of all / tags / versionBelow",
    };
  }
  return { devices: selected, notes };
}

function splitCommands(input: string[] | string): string[] {
  const list = Array.isArray(input) ? input : input.split("\n");
  return list.map((c) => c.trim()).filter((c) => c !== "" && !c.startsWith("#"));
}

function renderWaves(state: RolloutState): string[] {
  return state.waves.map(
    (w) =>
      `  Wave ${w.index + 1}${w.isCanary ? " (canary)" : ""}: ${w.devices.length} device(s) — ${w.devices.join(", ")}`,
  );
}

function live(id: string): LiveRollout | string {
  const entry = getRollout(id);
  if (entry) return entry;
  const open = listRollouts().map((r) => r.state.id);
  return `No active rollout '${id}'.${open.length > 0 ? ` Active: ${open.join(", ")}.` : " None are active."}`;
}

/** Drive a rollout and mirror every step into the log, the hub and the store. */
async function advance(
  entry: LiveRollout,
  ctx: Parameters<typeof createDeviceExecutor>[0],
): Promise<Awaited<ReturnType<typeof runRollout>>> {
  const run = await runRollout({
    state: entry.state,
    commands: entry.commands,
    executor: createDeviceExecutor(ctx, entry.state.id),
    onEvent: ({ action, state }) => {
      entry.state = state;
      const device = "device" in action ? action.device : undefined;
      const ok =
        action.kind === "gate"
          ? (state.gates.at(-1)?.ok ?? true)
          : !state.devices.some(
              (d) => d.device === device && (d.stage === "failed" || d.stage === "revert-failed"),
            );
      void logRolloutEvent({ rolloutId: state.id, kind: action.kind, device, ok });
      publishRollout({
        rolloutId: state.id,
        ts: Date.now(),
        phase: state.phase,
        currentWave: state.currentWave,
        action: action.kind,
        device,
        ok,
        outcome: state.outcome,
        devices: state.devices,
        gates: state.gates,
      });
    },
  });
  entry.state = run.state;
  await persistRollout(entry);
  if (run.outcome) dropRollout(entry.state.id);
  return run;
}

function report(run: { outcome?: string; state: RolloutState }, headline: string): string {
  const lines = [headline, "", `Rollout: ${run.state.id}`, "", "Devices:"];
  for (const line of summarize(run.state)) lines.push(`  ${line}`);
  if (run.state.gates.length > 0) {
    lines.push("", "Gates:");
    for (const g of run.state.gates) {
      lines.push(
        `  Wave ${g.wave + 1}: ${g.ok ? "PASS" : "FAIL"}${
          g.failures.length > 0
            ? ` — ${g.failures.map((f) => `${f.device}: ${f.reason}`).join("; ")}`
            : ""
        }`,
      );
    }
  }
  if (run.state.notes.length > 0) {
    lines.push("", "Notes:");
    for (const n of run.state.notes) lines.push(`  • ${n}`);
  }
  return lines.join("\n");
}

export const rolloutTools: ToolModule = [
  defineTool({
    name: "plan_rollout",
    title: "Plan a Staged Fleet Rollout",
    annotations: READ,
    description:
      "Previews a fleet-wide change WITHOUT touching anything: which devices are selected, how they " +
      "split into canary → wave → fleet, the exact commands each will run, and a rough duration. " +
      "This is the tool to call before start_rollout, and the output is what a human should approve. " +
      "`targets` is an explicit device list or a selector (`all`, `tags`, `versionBelow`, `exclude`). " +
      "Put the router you reach the others THROUGH last in an explicit list — wave order follows the " +
      "order given. Completely side-effect-free: no device is contacted.",
    inputSchema: {
      commands: z
        .union([z.array(z.string()), z.string()])
        .describe("RouterOS commands to apply to every device (array, or newline-separated)"),
      targets: z
        .union([z.array(z.string()), selectorSchema])
        .describe('Device names, or a selector like {"tags":["branch"]}'),
      strategy: strategySchema.optional(),
      label: z.string().optional().describe('What this change is, e.g. "ntp servers"'),
    },
    handler(a, ctx) {
      const selection = resolveTargets(a.targets);
      if (selection.error) return `Cannot plan rollout: ${selection.error}`;
      if (selection.devices.length === 0) {
        return `No devices matched.${selection.notes.length > 0 ? `\n${selection.notes.join("\n")}` : ""}`;
      }
      const commands = splitCommands(a.commands);
      if (commands.length === 0) return "No commands to apply.";

      const strategy: WaveStrategy = a.strategy ?? {};
      const waves = planWaves(selection.devices, strategy);
      const soak = strategy.soakSeconds ?? 30;
      const seconds = estimateSeconds(waves, { soakSeconds: soak });
      ctx.info(`Planned rollout over ${selection.devices.length} device(s)`);

      const state = beginRollout({ id: "preview", devices: selection.devices, strategy });
      return [
        `ROLLOUT PLAN${a.label ? ` — ${a.label}` : ""}`,
        `${selection.devices.length} device(s) in ${waves.length} wave(s), ` +
          `~${Math.round(seconds / 60)} min including a ${soak}s soak after each wave.`,
        `On failure: ${state.onFailure}.`,
        "",
        "Waves:",
        ...renderWaves(state),
        "",
        `Commands applied to every device (${commands.length}):`,
        ...commands.map((c) => `  ${c}`),
        ...(selection.notes.length > 0
          ? ["", "Selection:", ...selection.notes.map((n) => `  ${n}`)]
          : []),
        "",
        "Nothing has been changed. Run start_rollout with the same arguments to execute.",
      ].join("\n");
    },
  }),

  defineTool({
    name: "start_rollout",
    title: "Start a Staged Fleet Rollout",
    annotations: DANGEROUS,
    description:
      "Applies a change across the whole selection as canary → wave → fleet, with a health gate and " +
      "a soak between waves. Each device is snapshotted, changed inside Safe Mode, verified still " +
      "reachable, and only then committed. " +
      "The gate checks the devices just changed AND the ones not yet touched — a change that breaks " +
      "the wider network shows up as an untouched router going dark, which no per-device check sees. " +
      "On failure the default (`halt-and-revert`) restores every device this rollout already changed, " +
      "newest first, and skips the rest; `halt-and-hold` stops and changes nothing back; `continue` " +
      "presses on and reports the failures. " +
      "High blast radius — run plan_rollout first and show a human the output. " +
      "Returns a rollout id; follow it with rollout_status, stop it with abort_rollout.",
    inputSchema: {
      commands: z
        .union([z.array(z.string()), z.string()])
        .describe("RouterOS commands to apply to every device"),
      targets: z.union([z.array(z.string()), selectorSchema]),
      strategy: strategySchema.optional(),
      label: z.string().optional(),
      confirm: z
        .boolean()
        .default(false)
        .describe("Must be true to execute — false returns the plan instead"),
    },
    async handler(a, ctx) {
      const selection = resolveTargets(a.targets);
      if (selection.error) return `Cannot start rollout: ${selection.error}`;
      if (selection.devices.length === 0) return "No devices matched — nothing to do.";
      const commands = splitCommands(a.commands);
      if (commands.length === 0) return "No commands to apply.";

      if (!a.confirm) {
        const waves = planWaves(selection.devices, a.strategy ?? {});
        return [
          "NOT STARTED — confirm=false.",
          `Would change ${selection.devices.length} device(s) in ${waves.length} wave(s):`,
          ...waves.map((w) => `  Wave ${w.index + 1}: ${w.devices.join(", ")}`),
          "",
          "Re-run with confirm=true to execute, or use plan_rollout for the full preview.",
        ].join("\n");
      }

      // The gate needs to know which routers were ALREADY unreachable, or one
      // long-dead device halts every rollout forever.
      ctx.info(`Probing ${selection.devices.length} device(s) for the pre-rollout baseline`);
      const baseline = await probeReachability(selection.devices);
      const offline = Object.entries(baseline)
        .filter(([, up]) => !up)
        .map(([name]) => name);

      const state = beginRollout({
        id: newRolloutId(),
        devices: selection.devices,
        strategy: a.strategy ?? {},
        baseline,
      });
      const entry = putRollout({
        state,
        commands,
        ts: Date.now(),
        label: a.label,
      });
      await persistRollout(entry);
      logger.info(`Rollout ${state.id} started over ${selection.devices.length} device(s)`);

      const run = await advance(entry, ctx);
      const header =
        run.outcome === "completed"
          ? `COMPLETED — every device applied the change.`
          : run.outcome === "completed-with-failures"
            ? "COMPLETED WITH FAILURES — the rollout finished, but a gate failed along the way (onFailure=continue)."
            : run.outcome === "reverted"
              ? "HALTED and REVERTED — a gate failed; every device this rollout changed was restored, the rest untouched."
              : run.outcome === "halted"
                ? "HALTED — a gate failed and nothing was reverted (onFailure=halt-and-hold). The changed devices are still changed."
                : run.outcome === "needs-attention"
                  ? "NEEDS ATTENTION — a revert itself failed. Restore the flagged device(s) by hand from the snapshot named below."
                  : "ABORTED.";
      const offlineNote =
        offline.length > 0
          ? `\n\nNote: ${offline.join(", ")} ${offline.length === 1 ? "was" : "were"} already unreachable before the rollout, so ${offline.length === 1 ? "it was" : "they were"} not counted against the gates.`
          : "";
      return report(run, header) + offlineNote;
    },
  }),

  defineTool({
    name: "rollout_status",
    title: "Rollout Status",
    annotations: READ,
    description:
      "Reports the state of a rollout — current wave, per-device stage (pending / applied / failed / " +
      "reverted / skipped), and every gate result so far. " +
      "Omit `rollout_id` to list the rollouts still in flight. Reads local state only; no device is " +
      "contacted.",
    inputSchema: {
      rollout_id: z.string().optional().describe("Rollout id from start_rollout"),
    },
    handler(a, _ctx) {
      if (!a.rollout_id) {
        const active = listRollouts();
        if (active.length === 0) return "No rollouts are in flight.";
        return [
          `${active.length} rollout(s) in flight:`,
          ...active.map(
            (r) =>
              `  ${r.state.id}${r.label ? ` (${r.label})` : ""} — wave ${r.state.currentWave + 1}/${r.state.waves.length}, phase ${r.state.phase}`,
          ),
        ].join("\n");
      }
      const entry = live(a.rollout_id);
      if (typeof entry === "string") return entry;
      return report(
        { state: entry.state, outcome: entry.state.outcome },
        `Rollout ${entry.state.id}${entry.label ? ` — ${entry.label}` : ""}: wave ${entry.state.currentWave + 1}/${entry.state.waves.length}, phase ${entry.state.phase}${entry.state.holdRequested ? " (HOLD requested)" : ""}`,
      );
    },
  }),

  defineTool({
    name: "abort_rollout",
    title: "Abort a Rollout",
    annotations: WRITE,
    description:
      "Stops a rollout now and restores every device it already changed, newest first — unlike a gate " +
      "failure this is unconditional, so it reverts even when the rollout was started with " +
      "`onFailure=halt-and-hold`. Devices not yet touched are simply skipped. " +
      "If a revert itself fails the report names the device and the snapshot to restore it from.",
    inputSchema: {
      rollout_id: z.string().describe("Rollout id from start_rollout"),
      reason: z.string().optional().describe("Recorded in the rollout history"),
    },
    async handler(a, ctx) {
      const entry = live(a.rollout_id);
      if (typeof entry === "string") return entry;

      entry.state = requestAbort(entry.state, a.reason);
      const run = await advance(entry, ctx);
      return report(
        run,
        run.outcome === "needs-attention"
          ? "ABORTED but NEEDS ATTENTION — a revert failed; restore the flagged device(s) by hand."
          : "ABORTED — every device this rollout changed has been restored.",
      );
    },
  }),
];
