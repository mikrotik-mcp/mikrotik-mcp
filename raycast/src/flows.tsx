/**
 * Flows command — top talkers from collected NetFlow/IPFIX, mirroring the
 * dashboard's Flows page.
 *
 * A list of talkers with bytes as the accessory and a sparkline of that talker's
 * traffic over the window; drilling in shows its conversations and applications.
 * Dimension and window are dropdowns in the search bar.
 *
 * When the list is empty the empty view says WHY — collector stopped, nothing
 * received, templates pending, decode errors — because an empty flow list and an
 * idle link look exactly the same, and that ambiguity is what wastes an evening.
 */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { api, withToken } from "./lib/api";
import { barChart, chartImage, sparklineIcon } from "./lib/charts";
import { useApi, usePolling } from "./lib/hooks";
import type {
  FlowConversation,
  FlowHealth,
  FlowTimelinePayload,
  FlowTopEntry,
  FlowTopPayload,
} from "./lib/types";

const WINDOWS = ["5m", "15m", "1h", "6h", "24h"] as const;
const DIMENSIONS = [
  { id: "source", label: "Source" },
  { id: "destination", label: "Destination" },
  { id: "conversation", label: "Conversation" },
  { id: "application", label: "Application" },
] as const;

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Why is this list empty? The counters answer it; guessing does not. */
function emptyReason(health: FlowHealth | undefined): string {
  const c = health?.collector;
  if (!c || !c.running) {
    return "The local collector is not running. Run start_flow_collector, then point the router at this host with add_traffic_flow_target.";
  }
  if (c.packets === 0) {
    return `Listening on UDP ${c.port} but nothing has arrived. Check /ip traffic-flow is enabled and a target points here.`;
  }
  if (c.templatesPending > 0) {
    return `${c.templatesPending} data set(s) are waiting for their template — v9/IPFIX exporters resend the layout every few minutes, so this clears itself shortly.`;
  }
  if (c.decodeErrors > 0) {
    return `${c.decodeErrors} packet(s) could not be decoded (${c.lastError ?? "unknown"}). Check the target uses version=9 or ipfix.`;
  }
  return "No traffic in this window — the link may simply have been idle.";
}

/** Per-key series from the timeline, for the row sparkline. */
function seriesFor(timeline: FlowTimelinePayload | undefined, key: string): number[] {
  if (!timeline) return [];
  return timeline.buckets.map((b) => b.series[key] ?? 0);
}

function TalkerDetail({ entry, window }: { entry: FlowTopEntry; window: string }) {
  const { data, isLoading } = usePromise(
    (w: string) => api<{ conversations: FlowConversation[] }>(`/api/flows/conversations?window=${w}&limit=50`),
    [window],
  );
  // The address may appear on either side of a conversation.
  const rows = (data?.conversations ?? []).filter(
    (c) => c.src === entry.key || c.dst === entry.key || entry.key.includes(c.src),
  );

  const chart = rows.length
    ? chartImage(
        barChart(
          rows.slice(0, 10).map((c) => ({
            label: c.src === entry.key ? c.dst : c.src,
            value: Math.round(c.bytes / 1024),
            color: Color.Blue,
          })),
          { unit: " KB" },
        ),
        "conversations",
      )
    : "";

  const md = [
    `# ${entry.key}`,
    "",
    `**${humanBytes(entry.bytes)}** over the last ${window} · ${entry.flows} flow(s) · ${(entry.share * 100).toFixed(1)}% of all traffic`,
    chart ? `\n### Talking to\n\n${chart}` : "",
    rows.length
      ? `\n### Conversations\n\n${rows
          .slice(0, 15)
          .map(
            (c) =>
              `- ${c.src} ↔ ${c.dst} — ${humanBytes(c.bytes)} · ${c.applications.slice(0, 3).join(", ")}`,
          )
          .join("\n")}`
      : "\n_No conversation detail for this key in the window._",
  ].join("\n");

  return (
    <Detail
      isLoading={isLoading}
      markdown={md}
      navigationTitle={`Flows · ${entry.key}`}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Address" content={entry.key} />
          <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#flows")} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const [window, setWindow] = useState<string>("1h");
  const [dimension, setDimension] = useState<string>("source");

  const top = useApi<FlowTopPayload>(`/api/flows/top?window=${window}&dimension=${dimension}&limit=25`);
  const timeline = useApi<FlowTimelinePayload>(
    `/api/flows/timeline?window=${window}&dimension=${dimension}&topN=10`,
  );
  const health = useApi<FlowHealth>("/api/flows/health");
  usePolling(() => {
    top.revalidate();
    timeline.revalidate();
    health.revalidate();
  }, 15000);

  const rows = top.data?.top ?? [];
  const totals = top.data?.totals;

  return (
    <List
      isLoading={top.isLoading}
      searchBarPlaceholder="Filter talkers…"
      searchBarAccessory={
        <List.Dropdown tooltip="Window" value={window} onChange={setWindow}>
          {WINDOWS.map((w) => (
            <List.Dropdown.Item key={w} value={w} title={`Last ${w}`} />
          ))}
        </List.Dropdown>
      }
    >
      {rows.length === 0 ? (
        <List.EmptyView
          icon={Icon.BarChart}
          title="No flows"
          description={emptyReason(health.data)}
        />
      ) : (
        <List.Section
          title={DIMENSIONS.find((d) => d.id === dimension)?.label ?? dimension}
          subtitle={
            totals
              ? `${humanBytes(totals.bytes)} · ${totals.flows} flow(s) · last ${window}`
              : undefined
          }
        >
          {rows.map((r) => {
            const spark = sparklineIcon(seriesFor(timeline.data, r.key), Color.Blue);
            return (
              <List.Item
                key={r.key}
                icon={{ source: Icon.Dot, tintColor: r.key === "other" ? Color.SecondaryText : Color.Blue }}
                title={r.key}
                subtitle={`${(r.share * 100).toFixed(1)}%`}
                accessories={[
                  ...(spark ? [{ icon: spark }] : []),
                  { text: humanBytes(r.bytes) },
                ]}
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="Show Details"
                      icon={Icon.Sidebar}
                      target={<TalkerDetail entry={r} window={window} />}
                    />
                    <ActionPanel.Submenu title="Group by Dimension" icon={Icon.Filter}>
                      {DIMENSIONS.map((d) => (
                        <Action key={d.id} title={d.label} onAction={() => setDimension(d.id)} />
                      ))}
                    </ActionPanel.Submenu>
                    <Action.CopyToClipboard title="Copy Address" content={r.key} />
                    <Action.OpenInBrowser title="Open in Dashboard" url={withToken("/#flows")} />
                    <Action
                      title="Refresh"
                      icon={Icon.ArrowClockwise}
                      onAction={() => {
                        top.revalidate();
                        void showToast({ style: Toast.Style.Success, title: "Refreshed" });
                      }}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
