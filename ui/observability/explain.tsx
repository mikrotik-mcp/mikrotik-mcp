/**
 * Explain view — the architecture document for a router, for the person who
 * just inherited it.
 *
 *   • **Exposure panel first**, given its own loud treatment. It is the part
 *     that matters most and the part a long document buries.
 *   • **Topology diagram** drawn with the radial layout the topology radar
 *     already uses (`topology-layout.ts`) — router at the hub, interfaces
 *     around it, bridge ports fanned off their bridge. A Mermaid renderer would
 *     be a megabyte of dependency inlined into a single-file bundle for one
 *     page; the Mermaid SOURCE still travels with the response, because that is
 *     what people paste into a wiki.
 *   • **Compare mode** — two snapshots, with the consequence-level diff between
 *     them rather than a line diff.
 *   • **Export** — copy or download the Markdown in one click, because that is
 *     where this document is going anyway.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { Badge, Button, Dot } from "./geist";
import type { GeistType } from "./geist";
import { renderMarkdown } from "./markdown";
import { toast } from "./toast-action";
import { CX, CY, H, HUB_ID, W, layout } from "./topology-layout";
import type { DevicesPayload, ExplainPayload, NarrativeDiffPayload, SnapshotRow } from "./types";
import { cn } from "@/lib/utils";

const SEVERITY_TYPE: Record<string, GeistType> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "secondary",
};

const IMPACT_TYPE: Record<string, GeistType> = {
  security: "error",
  connectivity: "warning",
  structure: "secondary",
  cosmetic: "secondary",
};

/** Interface kind → the one-word class shown on a node. */
function kindTint(kind: string): string {
  if (kind === "bridge") return "fill-sky-500";
  if (kind === "vlan") return "fill-violet-500";
  if (kind.includes("wireguard") || kind.includes("tunnel") || kind.endsWith("-client")) {
    return "fill-emerald-500";
  }
  if (kind === "wireless" || kind === "wifi") return "fill-amber-500";
  return "fill-slate-400";
}

/**
 * The topology, drawn with the existing radial layout.
 *
 * Top-level interfaces (those with no parent) take the inner ring; anything
 * switched into a bridge or riding on a VLAN parent fans out from it on the
 * outer ring — the same hub/device/neighbour shape the layout was written for.
 */
