/**
 * Snapshots (the Rec-Snapshots board): the stored `/export` history of every
 * router. A 7-day lane chart, the table, and the export of the picked row.
 * Pick two snapshots and press Diff for the time-travel diff
 * (Rec-Snapshots-Diff). Pick "diff from…" again to go back.
 */
import "./snapshots.css";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, Archive, History, RefreshCw, X } from "lucide-react";
import { api, postJson } from "./api";
import { DiffPre } from "./config-charts";
import type { DiffSummary } from "./config-studio";
import { clock } from "./format";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import { DetailList, RowDrawer, RowMenu, RowMore, Select } from "./kit";
import { SnapshotTimeline } from "./snapshot-timeline";
import { toast } from "./toast-action";

interface Snapshot {
  id: string;
  device: string;
  ts: number;
  label?: string;
  rosVersion?: string;
  bytes: number;
  lines: number;
  sha: string;
  body?: string;
}

const DAY = 86_400_000;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "Nov 17 14:02", as on the board. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString([], { month: "short", day: "2-digit" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function span(a: number, b: number): string {
  const days = Math.round(Math.abs(b - a) / DAY);
  if (days === 0) return "the same day";
  if (days === 7) return "a week";
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Browse stored `/export` snapshots and time-travel diff any two. */
export function SnapshotsView(): ReactNode {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sel, setSel] = useState<Snapshot | null>(null);
  const [diff, setDiff] = useState<{
    summary: DiffSummary;
    unified: string;
    from: string;
    to: string;
  } | null>(null);

  const load = useCallback(() => {
    void api<{ snapshots: Snapshot[] }>("/api/snapshots")
      .then((r) => setSnaps(r.snapshots))
      .catch(() => setSnaps([]));
  }, []);

  useEffect(() => load(), [load]);

  const viewBody = (id: string): void => {
    void api<Snapshot>(`/api/snapshot/${encodeURIComponent(id)}`)
      .then(setSel)
      .catch(() => {});
  };

  const runDiff = (): void => {
    if (!from || !to) return;
    void postJson<{ summary: DiffSummary; unified: string }>("/api/snapshots/diff", { from, to })
      .then((r) => setDiff({ ...r, from, to }))
      .catch(() => toast.error("Diff failed"));
  };

  const pickFrom = (v: string): void => {
    setFrom(v);
    if (!v) setDiff(null);
  };
  const pickTo = (v: string): void => {
    setTo(v);
    if (!v) setDiff(null);
  };

  if (!snaps) return <LoadingState label="Loading snapshots" />;

  if (snaps.length === 0)
    return (
      <section className="snaps grid content-start gap-[18px]">
        <PageIntro
          eyebrow="Snapshots · config history"
          verdict="No snapshots yet."
          lead={
            <>
              Each snapshot is a stored <span className="mono">/export</span>. Capture one with{" "}
              <span className="mono">capture_config_snapshot</span>.
            </>
          }
        />
        <MonitorPanel title="Config snapshots">
          <MonitorEmpty icon={<History />} title="No config snapshots yet">
            Capture one with <span className="mono">capture_config_snapshot</span>, then diff any
            two here.
          </MonitorEmpty>
        </MonitorPanel>
      </section>
    );

  const opts = snaps.map((s) => ({
    value: s.id,
    label: `${s.device} · ${s.label ?? s.id} · ${stamp(s.ts)}`,
  }));
  const devices = [...new Set(snaps.map((s) => s.device))];
  const newest = snaps.reduce((a, b) => (b.ts > a.ts ? b : a));
  const total = snaps.reduce((n, s) => n + s.bytes, 0);
  const sizeByDevice = new Map<string, number>();
  for (const s of snaps) sizeByDevice.set(s.device, (sizeByDevice.get(s.device) ?? 0) + s.bytes);
  const largest = [...sizeByDevice.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
  const [totalNum, totalUnit] = size(total).split(" ");

  const fromSnap = diff ? snaps.find((s) => s.id === diff.from) : undefined;
  const toSnap = diff ? snaps.find((s) => s.id === diff.to) : undefined;
  const a = diff?.summary.added ?? 0;
  const r = diff?.summary.removed ?? 0;

  const selIndex = sel ? snaps.findIndex((s) => s.id === sel.id) : -1;

  const table = (
    <MonitorPanel
      title="Config snapshots"
      description="Newest first. Pick a row to read its export."
      flush
    >
      <div className="monitor-thead snaps-table">
        <span>Captured</span>
        <span>Device</span>
        <span>Label</span>
        <span>Version</span>
        <span>Lines</span>
        <span>Size</span>
        <span />
      </div>
      {snaps.map((s) => (
        <RowMenu
          key={s.id}
          title={s.label ?? s.id}
          sub={`${s.device} · ${stamp(s.ts)}`}
          onOpen={() => viewBody(s.id)}
          cells={{
            captured: { value: stamp(s.ts), kind: "time" },
            device: { value: s.device, kind: "router" },
            label: { value: s.label ?? "" },
            version: { value: s.rosVersion ?? "" },
            lines: { value: s.lines.toLocaleString() },
            size: { value: size(s.bytes) },
          }}
          copies={[
            { label: "Snapshot ID", value: s.id },
            { label: "SHA", value: s.sha },
          ]}
          row={s}
          actions={[
            {
              label: "Diff from this snapshot",
              icon: <Archive aria-hidden="true" />,
              onSelect: () => pickFrom(s.id),
            },
            {
              label: "Diff to this snapshot",
              icon: <ArrowRight aria-hidden="true" />,
              onSelect: () => pickTo(s.id),
            },
          ]}
        >
          <div
            role="button"
            tabIndex={0}
            className="monitor-row snaps-table cursor-pointer"
            data-selected={sel?.id === s.id || undefined}
            aria-pressed={sel?.id === s.id}
            title={clock(s.ts)}
            onClick={() => viewBody(s.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                viewBody(s.id);
              }
            }}
          >
            <span data-col="captured" className="mono trunc text-muted-foreground">
              {stamp(s.ts)}
            </span>
            <span data-col="device" className="flex min-w-0 items-center gap-2.5">
              <StatusDot tone="good" />
              <span className="mono p trunc">{s.device}</span>
            </span>
            <span data-col="label" className="flex min-w-0 items-center gap-1.5">
              <span className="trunc">{s.label ?? "—"}</span>
              {diff?.from === s.id && <span className="monitor-chip snaps-chip-from">from</span>}
              {diff?.to === s.id && <span className="monitor-chip snaps-chip-to">to</span>}
            </span>
            <span data-col="version" className="mono trunc">
              {s.rosVersion ?? "—"}
            </span>
            <span data-col="lines" className="num">
              {s.lines.toLocaleString()}
            </span>
            <span data-col="size" className="mono trunc">
              {size(s.bytes)}
            </span>
            <RowMore />
          </div>
        </RowMenu>
      ))}
    </MonitorPanel>
  );

  const step = (d: 1 | -1): (() => void) | undefined => {
    const next = snaps[selIndex + d];
    return next ? () => viewBody(next.id) : undefined;
  };

  const drawer = (
    <RowDrawer
      open={Boolean(sel)}
      onClose={() => setSel(null)}
      label={`Snapshot details: ${sel?.label ?? sel?.id ?? ""}`}
      title={`Snapshot · ${sel?.label ?? sel?.id ?? ""}`}
      meta={sel ? `${sel.device} · ${sel.lines.toLocaleString()} lines` : undefined}
      nav={
        selIndex >= 0
          ? { index: selIndex, total: snaps.length, onPrev: step(-1), onNext: step(1) }
          : undefined
      }
      rowKey={sel?.id}
      storageKey="snapshots"
      tabs={
        sel
          ? [
              {
                id: "export",
                label: "Export",
                content: (
                  <pre
                    className="monitor-pre snaps-export"
                    style={{ maxHeight: 460, overflow: "auto" }}
                  >
                    {sel.body || "(empty)"}
                  </pre>
                ),
              },
              {
                id: "details",
                label: "Details",
                content: (
                  <DetailList
                    items={[
                      { label: "Captured", value: stamp(sel.ts), mono: true },
                      { label: "Device", value: sel.device, mono: true },
                      { label: "Label", value: sel.label ?? "—" },
                      { label: "Version", value: sel.rosVersion ?? "—", mono: true },
                      { label: "Lines", value: sel.lines.toLocaleString() },
                      { label: "Size", value: size(sel.bytes) },
                      { label: "SHA", value: sel.sha, mono: true },
                      { label: "ID", value: sel.id, mono: true },
                    ]}
                  />
                ),
              },
            ]
          : undefined
      }
      actions={
        sel && (
          <>
            <MonitorButton
              variant="ghost"
              size="sm"
              icon={<Archive aria-hidden="true" />}
              onClick={() => pickFrom(sel.id)}
            >
              Diff from
            </MonitorButton>
            <MonitorButton
              variant="ghost"
              size="sm"
              icon={<ArrowRight aria-hidden="true" />}
              onClick={() => pickTo(sel.id)}
            >
              Diff to
            </MonitorButton>
          </>
        )
      }
      primary={
        <MonitorButton
          variant="ghost"
          size="sm"
          icon={<X aria-hidden="true" />}
          onClick={() => setSel(null)}
        >
          Close
        </MonitorButton>
      }
    />
  );

  const body = (
    <>
      {table}
      {drawer}
    </>
  );

  if (diff)
    return (
      <section className="snaps grid content-start gap-[18px]">
        <PageIntro
          eyebrow="Snapshots · time-travel diff"
          verdict={
            !diff.summary.changed ? (
              <>
                The two snapshots are <span className="s">identical</span>.
              </>
            ) : (
              <>
                {toSnap?.device ?? "The router"} changed <span className="s">+{a}</span> /{" "}
                <em>−{r}</em> lines
                {fromSnap && toSnap ? ` in ${span(fromSnap.ts, toSnap.ts)}` : ""}.
              </>
            )
          }
          lead={
            fromSnap &&
            toSnap && (
              <>
                From <span className="mono">{fromSnap.label ?? fromSnap.id}</span> (
                {day(fromSnap.ts)}) to <span className="mono">{toSnap.label ?? toSnap.id}</span> (
                {day(toSnap.ts)}).
              </>
            )
          }
          actions={
            <>
              <Select
                size="sm"
                className="monitor-kit-select snaps-select"
                leading={<Archive aria-hidden="true" />}
                value={from}
                onChange={pickFrom}
                options={opts}
                placeholder="diff from…"
                label="Diff from snapshot"
              />
              <span className="snaps-arrow" aria-hidden="true">
                <ArrowRight />
              </span>
              <Select
                size="sm"
                className="monitor-kit-select snaps-select"
                value={to}
                onChange={pickTo}
                options={opts}
                placeholder="to…"
                label="Diff to snapshot"
              />
              <MonitorButton
                variant="primary"
                icon={<ArrowRight aria-hidden="true" />}
                disabled={!from || !to}
                onClick={runDiff}
              >
                Diff
              </MonitorButton>
            </>
          }
        />
        <MonitorPanel
          title="Last 7 days"
          description="The dashed line joins the two snapshots you are comparing."
          extra={
            <span className="monitor-legend">
              <span>
                <i className="bg-brand" />
                from
              </span>
              <span>
                <i className="bg-sig" />
                to
              </span>
            </span>
          }
        >
          <SnapshotTimeline snaps={snaps} from={diff.from} to={diff.to} />
        </MonitorPanel>
        <MonitorPanel
          title="Time-travel diff"
          description="Unified diff of the two exports."
          extra={
            <StatusBadge tone={diff.summary.changed ? "warn" : "good"} dot={false}>
              {diff.summary.changed ? `+${a} / −${r}` : "identical"}
            </StatusBadge>
          }
        >
          <DiffPre text={diff.unified} maxHeight={320} />
        </MonitorPanel>
        {body}
      </section>
    );

  return (
    <section className="snaps grid content-start gap-[18px]">
      <PageIntro
        eyebrow="Snapshots · config history"
        verdict={
          <>
            {snaps.length} snapshot{snaps.length === 1 ? "" : "s"} across {devices.length} router
            {devices.length === 1 ? "" : "s"}. <span className="s">Diff any two.</span>
          </>
        }
        lead={
          <>
            Each snapshot is a stored <span className="mono">/export</span>. Capture more with{" "}
            <span className="mono">capture_config_snapshot</span>.
          </>
        }
        actions={
          <>
            <Select
              size="sm"
              className="monitor-kit-select snaps-select"
              leading={<Archive aria-hidden="true" />}
              value={from}
              onChange={pickFrom}
              options={opts}
              placeholder="diff from…"
              label="Diff from snapshot"
            />
            <Select
              size="sm"
              className="monitor-kit-select snaps-select"
              value={to}
              onChange={pickTo}
              options={opts}
              placeholder="to…"
              label="Diff to snapshot"
            />
            <MonitorButton
              variant="primary"
              icon={<ArrowRight aria-hidden="true" />}
              disabled={!from || !to}
              onClick={runDiff}
            >
              Diff
            </MonitorButton>
            <MonitorButton variant="ghost" icon={<RefreshCw aria-hidden="true" />} onClick={load}>
              Refresh
            </MonitorButton>
          </>
        }
      />

      <MetricStrip label="Snapshot counts">
        <Metric label="Snapshots" value={String(snaps.length)} hint="stored on the MCP server" />
        <Metric label="Routers" value={String(devices.length)} hint="with at least one" />
        <Metric
          label="Newest"
          value={new Date(newest.ts).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
          hint={`${newest.device} · ${newest.label ?? newest.id}`}
        />
        <Metric
          label="Total size"
          value={
            <>
              {totalNum}
              <small>{totalUnit}</small>
            </>
          }
          hint={`largest: ${largest}`}
        />
      </MetricStrip>

      <MonitorPanel title="Last 7 days" description="One lane per router. Each dot is a snapshot.">
        <SnapshotTimeline snaps={snaps} />
      </MonitorPanel>

      {body}
    </section>
  );
}
