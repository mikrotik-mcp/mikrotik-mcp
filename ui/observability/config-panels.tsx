/**
 * Config page panels — point-in-time version history and the schema field guide.
 * Split out of `main.tsx` to keep each concern in its own component module.
 */
import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, postJson } from "./api";
import { DetailList, RowDrawer, RowMenu, RowMore, SearchInput, TextInput } from "./kit";
import { MonitorButton, MonitorEmpty, StatusBadge } from "./monitoring-ui";
import { JsonDiffView } from "./highlight";
import { toast } from "./toast-action";
import "./monitoring.css";

// ── Config: version history (point-in-time) ─────────────────────────────────
interface CfgVersion {
  id: string;
  ts: number;
  kind: "auto" | "checkpoint";
  label?: string;
  bytes: number;
  drift: { added: number; removed: number };
}
interface HistoryResp {
  versions: CfgVersion[];
  bytes: number;
  retention: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtWhen(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Point-in-time config history: timeline, drift vs current, diff, restore, checkpoint. */
export function ConfigHistoryPanel({ onRestored }: { onRestored: () => void }): ReactNode {
  const [data, setData] = useState<HistoryResp | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<{
    summary: { added: number; removed: number };
    unified: string;
  } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState<string | null>(null); // null = checkpoint editor closed

  const load = useCallback(() => {
    void api<HistoryResp>("/api/config/history")
      .then(setData)
      .catch(() => setData({ versions: [], bytes: 0, retention: 50 }));
  }, []);
  useEffect(() => load(), [load]);

  type Simple = { ok?: boolean; error?: string; persisted?: boolean };
  const post = (path: string, b: unknown): Promise<Simple> =>
    postJson<Simple>(path, b).catch((): Simple => ({ error: "request failed" }));

  const saveCheckpoint = async (): Promise<void> => {
    const label = (labelDraft ?? "").trim();
    setLabelDraft(null);
    const r = await post("/api/config/history/checkpoint", { label: label || undefined });
    setMsg(r.ok ? `Checkpoint saved${label ? ` · “${label}”` : ""}` : `Failed: ${r.error}`);
    if (r.ok) {
      toast.success("Checkpoint saved");
      load();
    } else {
      toast.error(r.error ?? "Checkpoint failed");
    }
  };
  // The drawer shows one version's diff; a late answer for another version is dropped.
  const asked = useRef<string | null>(null);
  const openDiff = async (id: string): Promise<void> => {
    asked.current = id;
    setDiffFor(id);
    setDiff(null);
    const d = await api<{ summary: { added: number; removed: number }; unified: string }>(
      `/api/config/history/diff?id=${encodeURIComponent(id)}`,
    ).catch(() => null);
    if (asked.current === id) setDiff(d);
  };
  const closeDiff = (): void => {
    asked.current = null;
    setDiffFor(null);
    setDiff(null);
  };
  const showDiff = async (id: string): Promise<void> => {
    if (diffFor === id) closeDiff();
    else await openDiff(id);
  };
  const restore = async (id: string): Promise<void> => {
    setConfirmRestore(null);
    setBusy(true);
    const r = await post("/api/config/history/restore", { id });
    setBusy(false);
    setMsg(
      r.ok
        ? `Restored ${id}${r.persisted === false ? " (applied live, not persisted)" : ""}`
        : `Restore failed: ${r.error}`,
    );
    if (r.ok) {
      toast.success("Version restored");
      load();
      onRestored();
    } else {
      toast.error(r.error ?? "Restore failed");
    }
  };
  const del = async (id: string): Promise<void> => {
    const r = await post("/api/config/history/delete", { id });
    setMsg(r.ok ? "Version deleted" : `Failed: ${r.error}`);
    if (r.ok) {
      toast.success("Version deleted");
      load();
    } else {
      toast.error(r.error ?? "Delete failed");
    }
  };

  if (!data) return <LoadingState label="Loading configuration history" />;

  const today = new Date().toDateString();
  const prev = new Date();
  prev.setDate(prev.getDate() - 1);
  const yesterday = prev.toDateString();
  const when = (ts: number): string => {
    const d = new Date(ts);
    const time = d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (d.toDateString() === today) return `${time} today`;
    if (d.toDateString() === yesterday) return `Yesterday ${time}`;
    return fmtWhen(ts);
  };

  return (
    <>
      {msg && (
        <p className="monitor-hint px-[18px] pb-2 font-mono" role="status">
          {msg}
        </p>
      )}
      {data.versions.length === 0 ? (
        <MonitorEmpty compact title="No versions yet">
          They appear here after each config change.
        </MonitorEmpty>
      ) : (
        <div className="config-history">
          <div className="monitor-thead config-history-row">
            <span>Saved</span>
            <span>Kind</span>
            <span>Label</span>
            <span>Size</span>
            <span>Drift vs current</span>
            <span />
          </div>
          {data.versions.map((v, i) => {
            const latest = i === 0;
            const changed = v.drift.added + v.drift.removed;
            const share = (n: number): number => Math.min((n / Math.max(changed, 1)) * 60, 60);
            return (
              <RowMenu
                key={v.id}
                title={v.label ?? when(v.ts)}
                sub={`${v.kind} · ${fmtBytes(v.bytes)}`}
                onOpen={() => void openDiff(v.id)}
                cells={{
                  saved: { value: when(v.ts), kind: "time" },
                  kind: { value: v.kind },
                  label: { value: v.label ?? "" },
                  size: { value: fmtBytes(v.bytes) },
                  drift: {
                    value: latest
                      ? "Current config"
                      : changed === 0
                        ? "Identical to current"
                        : `+${v.drift.added} −${v.drift.removed}`,
                  },
                }}
                copies={[{ label: "Version ID", value: v.id }]}
                row={v}
                actions={
                  latest
                    ? []
                    : [
                        {
                          label: "Restore this version",
                          disabled: busy,
                          onSelect: () => setConfirmRestore(v.id),
                        },
                        ...(v.kind === "checkpoint"
                          ? [
                              {
                                label: "Delete checkpoint",
                                icon: <Trash2 aria-hidden="true" />,
                                danger: true,
                                onSelect: () => void del(v.id),
                              },
                            ]
                          : []),
                      ]
                }
              >
                <div
                  role="button"
                  tabIndex={0}
                  className="monitor-row config-history-row cursor-pointer"
                  data-selected={diffFor === v.id || (diffFor == null && latest) || undefined}
                  aria-label={`Version ${v.label ?? when(v.ts)}, ${v.kind}`}
                  onClick={() => void openDiff(v.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void openDiff(v.id);
                    }
                  }}
                >
                  <span data-col="saved" className="truncate font-mono text-xs text-foreground">
                    {when(v.ts)}
                  </span>
                  <span data-col="kind">
                    <StatusBadge tone={v.kind === "checkpoint" ? "brand" : "default"} dot={false}>
                      {v.kind}
                    </StatusBadge>
                  </span>
                  <span data-col="label" className="truncate">
                    {v.label ? (
                      <span className="text-fg-secondary">{v.label}</span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </span>
                  <span data-col="size" className="font-mono text-xs text-muted-foreground">
                    {fmtBytes(v.bytes)}
                  </span>
                  <span data-col="drift" className="text-xs text-muted-foreground">
                    {latest ? (
                      "Current config"
                    ) : changed === 0 ? (
                      "Identical to current"
                    ) : (
                      <span className="monitor-meter">
                        <span className="font-mono text-success">+{v.drift.added}</span>
                        <span className="font-mono text-destructive">−{v.drift.removed}</span>
                        <span className="config-drift-bar" aria-hidden="true">
                          <i style={{ width: share(v.drift.added) }} />
                          <i data-del style={{ width: share(v.drift.removed) }} />
                        </span>
                      </span>
                    )}
                  </span>
                  <span
                    className="flex items-center justify-end gap-1"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {latest ? (
                      <StatusBadge tone="good" dot={false}>
                        latest
                      </StatusBadge>
                    ) : confirmRestore === v.id ? (
                      <>
                        <MonitorButton
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          onClick={() => void restore(v.id)}
                        >
                          Confirm restore
                        </MonitorButton>
                        <MonitorButton
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmRestore(null)}
                        >
                          Cancel
                        </MonitorButton>
                      </>
                    ) : (
                      <>
                        <MonitorButton
                          size="sm"
                          variant="ghost"
                          aria-expanded={diffFor === v.id}
                          onClick={() => void showDiff(v.id)}
                        >
                          {diffFor === v.id ? "Hide" : "Diff"}
                        </MonitorButton>
                        <MonitorButton
                          size="sm"
                          title="Restore this version"
                          onClick={() => setConfirmRestore(v.id)}
                        >
                          Restore
                        </MonitorButton>
                        {v.kind === "checkpoint" && (
                          <MonitorButton
                            size="sm"
                            variant="ghost"
                            icon={<Trash2 aria-hidden="true" />}
                            title="Delete"
                            aria-label={`Delete checkpoint ${v.label ?? when(v.ts)}`}
                            onClick={() => void del(v.id)}
                          />
                        )}
                      </>
                    )}
                  </span>
                  <RowMore />
                </div>
              </RowMenu>
            );
          })}
        </div>
      )}
      {(() => {
        const idx = diffFor ? data.versions.findIndex((x) => x.id === diffFor) : -1;
        const v = idx >= 0 ? data.versions[idx] : undefined;
        const latest = idx === 0;
        const go = (k: number): (() => void) | undefined => {
          const next = data.versions[k];
          return next ? () => void openDiff(next.id) : undefined;
        };
        return (
          <RowDrawer
            open={Boolean(v)}
            onClose={closeDiff}
            label={`Version details: ${v ? (v.label ?? when(v.ts)) : ""}`}
            status={
              v ? { tone: v.kind === "checkpoint" ? "acc" : "off", label: v.kind } : undefined
            }
            title={v ? (v.label ?? when(v.ts)) : ""}
            meta={v ? `${when(v.ts)} · ${fmtBytes(v.bytes)}` : undefined}
            nav={
              v
                ? {
                    index: idx,
                    total: data.versions.length,
                    onPrev: go(idx - 1),
                    onNext: go(idx + 1),
                  }
                : undefined
            }
            rowKey={diffFor ?? undefined}
            storageKey="config-history"
            tabs={
              v
                ? [
                    {
                      id: "diff",
                      label: "Diff",
                      content: diff ? (
                        diff.unified.trim() ? (
                          <JsonDiffView unified={diff.unified} maxHeight={480} />
                        ) : (
                          <span className="monitor-hint">
                            No differences from the current config.
                          </span>
                        )
                      ) : (
                        <span className="monitor-hint">Computing diff…</span>
                      ),
                    },
                    {
                      id: "details",
                      label: "Details",
                      content: (
                        <DetailList
                          items={[
                            { label: "Saved", value: fmtWhen(v.ts), mono: true },
                            { label: "Kind", value: v.kind },
                            { label: "Label", value: v.label ?? "—" },
                            { label: "Size", value: fmtBytes(v.bytes), mono: true },
                            {
                              label: "Drift vs current",
                              value: latest
                                ? "Current config"
                                : `+${v.drift.added} / −${v.drift.removed}`,
                              mono: true,
                            },
                            { label: "ID", value: v.id, mono: true },
                          ]}
                        />
                      ),
                    },
                  ]
                : undefined
            }
            actions={
              v &&
              !latest &&
              v.kind === "checkpoint" && (
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  aria-label={`Delete checkpoint ${v.label ?? when(v.ts)}`}
                  onClick={() => {
                    closeDiff();
                    void del(v.id);
                  }}
                >
                  Delete
                </MonitorButton>
              )
            }
            primary={
              v &&
              (latest ? (
                <StatusBadge tone="good" dot={false}>
                  latest
                </StatusBadge>
              ) : confirmRestore === v.id ? (
                <>
                  <MonitorButton size="sm" variant="ghost" onClick={() => setConfirmRestore(null)}>
                    Cancel
                  </MonitorButton>
                  <MonitorButton
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => void restore(v.id)}
                  >
                    Confirm restore
                  </MonitorButton>
                </>
              ) : (
                <MonitorButton size="sm" onClick={() => setConfirmRestore(v.id)}>
                  Restore
                </MonitorButton>
              ))
            }
          />
        );
      })()}
      <div className="monitor-foot">
        <TextInput
          label="Checkpoint name"
          size="sm"
          icon={<Plus aria-hidden="true" />}
          wrapClassName="config-checkpoint"
          placeholder="checkpoint name, e.g. pre-upgrade"
          value={labelDraft ?? ""}
          onChange={setLabelDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveCheckpoint();
            if (e.key === "Escape") setLabelDraft(null);
          }}
        />
        <MonitorButton size="sm" onClick={() => void saveCheckpoint()}>
          Save checkpoint
        </MonitorButton>
        <span className="flex-1" />
        <span>
          {data.versions.length} versions · {fmtBytes(data.bytes)} · keeps {data.retention}
        </span>
      </div>
    </>
  );
}