function Topology({ payload }: { payload: ExplainPayload }): ReactNode {
  const { pos, rInner, rOuter } = useMemo(() => {
    const interfaces = payload.narrative.interfaces;
    const names = new Set(interfaces.map((i) => i.name));
    const parents = interfaces.filter((i) => !i.parent || !names.has(i.parent));
    const children = interfaces.filter((i) => i.parent && names.has(i.parent));
    const parentOf = new Map(children.map((c) => [c.name, c.parent as string]));
    return layout(
      parents.map((i) => ({ id: i.name })),
      children.map((i) => ({ id: i.name })),
      parentOf,
    );
  }, [payload]);

  const byName = new Map(payload.narrative.interfaces.map((i) => [i.name, i]));
  const subnetsOf = new Map<string, string[]>();
  for (const s of payload.narrative.subnets) {
    const list = subnetsOf.get(s.interface);
    if (list) list.push(s.cidr);
    else subnetsOf.set(s.interface, [s.cidr]);
  }

  if (payload.narrative.interfaces.length === 0) {
    return <p className="text-sm text-muted-foreground">No interfaces found in this export.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[480px] w-full">
        <circle
          cx={CX}
          cy={CY}
          r={rInner}
          className="fill-none stroke-border"
          strokeDasharray="3 6"
        />
        <circle
          cx={CX}
          cy={CY}
          r={rOuter}
          className="fill-none stroke-border"
          strokeDasharray="3 6"
        />
        {[...pos.entries()].map(([id, p]) => {
          if (id === HUB_ID) return null;
          const iface = byName.get(id);
          const parent =
            iface?.parent && pos.get(iface.parent) ? pos.get(iface.parent) : pos.get(HUB_ID);
          if (!parent) return null;
          return (
            <line
              key={`l-${id}`}
              x1={parent.x}
              y1={parent.y}
              x2={p.x}
              y2={p.y}
              className={cn("stroke-border", iface?.disabled && "opacity-40")}
              strokeWidth={1.5}
            />
          );
        })}
        <circle cx={CX} cy={CY} r={30} className="fill-foreground" />
        <text
          x={CX}
          y={CY + 4}
          textAnchor="middle"
          className="fill-background text-[11px] font-medium"
        >
          {payload.narrative.identity.name ?? "router"}
        </text>
        {[...pos.entries()].map(([id, p]) => {
          if (id === HUB_ID) return null;
          const iface = byName.get(id);
          const subnets = subnetsOf.get(id) ?? [];
          return (
            <g key={id} className={cn(iface?.disabled && "opacity-45")}>
              <circle cx={p.x} cy={p.y} r={9} className={kindTint(iface?.kind ?? "")} />
              <text
                x={p.x}
                y={p.y - 14}
                textAnchor="middle"
                className="fill-foreground text-[11px]"
              >
                {id}
              </text>
              {subnets.length > 0 && (
                <text
                  x={p.x}
                  y={p.y + 24}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {subnets.join(" ")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ExposurePanel({ payload }: { payload: ExplainPayload }): ReactNode {
  const exposure = payload.narrative.exposure;
  const worst = exposure[0]?.severity;
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        worst === "critical" || worst === "high"
          ? "border-red-500/60 bg-red-500/5"
          : "border-border",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <Dot type={exposure.length === 0 ? "success" : worst === "low" ? "warning" : "error"} />
        <h3 className="text-sm font-semibold">Exposed to the internet</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          {exposure.length === 0 ? "nothing unrestricted" : `${exposure.length} item(s)`}
        </span>
      </div>
      {exposure.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing in the configuration accepts connections from outside without a source
          restriction.
        </p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {exposure.map((e) => (
            <li
              key={`${e.kind}-${e.what}-${e.line}`}
              className="flex flex-wrap items-center gap-2 py-2"
            >
              <Badge type={SEVERITY_TYPE[e.severity] ?? "secondary"}>{e.severity}</Badge>
              <span className="font-medium">{e.what}</span>
              <span className="text-muted-foreground">{e.detail}</span>
              <span className="ml-auto text-xs">
                from <span className={cn(e.from === "anyone" && "text-red-500")}>{e.from}</span>
                <span className="ml-2 text-muted-foreground">line {e.line}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ExplainView(): ReactNode {
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState<string>("");
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [snapshot, setSnapshot] = useState<string>("");
  const [payload, setPayload] = useState<ExplainPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [compare, setCompare] = useState(false);
  const [beforeSnapshot, setBeforeSnapshot] = useState<string>("");
  const [afterSnapshot, setAfterSnapshot] = useState<string>("");
  const [diff, setDiff] = useState<NarrativeDiffPayload | null>(null);
  const [diffing, setDiffing] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [d, s] = await Promise.all([
          api<DevicesPayload>("/api/devices"),
          api<{ snapshots: SnapshotRow[] }>("/api/snapshots?limit=100"),
        ]);
        const names = d.devices.map((x) => x.name);
        setDevices(names);
        setDevice((current) => current || names[0] || "");
        setSnapshots(s.snapshots ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const explain = useCallback(async (): Promise<void> => {
    if (!device) return;
    setLoading(true);
    setError(null);
    try {
      const q = snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : "";
      setPayload(await api<ExplainPayload>(`/api/explain/${encodeURIComponent(device)}${q}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [device, snapshot]);

  const runDiff = async (): Promise<void> => {
    if (!beforeSnapshot) {
      toast.error("Pick a baseline snapshot — a diff needs something to compare against.");
      return;
    }
    setDiffing(true);
    try {
      const res = await postJson<NarrativeDiffPayload & { error?: string }>("/api/explain/diff", {
        device,
        before: beforeSnapshot,
        after: afterSnapshot || undefined,
      });
      if (res.error) toast.error(res.error);
      else setDiff(res);
    } catch (e) {
      toast.error(`Diff failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiffing(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!payload) return;
    await navigator.clipboard.writeText(payload.markdown);
    toast.success("Markdown copied — paste it straight into your wiki");
  };

  const download = (): void => {
    if (!payload) return;
    const blob = new Blob([payload.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${payload.narrative.identity.name ?? device}-narrative.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const roles = payload?.narrative.identity.roles;
  const deviceSnapshots = snapshots.filter((s) => !device || s.device === device);

  return (
    <div className="space-y-4">
      <Panel
        title="Explain a device"
        extra={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              {devices.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              value={snapshot}
              onChange={(e) => setSnapshot(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">live device</option>
              {deviceSnapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label ?? s.id}
                </option>
              ))}
            </select>
            <Button size="sm" loading={loading} onClick={() => void explain()}>
              Explain
            </Button>
            <Button size="sm" type="secondary" onClick={() => setCompare(!compare)}>
              {compare ? "Hide compare" : "Compare"}
            </Button>
          </div>
        }
      >
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!payload && !error && (
          <p className="text-sm text-muted-foreground">
            Reads the configuration (<span className="font-mono">/export</span>, a read-only print
            that writes nothing) and turns it into an architecture document — role, topology,
            addressing, firewall, exposure, tunnels. Pick a snapshot to explain the router as it
            was.
          </p>
        )}
        {payload && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard
                k="Role"
                v={roles?.primary?.label ?? "unknown"}
                sub={roles?.secondary.map((r) => r.label).join(", ") || "no other roles"}
              />
              <StatCard
                k="Exposed"
                v={String(payload.narrative.exposure.length)}
                cls={payload.narrative.exposure.length > 0 ? "text-red-500" : "text-emerald-500"}
                sub="reachable from outside"
              />
              <StatCard
                k="Subnets"
                v={String(payload.narrative.subnets.length)}
                sub={`${payload.narrative.interfaces.length} interfaces`}
              />
              <StatCard
                k="Not covered"
                v={String(payload.narrative.unknowns.length)}
                cls={payload.narrative.unknowns.length > 0 ? "text-amber-500" : undefined}
                sub="menus not analysed"
              />
            </div>
            <ExposurePanel payload={payload} />
            <p className="text-xs text-muted-foreground">
              From the {payload.source} · {payload.narrative.stats.recordCount} configuration
              records
            </p>
          </div>
        )}
      </Panel>

      {compare && (
        <Panel
          title="Compare two configurations"
          extra={
            <Button size="sm" loading={diffing} onClick={() => void runDiff()}>
              Explain the difference
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              value={beforeSnapshot}
              onChange={(e) => setBeforeSnapshot(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2"
            >
              <option value="">pick a baseline…</option>
              {deviceSnapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label ?? s.id}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">→</span>
            <select
              value={afterSnapshot}
              onChange={(e) => setAfterSnapshot(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2"
            >
              <option value="">the device as it is now</option>
              {deviceSnapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label ?? s.id}
                </option>
              ))}
            </select>
          </div>
          {diff && (
            <div className="mt-4">
              {diff.diff.identical ? (
                <p className="text-sm text-muted-foreground">
                  Nothing this analysis covers is different. That is not the same as the two exports
                  being identical — use Snapshots for the line diff.
                </p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {diff.diff.changes.map((c) => (
                    <li key={c.summary} className="flex flex-wrap items-start gap-2 py-2">
                      <Badge type={SEVERITY_TYPE[c.severity] ?? "secondary"}>{c.severity}</Badge>
                      <Badge type={IMPACT_TYPE[c.impact] ?? "secondary"}>{c.impact}</Badge>
                      <span className="flex-1">
                        {c.summary}
                        {c.detail && (
                          <span className="block text-xs text-muted-foreground">{c.detail}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Panel>
      )}

      {payload && (
        <>
          <Panel
            title="Topology"
            extra={
              <span className="text-xs text-muted-foreground">
                bridge ports fan out from their bridge
              </span>
            }
          >
            <Topology payload={payload} />
          </Panel>

          <Panel
            title="The document"
            extra={
              <div className="flex gap-2">
                <Button size="sm" type="secondary" onClick={() => void copy()}>
                  Copy Markdown
                </Button>
                <Button size="sm" type="secondary" onClick={download}>
                  Download
                </Button>
              </div>
            }
          >
            <div
              className="prose prose-sm max-w-none dark:prose-invert"
              // renderMarkdown escapes HTML entities before doing anything else,
              // so device-supplied config text cannot inject markup here.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(payload.markdown) }}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
