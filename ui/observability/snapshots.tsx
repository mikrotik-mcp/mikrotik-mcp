import { UnifiedDiff } from "./diff-view";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { History, RefreshCw, X } from "lucide-react";
import { api, postJson } from "./api";
import { Panel } from "./atoms";
import type { DiffSummary } from "./config-studio";
import { bytes, clock } from "./format";
import { Button, Select } from "./geist";
import { toast } from "./toast-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ── Config snapshots view ────────────────────────────────────────────────────
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

/** Browse stored `/export` snapshots and time-travel diff any two. */
export function SnapshotsView(): ReactNode {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sel, setSel] = useState<Snapshot | null>(null);
  const [diff, setDiff] = useState<{ summary: DiffSummary; unified: string } | null>(null);

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
      .then(setDiff)
      .catch(() => toast.error("Diff failed"));
  };

  if (!snaps) return <div className="text-muted-foreground text-[11px]">loading snapshots…</div>;
  if (snaps.length === 0) {
    return (
      <div className="grid justify-items-center gap-2 rounded-lg border border-dashed border-border px-4 py-[54px] text-center">
        <History className="size-7 text-muted-foreground" />
        <p className="font-semibold text-foreground">No config snapshots yet</p>
        <p className="max-w-[460px] text-xs text-muted-foreground">
          Capture one with the <code>capture_config_snapshot</code> tool — then time-travel diff any
          two here.
        </p>
      </div>
    );
  }

  const opts = snaps.map((s) => ({
    value: s.id,
    label: `${s.device} · ${s.label ?? s.id} · ${clock(s.ts)}`,
  }));

  return (
    <section className="grid content-start gap-[18px]">
      <Panel
        title="Config snapshots"
        className="reveal"
        extra={
          <Button size="sm" icon={<RefreshCw />} onClick={load}>
            Refresh
          </Button>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select
            value={from}
            onValueChange={setFrom}
            aria-label="Diff from snapshot"
            options={[{ value: "", label: "diff from…" }, ...opts]}
          />
          <Select
            value={to}
            onValueChange={setTo}
            aria-label="Diff to snapshot"
            options={[{ value: "", label: "to…" }, ...opts]}
          />
          <Button size="sm" onClick={runDiff} disabled={!from || !to}>
            Diff →
          </Button>
          <span className="text-muted-foreground text-[11px]">{snaps.length} snapshots</span>
        </div>
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>captured</TableHead>
                <TableHead>device</TableHead>
                <TableHead>label</TableHead>
                <TableHead>version</TableHead>
                <TableHead className="text-right">lines</TableHead>
                <TableHead className="text-right">size</TableHead>
                <TableHead>output</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snaps.map((s) => (
                <TableRow
                  key={s.id}
                  className="cursor-pointer"
                  data-state={sel?.id === s.id ? "selected" : undefined}
                  onClick={() => viewBody(s.id)}
                >
                  <TableCell>{clock(s.ts)}</TableCell>
                  <TableCell>{s.device}</TableCell>
                  <TableCell>{s.label ?? "—"}</TableCell>
                  <TableCell>{s.rosVersion ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.lines}</TableCell>
                  <TableCell className="text-right tabular-nums">{bytes(s.bytes)}</TableCell>
                  <TableCell className="max-w-[320px] truncate text-muted-foreground">
                    view export →
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      {diff && (
        <Panel
          title="Time-travel diff"
          className="reveal"
          extra={
            <span className="text-muted-foreground text-[11px]">
              {diff.summary.changed
                ? `+${diff.summary.added} / -${diff.summary.removed}`
                : "identical"}
            </span>
          }
        >
          <UnifiedDiff unified={diff.unified || ""} maxHeight={320} />
        </Panel>
      )}

      {sel && (
        <Panel
          title={`Snapshot · ${sel.label ?? sel.id}`}
          className="reveal"
          extra={
            <Button type="secondary" size="sm" icon={<X />} onClick={() => setSel(null)}>
              Close
            </Button>
          }
        >
          <pre
            className="m-0 overflow-auto rounded border border-border bg-background p-3 font-mono text-xs break-words whitespace-pre-wrap"
            style={{ maxHeight: 460 }}
          >
            {sel.body || "(empty)"}
          </pre>
        </Panel>
      )}
    </section>
  );
}