// ── Config: schema-driven Field Guide ────────────────────────────────────────
interface GuideField {
  path: string;
  section: string;
  type: string;
  def?: string;
  desc?: string;
  enumv?: string[];
  required: boolean;
}
/** Flatten a JSON Schema into a documented, grouped field list. */
function flattenSchema(schema: Record<string, unknown> | null): GuideField[] {
  if (!schema) return [];
  const out: GuideField[] = [];
  const typeOf = (n: Record<string, unknown> | undefined): string => {
    if (!n) return "any";
    if (Array.isArray(n.enum)) return "enum";
    if (n.type === "array") return `array<${typeOf(n.items as Record<string, unknown>)}>`;
    if (Array.isArray(n.type)) return (n.type as string[]).join(" | ");
    return (n.type as string) ?? (n.properties ? "object" : "any");
  };
  const walk = (
    node: Record<string, unknown>,
    prefix: string,
    section: string,
    required: Set<string>,
  ): void => {
    const props = (node.properties as Record<string, Record<string, unknown>>) ?? {};
    for (const [k, v] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const sec = section || k;
      out.push({
        path,
        section: sec,
        type: typeOf(v),
        def: v.default !== undefined ? JSON.stringify(v.default) : undefined,
        desc: v.description as string | undefined,
        enumv: Array.isArray(v.enum) ? (v.enum as string[]) : undefined,
        required: required.has(k),
      });
      if (v.properties) walk(v, path, sec, new Set((v.required as string[]) ?? []));
      const ap = v.additionalProperties as Record<string, unknown> | undefined;
      if (ap?.properties) walk(ap, `${path}.<name>`, sec, new Set((ap.required as string[]) ?? []));
      const items = v.items as Record<string, unknown> | undefined;
      if (items?.properties)
        walk(items, `${path}[]`, sec, new Set((items.required as string[]) ?? []));
    }
  };
  walk(schema, "", "", new Set((schema.required as string[]) ?? []));
  return out;
}

