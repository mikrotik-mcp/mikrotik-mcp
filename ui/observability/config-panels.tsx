/**
 * Config page panels — point-in-time version history and the schema field guide.
 * Split out of `main.tsx` to keep each concern in its own component module.
 */
import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Star, X } from "lucide-react";
import { api, postJson } from "./api";
import { Button, Input } from "./geist";
import { JsonDiffView } from "./highlight";
import { toast } from "./toast-action";
import { cn } from "@/lib/utils";

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
  const showDiff = async (id: string): Promise<void> => {
    if (diffFor === id) {
      setDiffFor(null);
      setDiff(null);
      return;
    }
    setDiffFor(id);
    setDiff(null);
    const d = await api<{ summary: { added: number; removed: number }; unified: string }>(
      `/api/config/history/diff?id=${encodeURIComponent(id)}`,
    ).catch(() => null);
    setDiff(d);
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

  return (
    <>
      {msg && <div className="text-muted-foreground font-mono text-xs">{msg}</div>}
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 14 }}>
        {labelDraft === null ? (
          <Button
            size="sm"
            type="accent"
            icon={<Star className="size-4" />}
            onClick={() => setLabelDraft("")}
          >
            Save checkpoint
          </Button>
        ) : (
          <span className="inline-flex items-center gap-2">
            <Input
              className="w-[min(48vw,380px)]"
              autoFocus
              placeholder="checkpoint name (e.g. pre-upgrade)"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveCheckpoint();
                if (e.key === "Escape") setLabelDraft(null);
              }}
            />
            <Button size="sm" type="accent" onClick={() => void saveCheckpoint()}>
              Save
            </Button>
            <Button size="sm" onClick={() => setLabelDraft(null)}>
              Cancel
            </Button>
          </span>
        )}
        <span className="flex-1" />
        <span className="text-muted-foreground text-[11px]">
          {data.versions.length} versions · {fmtBytes(data.bytes)} · auto-keep {data.retention}
        </span>
      </div>

      {data.versions.length === 0 ? (
        <div className="text-muted-foreground text-[11px]">
          No versions yet — they appear here after each config change.
        </div>
      ) : (
        <ol className="m-0 grid list-none p-0 pl-1.5">
          {data.versions.map((v, i) => {
            const changed = v.drift.added + v.drift.removed;
            return (
              <li
                key={v.id}
                /*
                 * The rail is a `before:` pseudo-element running from this row's dot
                 * down through the bottom of the row, so consecutive rows join into
                 * one continuous line. `last:before:hidden` stops it dangling past
                 * the final dot. Geometry: py-3.5 (14px) + the dot's mt-1 (4px) +
                 * half the 14px dot = 25px to the dot's centre.
                 */
                className="hover:bg-foreground/5 relative grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3 rounded-md px-2.5 py-3.5 transition-colors before:absolute before:top-[25px] before:bottom-0 before:left-[22px] before:w-px before:bg-border last:before:hidden"
              >
                <span
                  className={cn(
                    "relative z-[1] mt-1 justify-self-center rounded-full border-[2.5px]",
                    i === 0
                      ? "border-brand bg-brand ring-brand/25 size-[14px] ring-4"
                      : "border-border bg-card size-[13px]",
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-[9px] text-[12.5px]">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-[0.05em] uppercase",
                        v.kind === "checkpoint"
                          ? "border-warning/45 bg-warning/10 text-warning"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      {v.kind === "checkpoint" ? "★ checkpoint" : "auto"}
                    </span>
                    {v.label && <span className="text-foreground font-semibold">{v.label}</span>}
                    <span className="text-muted-foreground font-mono text-[11.5px]">
                      {fmtWhen(v.ts)}
                    </span>
                    {i === 0 ? (
                      <span className="text-brand font-mono text-[10px] font-semibold tracking-[0.05em] uppercase">
                        latest
                      </span>
                    ) : changed === 0 ? (
                      <span className="text-muted-foreground text-[11.5px]">
                        identical to current
                      </span>
                    ) : (
                      <span className="inline-flex items-baseline gap-[7px] font-mono text-[11.5px]">
                        <span className="text-success">+{v.drift.added}</span>
                        <span className="text-destructive">−{v.drift.removed}</span>
                        <span className="text-muted-foreground text-[11px]"> vs current</span>
                      </span>
                    )}
                  </div>
                  {diffFor === v.id && (
                    <div className="mt-2">
                      {diff ? (
                        diff.unified.trim() ? (
                          <JsonDiffView unified={diff.unified} maxHeight={280} />
                        ) : (
                          <span className="text-muted-foreground text-[11px]">
                            No differences from the current config.
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground text-[11px]">computing diff…</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="mt-px inline-flex flex-none items-center gap-1.5">
                  <Button size="sm" onClick={() => void showDiff(v.id)}>
                    {diffFor === v.id ? "Hide" : "Diff"}
                  </Button>
                  {confirmRestore === v.id ? (
                    <>
                      <Button
                        size="sm"
                        type="accent"
                        disabled={busy}
                        onClick={() => void restore(v.id)}
                      >
                        Confirm restore
                      </Button>
                      <Button size="sm" onClick={() => setConfirmRestore(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      disabled={i === 0}
                      title={i === 0 ? "This is the current config" : "Restore this version"}
                      onClick={() => setConfirmRestore(v.id)}
                    >
                      Restore
                    </Button>
                  )}
                  {v.kind === "checkpoint" && (
                    <Button
                      size="sm"
                      ghost
                      type="error"
                      icon={<X className="size-4" />}
                      title="Delete"
                      onClick={() => void del(v.id)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
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
        <Input
          className="w-[min(360px,60vw)]"
          placeholder="Search fields & descriptions…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
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
