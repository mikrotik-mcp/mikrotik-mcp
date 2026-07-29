/**
 * Transactions command — cross-device two-phase commit, mirroring the
 * dashboard's Transactions page. Recent transactions with their terminal state
 * as the accessory; the detail renders the swimlane as a Markdown table
 * (Raycast has no rich layout) plus the assertion results and timeline.
 *
 * A `PARTIAL` transaction fires a Notification Center alert: some devices
 * committed and could not be undone, which is exactly the case a human must see
 * immediately rather than discover on their next look at the list. Each id is
 * announced once per install (LocalStorage), so re-opening the command doesn't
 * re-alert.
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
import { useEffect } from "react";
import { api, postJson, withToken } from "./lib/api";
import { confirmDestructive, showFailureToast } from "./lib/confirm";
import { useApi, usePolling } from "./lib/hooks";
import { notify } from "./lib/notify";
import type {
  TxnEvent,
  TxnParticipant,
  TxnRecord,
  TxnTerminalState,
} from "./lib/types";

const ALERTED_KEY = "transactions:alerted-partial";

const STATE_META: Record<
  TxnTerminalState | "LIVE",
  { color: Color; icon: Icon; blurb: string }
> = {
  COMMITTED: {
    color: Color.Green,
    icon: Icon.CheckCircle,
    blurb: "Every participant persisted its changes.",
  },
  ABORTED: {
    color: Color.SecondaryText,
    icon: Icon.Undo,
    blurb: "Nothing changed on any device — the clean failure. Safe to retry.",
  },
  PARTIAL: {
    color: Color.Red,
    icon: Icon.ExclamationMark,
    blurb:
      "Some devices committed and could not be undone automatically — restore each flagged device from its snapshot.",
  },
  LIVE: {
    color: Color.Yellow,
    icon: Icon.Clock,
    blurb: "Staged in Safe Mode on every participant and not committed.",
  },
};

function stateOf(t: TxnRecord): TxnTerminalState | "LIVE" {
  return t.state ?? "LIVE";
}

/** One swimlane cell, resolved from the participant's stage. */
function cell(
  column: "prepare" | "verify" | "commit",
  p: TxnParticipant | undefined,
  events: TxnEvent[],
  device: string,
): string {
  const last = events
    .filter((e) => e.kind === column && (column === "verify" || e.device === device))
    .at(-1);
  if (last) return last.ok ? "✅" : "❌";

  const stage = p?.stage ?? "pending";
  if (stage === "pending") return "▫️";
  if (column === "prepare") return stage === "failed" ? "❌" : "✅";
  if (column === "verify") return "✅";
  switch (stage) {
    case "committed":
      return "✅";
    case "restored":
      return "⚠️";
    case "rollback-failed":
      return "❌";
    default:
      return "▫️";
  }
}

function detailMarkdown(txn: TxnRecord, events: TxnEvent[]): string {
  const meta = STATE_META[stateOf(txn)];
  const lanes = txn.devices.map((device) => {
    const p = txn.participants.find((x) => x.device === device);
    return `| ${device} | ${cell("prepare", p, events, device)} | ${cell(
      "verify",
      p,
      events,
      device,
    )} | ${cell("commit", p, events, device)} | ${p?.snapshotId ?? "—"} |`;
  });

  const assertions = txn.results.length
    ? txn.results
        .map(
          (r) =>
            `- ${r.ok ? "✅" : "❌"} \`${r.assertion.kind}\` @ ${
              r.assertion.device ?? r.assertion.from ?? "?"
            } — ${r.detail}`,
        )
        .join("\n")
    : "_None declared — this transaction committed on faith rather than evidence._";

  const recovery =
    txn.state === "PARTIAL"
      ? `\n## Recovery\n\n${txn.participants
          .filter((p) => p.stage === "committed" || p.stage === "rollback-failed")
          .map(
            (p) =>
              `- \`diff_config_snapshots ${p.snapshotId ?? "<no snapshot>"} live\` on **${p.device}**`,
          )
          .join("\n")}\n`
      : "";

  const timeline = events.length
    ? `\n## Timeline\n\n${events
        .map(
          (e) =>
            `- ${new Date(e.ts).toLocaleTimeString()} ${e.ok ? "✅" : "❌"} ${e.kind}${
              e.device ? ` ${e.device}` : ""
            }${e.detail ? ` — ${e.detail}` : ""}`,
        )
        .join("\n")}`
    : "";

  return [
    `# ${txn.label ?? txn.id}`,
    ``,
    `**${stateOf(txn)}** · ${meta.blurb}`,
    ``,
    `Commit order: ${txn.commitOrder.join(" → ")}`,
    ``,
    `| Participant | prepare | verify | commit | snapshot |`,
    `| --- | :---: | :---: | :---: | --- |`,
    ...lanes,
    txn.warnings.length ? `\n${txn.warnings.map((w) => `> ⚠️ ${w}`).join("\n>\n")}` : "",
    recovery,
    `\n## Assertions\n\n${assertions}`,
    timeline,
  ].join("\n");
}

function TxnDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, isLoading, revalidate } = usePromise(
    (t: string) =>
      api<{ transaction: TxnRecord; events: TxnEvent[] }>(`/api/txn/${encodeURIComponent(t)}`),
    [id],
  );
  // A live transaction moves while you watch it; a finished one never changes.
  usePolling(revalidate, 5000, data?.transaction.state === undefined);

  const txn = data?.transaction;
  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={`Transaction · ${txn?.label ?? id}`}
      markdown={txn ? detailMarkdown(txn, data?.events ?? []) : "Loading…"}
      actions={
        <ActionPanel>
          {txn && txn.state === undefined && (
            <Action
              title="Abort Transaction"
              icon={Icon.Undo}
              style={Action.Style.Destructive}
              onAction={() => void abortTxn(id, () => {
                revalidate();
                onChanged();
              })}
            />
          )}
          <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#txn")} />
          <Action.CopyToClipboard title="Copy Transaction ID" content={id} />
        </ActionPanel>
      }
    />
  );
}

/** Roll a live transaction back, with the destructive confirmation. */
async function abortTxn(id: string, onDone: () => void): Promise<void> {
  const ok = await confirmDestructive({
    title: `Abort ${id}?`,
    message:
      "Every participant's Safe Mode session is closed, so RouterOS reverts the staged changes. " +
      "Devices that already committed cannot be reverted this way.",
    actionTitle: "Abort",
    icon: Icon.Undo,
  });
  if (!ok) return;

  const toast = await showToast({ style: Toast.Style.Animated, title: "Aborting…" });
  try {
    const res = await postJson<{ state?: TxnTerminalState; error?: string }>(
      `/api/txn/${encodeURIComponent(id)}/abort`,
      {},
    );
    if (res.error) throw new Error(res.error);
    toast.style = res.state === "PARTIAL" ? Toast.Style.Failure : Toast.Style.Success;
    toast.title = res.state ?? "Aborted";
    onDone();
  } catch (e) {
    toast.hide();
    await showFailureToast(e, { title: "Could not abort" });
  }
}

/**
 * Announce every PARTIAL transaction exactly once. Stored ids are pruned to the
 * ones still present, so the key can't grow without bound.
 */
function usePartialAlerts(rows: TxnRecord[]): void {
  useEffect(() => {
    const partials = rows.filter((r) => r.state === "PARTIAL");
    if (partials.length === 0) return;
    void (async () => {
      const raw = await LocalStorage.getItem<string>(ALERTED_KEY);
      let alerted: string[] = [];
      try {
        if (raw) alerted = JSON.parse(raw) as string[];
      } catch {
        alerted = [];
      }
      const fresh = partials.filter((p) => !alerted.includes(p.id));
      await Promise.all(
        fresh.map((p) =>
          notify(
            "Transaction PARTIAL",
            `${p.label ?? p.id}: ${p.participants
              .filter((x) => x.stage === "committed" || x.stage === "rollback-failed")
              .map((x) => x.device)
              .join(", ")} committed and need a manual restore`,
          ),
        ),
      );
      const keep = rows.map((r) => r.id);
      await LocalStorage.setItem(
        ALERTED_KEY,
        JSON.stringify([...new Set([...alerted, ...fresh.map((p) => p.id)])].filter((id) => keep.includes(id))),
      );
    })();
  }, [rows]);
}

export default function Command() {
  const { data, isLoading, revalidate } = useApi<{ transactions: TxnRecord[]; error?: string }>(
    "/api/txn",
  );
  usePolling(revalidate, 10000);
  const rows = data?.transactions ?? [];
  usePartialAlerts(rows);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search transactions…">
      {rows.length === 0 ? (
        <List.EmptyView
          icon={Icon.Link}
          title="No transactions"
          description="Start one with begin_transaction to change several routers as a unit."
        />
      ) : (
        rows.map((t) => {
          const state = stateOf(t);
          const meta = STATE_META[state];
          return (
            <List.Item
              key={t.id}
              icon={{ source: meta.icon, tintColor: meta.color }}
              title={t.label ?? t.id}
              subtitle={t.devices.join(" → ")}
              accessories={[
                { tag: { value: state, color: meta.color } },
                { date: new Date(t.ts) },
              ]}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="Show Details"
                    icon={Icon.Sidebar}
                    target={<TxnDetail id={t.id} onChanged={revalidate} />}
                  />
                  {t.state === undefined && (
                    <Action
                      title="Abort Transaction"
                      icon={Icon.Undo}
                      style={Action.Style.Destructive}
                      onAction={() => void abortTxn(t.id, revalidate)}
                    />
                  )}
                  <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#txn")} />
                  <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}