/** A searchable, grouped guide to every config option — straight from the schema. */
export function FieldGuidePanel(): ReactNode {
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    void api<Record<string, unknown>>("/api/config-schema")
      .then(setSchema)
      .catch(() => {});
  }, []);
  const fields = useMemo(() => flattenSchema(schema), [schema]);
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? fields.filter(
        (f) =>
          f.path.toLowerCase().includes(needle) || (f.desc ?? "").toLowerCase().includes(needle),
      )
    : fields;
  const sections = useMemo(() => {
    const m = new Map<string, GuideField[]>();
    for (const f of filtered) {
      const arr = m.get(f.section) ?? [];
      arr.push(f);
      m.set(f.section, arr);
    }
    return [...m.entries()];
  }, [filtered]);

  if (!schema) return <LoadingState label="Loading configuration schema" layout="form" />;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
        <SearchInput
          label="Search fields"
          wrapClassName="w-[min(360px,60vw)]"
          placeholder="Search fields & descriptions…"
          value={q}
          onChange={setQ}
        />
        <span className="flex-1" />
        <span className="text-muted-foreground text-[11px]">{filtered.length} options</span>
      </div>
      {sections.length === 0 ? (
        <div className="text-muted-foreground text-[11px]">No fields match “{q}”.</div>
      ) : (
        <div className="grid gap-[18px]">
          {sections.map(([sec, fs]) => (
            <div key={sec}>
              <h4 className="text-brand m-0 mb-2 font-mono text-[11px] tracking-[0.09em] uppercase">
                {sec}
              </h4>
              <div className="grid gap-2">
                {fs.map((f) => (
                  <div
                    key={f.path}
                    className="border-border bg-muted/45 hover:border-brand/40 rounded-md border px-[13px] py-[11px] transition-colors"
                  >
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <code className="text-foreground font-mono text-[12.5px] font-medium">
                        {f.path}
                      </code>
                      <span className="text-brand bg-brand/[0.13] rounded-full px-[7px] py-px font-mono text-[10.5px]">
                        {f.type}
                      </span>
                      {f.required && (
                        <span className="text-destructive font-mono text-[10px] tracking-[0.05em] uppercase">
                          required
                        </span>
                      )}
                      {f.def !== undefined && (
                        <span className="text-muted-foreground text-[11px]">
                          default <code className="text-muted-foreground">{f.def}</code>
                        </span>
                      )}
                    </div>
                    {f.desc && (
                      <p className="text-muted-foreground mt-1.5 mb-0 text-[12.5px] leading-[1.5]">
                        {f.desc}
                      </p>
                    )}
                    {f.enumv && (
                      <div className="mt-[7px] flex flex-wrap gap-1.5">
                        {f.enumv.map((e) => (
                          <code
                            key={e}
                            className="border-border text-muted-foreground rounded-md border px-[7px] py-px font-mono text-[11px]"
                          >
                            {e}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
