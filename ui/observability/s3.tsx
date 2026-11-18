/**
 * S3 backups (the Rec-S3 board): the off-site copies in the configured
 * bucket. List, download through a short-lived signed link, and delete with
 * an inline confirm.
 */
import "./s3.css";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, Cloud, Download, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { api, postJson } from "./api";
import { BarChart } from "./config-charts";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusBadge,
} from "./monitoring-ui";
import { DetailList, RowDrawer, RowMenu, RowMore } from "./kit";
import { toast } from "./toast-action";

interface S3Object {
  key: string;
  size: number;
  lastModified: string | null;
}

interface S3List {
  configured: boolean;
  target?: string;
  objects: S3Object[];
  truncated?: boolean;
}

const DAY = 86_400_000;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 100 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-11-17 12:01". */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function hhmm(ms: number): string {
  return `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
}

/** The router a key belongs to: the folder right above the file. */
function router(key: string): string {
  const parts = key.split("/");
  return parts.length > 1 ? parts[parts.length - 2]! : key;
}

/** `s3://bucket/prefix` → `bucket`. */
function bucket(target?: string): string {
  if (!target) return "the bucket";
  return target.replace(/^s3:\/\//, "").split("/")[0] || target;
}

/** List, download (presigned) and delete objects in the configured S3 bucket. */
export function S3Manage(): ReactNode {
  const [data, setData] = useState<S3List | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(() => {
    void api<S3List>("/api/s3/list")
      .then(setData)
      .catch(() => setData({ configured: false, objects: [] }));
  }, []);

  useEffect(() => load(), [load]);

  const download = (key: string): void => {
    void api<{ url?: string }>(`/api/s3/presign?key=${encodeURIComponent(key)}`)
      .then((r) => {
        if (r.url) window.open(r.url, "_blank", "noopener");
        else toast.error("Could not generate download link");
      })
      .catch(() => toast.error("Could not generate download link"));
  };

  const del = async (key: string): Promise<void> => {
    setBusy(key);
    const r = await postJson<{ ok?: boolean; error?: string }>("/api/s3/delete", { key }).catch(
      (): { ok?: boolean; error?: string } => ({ error: "request failed" }),
    );
    setBusy(null);
    setConfirm(null);
    if (r.ok) {
      toast.success("S3 object deleted");
      load();
    } else {
      toast.error(r.error ?? "S3 object delete failed");
    }
  };

  if (!data) return <LoadingState label="Loading S3 objects" />;

  if (!data.configured)
    return (
      <section className="s3 grid content-start gap-[18px]">
        <PageIntro eyebrow="S3 backups · off-site copies" verdict="S3 is not configured." />
        <MonitorPanel title="Bucket objects">
          <MonitorEmpty icon={<Cloud />} title="S3 is not configured">
            Add an <span className="mono">s3</span> block (bucket and credentials) to your config to
            manage backup objects here.
          </MonitorEmpty>
        </MonitorPanel>
      </section>
    );

  const objects = [...data.objects].sort(
    (a, b) => Date.parse(b.lastModified ?? "0") - Date.parse(a.lastModified ?? "0"),
  );
  const dated = objects.filter((o) => o.lastModified);
  const newest = dated[0];
  const oldest = dated.at(-1);
  const total = objects.reduce((n, o) => n + o.size, 0);
  const routers = new Set(objects.map((o) => router(o.key))).size;
  const [totalNum, totalUnit] = size(total).split(" ");
  // The chart: the most recent uploads, oldest on the left.
  const chart = dated.slice(0, 12).reverse();
  const n = objects.length;
  const openIndex = open ? objects.findIndex((o) => o.key === open) : -1;
  const opened = openIndex >= 0 ? objects[openIndex] : undefined;
  const step = (d: 1 | -1): (() => void) | undefined => {
    const next = objects[openIndex + d];
    return next ? () => setOpen(next.key) : undefined;
  };
  const modified = (o: S3Object): string =>
    o.lastModified ? stamp(Date.parse(o.lastModified)) : "—";

  return (
    <section className="s3 grid content-start gap-[18px]">
      <PageIntro
        eyebrow="S3 backups · off-site copies"
        verdict={
          <>
            {n} object{n === 1 ? "" : "s"} in <span className="s">{bucket(data.target)}</span>.
          </>
        }
        lead={
          <>
            Target <span className="mono">{data.target ?? "—"}</span>. Upload more with{" "}
            <span className="mono">upload_backup_to_s3</span>. Downloads use a short-lived signed
            link.
          </>
        }
        actions={
          <>
            <MonitorButton variant="ghost" icon={<RefreshCw aria-hidden="true" />} onClick={load}>
              Refresh
            </MonitorButton>
            <StatusBadge tone="good">configured</StatusBadge>
          </>
        }
        aside={
          chart.length > 0 && (
            <div className="glass s3-chart">
              <span className="monitor-label">Object size by upload date</span>
              <BarChart
                label="Object size by upload date"
                values={chart.map((o) => o.size)}
                labels={chart.map((o) => day(Date.parse(o.lastModified!)))}
                cards={(i) => {
                  const o = chart[i]!;
                  const prev = chart[i - 1];
                  const at = Date.parse(o.lastModified!);
                  const delta = prev ? o.size - prev.size : 0;
                  return {
                    title: `${day(at)} ${hhmm(at)}`,
                    sub: router(o.key),
                    rows: [
                      { label: "Size", value: size(o.size), color: "var(--brand)" },
                      { label: "Key", value: o.key.split("/").at(-1) ?? o.key },
                    ],
                    foot: prev
                      ? {
                          label: "vs previous upload",
                          value: `${delta >= 0 ? "+" : "−"}${size(Math.abs(delta))}`,
                        }
                      : undefined,
                  };
                }}
              />
            </div>
          )
        }
      />

      <MetricStrip label="Bucket counts">
        <Metric
          label="Objects"
          value={String(n)}
          hint={data.truncated ? "truncated" : "not truncated"}
          tone={data.truncated ? "warn" : "default"}
        />
        <Metric
          label="Total size"
          value={
            <>
              {totalNum}
              <small>{totalUnit}</small>
            </>
          }
          hint={`across ${routers} router${routers === 1 ? "" : "s"}`}
        />
        <Metric
          label="Newest"
          value={newest ? day(Date.parse(newest.lastModified!)) : "—"}
          hint={
            newest ? `${router(newest.key)} · ${hhmm(Date.parse(newest.lastModified!))}` : "none"
          }
        />
        <Metric
          label="Oldest"
          value={oldest ? day(Date.parse(oldest.lastModified!)) : "—"}
          hint={
            oldest
              ? `${Math.floor((now - Date.parse(oldest.lastModified!)) / DAY)} days old`
              : "none"
          }
        />
      </MetricStrip>

      <MonitorPanel title="Bucket objects" description="Newest first." flush>
        {n === 0 ? (
          <MonitorEmpty compact title="No objects in the bucket">
            Upload one with <span className="mono">upload_backup_to_s3</span>.
          </MonitorEmpty>
        ) : (
          <>
            <div className="monitor-thead s3-table">
              <span>Key</span>
              <span>Size</span>
              <span>Modified</span>
              <span />
              <span />
            </div>
            {objects.map((o) => {
              const asking = confirm === o.key;
              return (
                <RowMenu
                  key={o.key}
                  title={o.key.split("/").at(-1) ?? o.key}
                  sub={`${router(o.key)} · ${size(o.size)} · ${modified(o)}`}
                  onOpen={() => setOpen(o.key)}
                  cells={{
                    key: { value: o.key },
                    size: { value: size(o.size) },
                    modified: { value: o.lastModified ? modified(o) : "", kind: "time" },
                  }}
                  copies={[{ label: "Object key", value: o.key }]}
                  row={o}
                  actions={[
                    {
                      label: "Download",
                      icon: <Download aria-hidden="true" />,
                      onSelect: () => download(o.key),
                    },
                    {
                      label: "Delete",
                      icon: <Trash2 aria-hidden="true" />,
                      danger: true,
                      onSelect: () => setConfirm(o.key),
                    },
                  ]}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${o.key}, ${size(o.size)}`}
                    className="monitor-row s3-table cursor-pointer"
                    data-failed={asking || undefined}
                    data-selected={open === o.key || undefined}
                    onClick={() => setOpen(o.key)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(o.key);
                      }
                    }}
                  >
                    <span data-col="key" className="mono p trunc" title={o.key}>
                      {o.key}
                    </span>
                    <span data-col="size" className="mono">
                      {size(o.size)}
                    </span>
                    <span data-col="modified" className="mono text-muted-foreground">
                      {modified(o)}
                    </span>
                    <span
                      className="s3-actions"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {asking ? (
                        <>
                          <span className="s3-ask">Delete from the bucket?</span>
                          <MonitorButton
                            variant="danger"
                            size="sm"
                            icon={<Check aria-hidden="true" />}
                            disabled={busy === o.key}
                            onClick={() => void del(o.key)}
                          >
                            Confirm
                          </MonitorButton>
                          <MonitorButton variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                            Cancel
                          </MonitorButton>
                        </>
                      ) : (
                        <>
                          <MonitorButton
                            variant="ghost"
                            size="sm"
                            icon={<Download aria-hidden="true" />}
                            onClick={() => download(o.key)}
                          >
                            Download
                          </MonitorButton>
                          <MonitorButton
                            variant="ghost"
                            size="sm"
                            icon={<Trash2 aria-hidden="true" />}
                            onClick={() => setConfirm(o.key)}
                          >
                            Delete
                          </MonitorButton>
                        </>
                      )}
                    </span>
                    <RowMore />
                  </div>
                </RowMenu>
              );
            })}
          </>
        )}
      </MonitorPanel>

      <RowDrawer
        open={Boolean(opened)}
        onClose={() => setOpen(null)}
        label={`Object details: ${opened?.key ?? ""}`}
        title={opened ? (opened.key.split("/").at(-1) ?? opened.key) : ""}
        meta={opened ? `${router(opened.key)} · ${size(opened.size)}` : undefined}
        nav={
          openIndex >= 0
            ? { index: openIndex, total: objects.length, onPrev: step(-1), onNext: step(1) }
            : undefined
        }
        rowKey={opened?.key}
        storageKey="s3"
        actions={
          opened && (
            <MonitorButton
              variant="ghost"
              size="sm"
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => setConfirm(opened.key)}
            >
              Delete
            </MonitorButton>
          )
        }
        primary={
          opened && (
            <MonitorButton
              size="sm"
              icon={<Download aria-hidden="true" />}
              onClick={() => download(opened.key)}
            >
              Download
            </MonitorButton>
          )
        }
      >
        {opened && (
          <DetailList
            items={[
              { label: "Key", value: opened.key, mono: true },
              { label: "Router", value: router(opened.key), mono: true },
              { label: "Size", value: size(opened.size) },
              { label: "Modified", value: modified(opened), mono: true },
            ]}
          />
        )}
      </RowDrawer>

      <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
        Deleting removes the object from the bucket for good. Local backups in the vault are not
        touched.
      </MonitorNote>
    </section>
  );
}
