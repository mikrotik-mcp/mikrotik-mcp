/**
 * Shared fleet-rollout list + detail, used by the Change Plan command's rollout
 * section (and importable anywhere else that needs it).
 *
 * A rollout is minutes long, so the useful things from a launcher are: is one in
 * flight, which wave is it on, and can I stop it. Hold / Resume / Abort all go
 * through `lib/confirm.ts` — a fleet-wide change is not somewhere to lose a
 * confirmation step.
 *
 * A **halted** rollout raises a Notification Center alert: a fleet change that
 * stopped part-way is exactly what someone needs to be told immediately rather
 * than discover next time they open Raycast.
 */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  LocalStorage,
  Toast,
  showToast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { api, postJson, withToken } from "./api";
import { confirmDestructive, showFailureToast } from "./confirm";
import { useApi, usePolling } from "./hooks";
import { notify } from "./notify";
import type {
  RolloutEventRow,
  RolloutOutcome,
  RolloutRecord,
  RolloutStage,
} from "./types";

const ALERTED_KEY = "rollouts:alerted-halts";

const OUTCOME_META: Record<RolloutOutcome | "LIVE", { color: Color; icon: Icon; blurb: string }> = {
  completed: {
    color: Color.Green,
    icon: Icon.CheckCircle,
    blurb: "Every device applied the change.",
  },
  "completed-with-failures": {
    color: Color.Yellow,
    icon: Icon.ExclamationMark,
    blurb: "Finished, but a gate failed along the way.",
  },
  halted: {
    color: Color.Orange,
    icon: Icon.Pause,
    blurb: "Stopped at a failed gate — the devices already changed are still changed.",
  },
  reverted: {
    color: Color.SecondaryText,
    icon: Icon.Undo,
    blurb: "Stopped and put back — the fleet is where it started.",
  },
  "needs-attention": {
    color: Color.Red,
    icon: Icon.Warning,
    blurb: "A revert itself failed — restore the flagged device(s) by hand.",
  },
  aborted: {
    color: Color.SecondaryText,
    icon: Icon.Undo,
    blurb: "Stopped by a human; whatever had been applied was reverted.",
  },
  LIVE: {
    color: Color.Blue,
    icon: Icon.Clock,
    blurb: "Applying wave by wave, gated and soaked between waves.",
  },
};

function stateOf(r: RolloutRecord): RolloutOutcome | "LIVE" {
  return r.outcome ?? "LIVE";
}

const STAGE_MARK: Record<RolloutStage, string> = {
  pending: "▫️",
  applied: "✅",
  failed: "❌",
  reverted: "⚠️",
  "revert-failed": "🛑",
  skipped: "⏭️",
};

/** Hold / Resume / Abort — each behind a confirmation. */
async function act(
  id: string,
  verb: "hold" | "resume" | "abort",
  onDone: () => void,
): Promise<void> {
  if (verb === "abort") {
    const ok = await confirmDestructive({
      title: `Abort ${id}?`,
      message:
        "Every device this rollout already changed is restored from its pre-change snapshot. Devices not yet touched are skipped.",
      actionTitle: "Abort",
      icon: Icon.Undo,
    });
    if (!ok) return;
  }

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: verb === "hold" ? "Holding…" : verb === "resume" ? "Resuming…" : "Aborting…",
  });
  try {
    const res = await postJson<{ error?: string; outcome?: string; held?: boolean }>(
      `/api/rollout/${encodeURIComponent(id)}/${verb}`,
      {},
    );
    if (res.error) throw new Error(res.error);
    toast.style = res.outcome === "needs-attention" ? Toast.Style.Failure : Toast.Style.Success;
    toast.title = res.outcome ?? (verb === "hold" ? "Held" : "Done");
    onDone();
  } catch (e) {
    toast.hide();
    await showFailureToast(e, { title: `Could not ${verb}` });
  }
}

function RolloutDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, isLoading, revalidate } = usePromise(
    (r: string) =>
      api<{ rollout: RolloutRecord; events: RolloutEventRow[] }>(
        `/api/rollout/${encodeURIComponent(r)}`,
      ),
    [id],
  );
  // Live rollouts move while you watch; finished ones never change again.
  usePolling(revalidate, 5000, data?.rollout.outcome === undefined);

  const rollout = data?.rollout;
  const events = data?.events ?? [];
  const live = rollout?.outcome === undefined;

  const md = rollout
    ? [
        `# ${rollout.label ?? rollout.id}`,
        "",
        `**${stateOf(rollout)}** · ${OUTCOME_META[stateOf(rollout)].blurb}`,
        "",
        `## Waves`,
        "",
        ...rollout.waves.map((w) => {
          const gate = rollout.gates.find((g) => g.wave === w.index);
          const marks = w.devices
            .map((name) => {
              const d = rollout.devices.find((x) => x.device === name);
              return `${STAGE_MARK[d?.stage ?? "pending"]} ${name}`;
            })
            .join(" · ");
          const gateText = gate ? (gate.ok ? " — gate ✅" : " — gate ❌") : "";
          return `**Wave ${w.index + 1}${w.isCanary ? " (canary)" : ""}**${gateText}\n\n${marks}\n`;
        }),
        ...rollout.gates
          .filter((g) => !g.ok)
          .map(
            (g) =>
              `> ❌ Wave ${g.wave + 1}${g.collateral ? " (an UNTOUCHED device went dark)" : ""}: ${g.failures
                .map((f) => `${f.device}: ${f.reason}`)
                .join("; ")}`,
          ),
        rollout.devices.some((d) => d.stage === "revert-failed")
          ? `\n## Recovery\n\n${rollout.devices
              .filter((d) => d.stage === "revert-failed")
              .map(
                (d) =>
                  `- \`diff_config_snapshots ${d.snapshotId ?? "<no snapshot>"} live\` on **${d.device}**`,
              )
              .join("\n")}`
          : "",
        `\n## Commands\n\n\`\`\`\n${rollout.commands.join("\n")}\n\`\`\``,
        events.length
          ? `\n## Timeline\n\n${events
              .map(
                (e) =>
                  `- ${new Date(e.ts).toLocaleTimeString()} ${e.ok ? "✅" : "❌"} ${e.kind}${e.device ? ` ${e.device}` : ""}`,
              )
              .join("\n")}`
          : "",
      ].join("\n")
    : "Loading…";

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={`Rollout · ${rollout?.label ?? id}`}
      markdown={md}
      actions={
        <ActionPanel>
          {live && (
            <>
              <Action
                title="Hold Rollout"
                icon={Icon.Pause}
                onAction={() =>
                  void act(id, "hold", () => {
                    revalidate();
                    onChanged();
                  })
                }
              />
              <Action
                title="Resume Rollout"
                icon={Icon.Play}
                onAction={() =>
                  void act(id, "resume", () => {
                    revalidate();
                    onChanged();
                  })
                }
              />
              <Action
                title="Abort Rollout"
                icon={Icon.Undo}
                style={Action.Style.Destructive}
                onAction={() =>
                  void act(id, "abort", () => {
                    revalidate();
                    onChanged();
                  })
                }
              />
            </>
          )}
          <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#plan")} />
          <Action.CopyToClipboard title="Copy Rollout ID" content={id} />
        </ActionPanel>
      }
    />
  );
}

/**
 * Announce a halted or needs-attention rollout once. A fleet change that stopped
 * part-way is the case where waiting for someone to look is the wrong default.
 */
function useHaltAlerts(rows: RolloutRecord[]): void {
  useEffect(() => {
    const stopped = rows.filter(
      (r) => r.outcome === "halted" || r.outcome === "needs-attention",
    );
    if (stopped.length === 0) return;
    void (async () => {
      const raw = await LocalStorage.getItem<string>(ALERTED_KEY);
      let alerted: string[] = [];
      try {
        if (raw) alerted = JSON.parse(raw) as string[];
      } catch {
        alerted = [];
      }
      const fresh = stopped.filter((r) => !alerted.includes(r.id));
      await Promise.all(
        fresh.map((r) =>
          notify(
            r.outcome === "needs-attention" ? "Rollout NEEDS ATTENTION" : "Rollout halted",
            `${r.label ?? r.id}: ${OUTCOME_META[stateOf(r)].blurb}`,
          ),
        ),
      );
      const keep = rows.map((r) => r.id);
      await LocalStorage.setItem(
        ALERTED_KEY,
        JSON.stringify(
          [...new Set([...alerted, ...fresh.map((r) => r.id)])].filter((id) => keep.includes(id)),
        ),
      );
    })();
  }, [rows]);
}

/** The rollout rows, for embedding in a List (Change Plan's rollout section). */
export function RolloutSection(): ReactNode {
  const { data, revalidate } = useApi<{ rollouts: RolloutRecord[] }>("/api/rollout?limit=15");
  usePolling(revalidate, 10000);
  const rows = data?.rollouts ?? [];
  useHaltAlerts(rows);

  const live = rows.filter((r) => r.outcome === undefined);

  return (
    <List.Section
      title="Fleet rollouts"
      subtitle={live.length > 0 ? `${live.length} in flight` : `${rows.length} recorded`}
    >
      {rows.map((r) => {
        const meta = OUTCOME_META[stateOf(r)];
        const applied = r.devices.filter((d) => d.stage === "applied").length;
        return (
          <List.Item
            key={r.id}
            icon={{ source: meta.icon, tintColor: meta.color }}
            title={r.label ?? r.id}
            // Wave progress in the subtitle is the one number that matters
            // while a rollout is in flight.
            subtitle={
              r.outcome === undefined
                ? `${applied}/${r.devices.length} applied · ${r.waves.length} wave(s) · ${r.phase}`
                : `${applied}/${r.devices.length} applied`
            }
            accessories={[
              { tag: { value: stateOf(r), color: meta.color } },
              { date: new Date(r.ts) },
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Show Details"
                  icon={Icon.Sidebar}
                  target={<RolloutDetail id={r.id} onChanged={revalidate} />}
                />
                {r.outcome === undefined && (
                  <>
                    <Action
                      title="Hold Rollout"
                      icon={Icon.Pause}
                      onAction={() => void act(r.id, "hold", revalidate)}
                    />
                    <Action
                      title="Resume Rollout"
                      icon={Icon.Play}
                      onAction={() => void act(r.id, "resume", revalidate)}
                    />
                    <Action
                      title="Abort Rollout"
                      icon={Icon.Undo}
                      style={Action.Style.Destructive}
                      onAction={() => void act(r.id, "abort", revalidate)}
                    />
                  </>
                )}
                <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#plan")} />
                <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
              </ActionPanel>
            }
          />
        );
      })}
    </List.Section>
  );
}
