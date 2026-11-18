/**
 * Explain view: the architecture document for a router, for the person who
 * just inherited it (the Cfg-Explain board).
 *
 *   • A verdict line up top: the router's role and how much of it is open to
 *     the internet.
 *   • **Exposure panel first**, outlined in pink. It is the part that matters
 *     most and the part a long document buries.
 *   • WANs and subnets as tables, the topology as a radial diagram
 *     (`explain-topology.tsx`). The Mermaid source still travels with the
 *     Markdown, because that is what people paste into a wiki.
 *   • **Compare mode**: two snapshots, with the consequence-level diff between
 *     them rather than a line diff.
 *   • **Export**: copy or download the Markdown in one click.
 */
import "./explain.css";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  ChevronRight,
  Clock,
  Copy,
  Download,
  GitBranch,
  Info,
  Play,
  Sparkle,
} from "lucide-react";
import { api, postJson } from "./api";
import { ExplainTopology } from "./explain-topology";
import { DetailList, RowDrawer, RowMenu, RowMore, Select } from "./kit";
import { LoadingState } from "./loading-state";
import { renderMarkdown } from "./markdown";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  RouterPicker,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import { toast } from "./toast-action";
import type {
  DeviceNarrativePayload,
  DevicesPayload,
  ExplainPayload,
  NarrativeDiffPayload,
  SnapshotRow,
} from "./types";

/** Severity → the boards' `.risk` tone. */
const SEVERITY_RISK: Record<string, string> = {
  critical: "dangerous",
  high: "destructive",
  medium: "write",
  low: "read",
};

/** Impact → the boards' `.risk` tone. */
const IMPACT_RISK: Record<string, string> = {
  security: "destructive",
  connectivity: "write",
  structure: "idem",
  cosmetic: "read",
};

function Risk({ value, map }: { value: string; map: Record<string, string> }): ReactNode {
  return (
    <span className="monitor-risk explain-risk" data-risk={map[value] ?? "read"}>
      {value.toUpperCase()}
    </span>
  );
}

function snapshotLabel(s: SnapshotRow): string {
  const day = new Date(s.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${s.label ?? s.id} · ${day}`;
}

/** "192.168.88.10-192.168.88.254" → ".10–.254" when both ends share a /24. */
function shortRange(range: string): string {
  const [a, b] = range.split("-");
  if (!a || !b) return range;
  const pa = a.split(".");
  const pb = b.split(".");
  if (pa.length === 4 && pb.length === 4 && pa.slice(0, 3).join(".") === pb.slice(0, 3).join(".")) {
    return `.${pa[3]}–.${pb[3]}`;
  }
  return `${a}–${b}`;
}

const ADDRESSING: Record<string, string> = {
  dhcp: "DHCP client",
  pppoe: "PPPoE client",
  tunnel: "tunnel client",
};

function wanAddressing(
  n: DeviceNarrativePayload,
  w: DeviceNarrativePayload["wans"][number],
): string {
  const address =
    w.addressing === "static"
      ? n.interfaces.find((i) => i.name === w.interface)?.addresses[0]
      : undefined;
  const base = ADDRESSING[w.addressing] ?? w.addressing;
  const parts = [address ? `${base} ${address}` : base];
  if (w.distance != null && w.distance > 1) parts.push(`distance ${w.distance}`);
  return parts.join(" · ");
}

function fromLabel(from: string): string {
  return from === "anyone" ? "any address" : from;
}

function ExposurePanel({ payload }: { payload: ExplainPayload }): ReactNode {
  const { exposure, stats } = payload.narrative;
  const worst = exposure[0]?.severity;
  const loud = worst === "critical" || worst === "high";
  return (
    <MonitorPanel
      tone={loud ? "bad" : undefined}
      title={
        <span className="explain-title-led">
          <StatusDot tone={exposure.length === 0 ? "good" : worst === "low" ? "warn" : "bad"} />
          Exposed to the internet
        </span>
      }
      description="Accepts connections from outside with no source restriction."
      extra={
        exposure.length === 0 ? (
          <StatusBadge tone="good" dot={false}>
            nothing open
          </StatusBadge>
        ) : (
          <StatusBadge tone="bad" dot={false}>
            {exposure.length === 1 ? "1 item" : `${exposure.length} items`}
          </StatusBadge>
        )
      }
      flush
    >
      {exposure.length === 0 ? (
        <p className="explain-exp-none">
          Nothing in the configuration accepts connections from outside without a source
          restriction.
        </p>
      ) : (
        exposure.map((e) => (
          <div key={`${e.kind}-${e.what}-${e.line}`} className="explain-exp-row">
            <Risk value={e.severity} map={SEVERITY_RISK} />
            <div className="min-w-0">
              <b className="explain-row-title">{e.what}</b>
              <div className="explain-row-detail">{e.detail}</div>
            </div>
            <span className="explain-exp-from">
              from <span className="mono">{fromLabel(e.from)}</span>
            </span>
            <span className="explain-exp-line">line {e.line}</span>
          </div>
        ))
      )}
      <div className="monitor-foot">
        <Info aria-hidden="true" className="size-4 shrink-0" />
        From the {payload.source} · {stats.recordCount} configuration records · {stats.sections}{" "}
        sections
      </div>
    </MonitorPanel>
  );
}

const WAN_GRID = "explain-grid-wan";
const SUBNET_GRID = "explain-grid-subnet";

/** Click or Enter on a row opens its drawer. */
function rowProps(
  open: () => void,
  selected: boolean,
): {
  role: "button";
  tabIndex: number;
  "data-selected": true | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
} {
  return {
    role: "button",
    tabIndex: 0,
    "data-selected": selected || undefined,
    onClick: open,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    },
  };
}

function navFor(
  index: number,
  total: number,
  go: (i: number) => void,
): { index: number; total: number; onPrev?: () => void; onNext?: () => void } {
  return {
    index,
    total,
    onPrev: index > 0 ? () => go(index - 1) : undefined,
    onNext: index < total - 1 ? () => go(index + 1) : undefined,
  };
}

function WansPanel({ n }: { n: DeviceNarrativePayload }): ReactNode {
  const [open, setOpen] = useState<number | null>(null);
  const cur = open != null ? n.wans[open] : undefined;
  return (
    <MonitorPanel title="WANs" description="How the router reaches the internet." flush>
      <div className="explain-table">
        <div className={`monitor-thead ${WAN_GRID}`}>
          <span>WAN</span>
          <span>Addressing</span>
          <span>Gateway</span>
          <span>NAT</span>
          <span />
        </div>
        {n.wans.length === 0 ? (
          <div className="monitor-row explain-row-empty">No WAN found in this export.</div>
        ) : (
          n.wans.map((w, i) => (
            <RowMenu
              key={`${w.interface}-${w.addressing}`}
              title={w.interface}
              sub={wanAddressing(n, w)}
              onOpen={() => setOpen(i)}
              cells={{
                wan: { value: w.interface },
                addressing: { value: wanAddressing(n, w) },
                gateway: { value: w.gateway ?? "", kind: "ip" },
                nat: { value: w.nat },
              }}
              copies={[{ label: "Interface", value: w.interface }]}
              row={w}
            >
              <div
                className={`monitor-row ${WAN_GRID} cursor-pointer`}
                {...rowProps(() => setOpen(i), open === i)}
              >
                <span data-col="wan" className="trunc">
                  <span className="mono p">{w.interface}</span>
                </span>
                <span data-col="addressing" className="trunc">
                  {wanAddressing(n, w)}
                </span>
                <span data-col="gateway" className="trunc">
                  <span className="mono">{w.gateway ?? "—"}</span>
                </span>
                <span data-col="nat" className="trunc">
                  {w.nat}
                </span>
                <RowMore />
              </div>
            </RowMenu>
          ))
        )}
      </div>
      <RowDrawer
        open={Boolean(cur)}
        onClose={() => setOpen(null)}
        label={`WAN details: ${cur?.interface ?? ""}`}
        title={cur?.interface ?? ""}
        meta={cur ? wanAddressing(n, cur) : undefined}
        nav={open != null ? navFor(open, n.wans.length, setOpen) : undefined}
        rowKey={open ?? undefined}
        storageKey="explain-wan"
      >
        {cur && (
          <DetailList
            items={[
              { label: "WAN", value: cur.interface, mono: true },
              { label: "Addressing", value: wanAddressing(n, cur) },
              { label: "Gateway", value: cur.gateway ?? "—", mono: true },
              { label: "NAT", value: cur.nat },
              ...(cur.distance != null ? [{ label: "Distance", value: String(cur.distance) }] : []),
            ]}
          />
        )}
      </RowDrawer>
    </MonitorPanel>
  );
}

function dhcpText(s: DeviceNarrativePayload["subnets"][number]): string {
  return s.dhcp ? [s.dhcp.pool ?? s.dhcp.server, ...s.dhcp.ranges.map(shortRange)].join(" · ") : "";
}

function SubnetsPanel({ n }: { n: DeviceNarrativePayload }): ReactNode {
  const [open, setOpen] = useState<number | null>(null);
  const cur = open != null ? n.subnets[open] : undefined;
  return (
    <MonitorPanel title="Subnets" description="Addressing and DHCP per interface." flush>
      <div className="explain-table">
        <div className={`monitor-thead ${SUBNET_GRID}`}>
          <span>Subnet</span>
          <span>Interface</span>
          <span>DHCP</span>
          <span>Reserved</span>
          <span />
        </div>
        {n.subnets.length === 0 ? (
          <div className="monitor-row explain-row-empty">No subnets found in this export.</div>
        ) : (
          n.subnets.map((s, i) => (
            <RowMenu
              key={`${s.cidr}-${s.interface}`}
              title={s.cidr}
              sub={s.interface}
              onOpen={() => setOpen(i)}
              cells={{
                subnet: { value: s.cidr, kind: "ip" },
                interface: { value: s.interface },
                dhcp: { value: dhcpText(s) },
                reserved: { value: String(s.reservations.length) },
              }}
              copies={[
                { label: "Subnet", value: s.cidr },
                { label: "Interface", value: s.interface },
              ]}
              row={s}
            >
              <div
                className={`monitor-row ${SUBNET_GRID} cursor-pointer`}
                {...rowProps(() => setOpen(i), open === i)}
              >
                <span data-col="subnet" className="trunc">
                  <span className="mono p">{s.cidr}</span>
                </span>
                <span data-col="interface" className="trunc">
                  <span className="mono">{s.interface}</span>
                  {s.vlanId != null && (
                    <>
                      {" "}
                      <span className="monitor-chip">vlan {s.vlanId}</span>
                    </>
                  )}
                </span>
                <span data-col="dhcp" className="trunc">
                  {s.dhcp ? dhcpText(s) : <span className="text-faint">none</span>}
                </span>
                <span data-col="reserved" className="trunc">
                  <span className="num">{s.reservations.length}</span>
                </span>
                <RowMore />
              </div>
            </RowMenu>
          ))
        )}
      </div>
      <RowDrawer
        open={Boolean(cur)}
        onClose={() => setOpen(null)}
        label={`Subnet details: ${cur?.cidr ?? ""}`}
        title={cur?.cidr ?? ""}
        meta={
          cur ? `${cur.interface}${cur.vlanId != null ? ` · vlan ${cur.vlanId}` : ""}` : undefined
        }
        nav={open != null ? navFor(open, n.subnets.length, setOpen) : undefined}
        rowKey={open ?? undefined}
        storageKey="explain-subnet"
      >
        {cur && (
          <DetailList
            items={[
              { label: "Subnet", value: cur.cidr, mono: true },
              { label: "Interface", value: cur.interface, mono: true },
              ...(cur.vlanId != null ? [{ label: "VLAN", value: String(cur.vlanId) }] : []),
              { label: "DHCP", value: cur.dhcp ? dhcpText(cur) : "none" },
              { label: "Reserved", value: String(cur.reservations.length) },
            ]}
          />
        )}
      </RowDrawer>
    </MonitorPanel>
  );
}

const TOPO_LEGEND = (
  <span className="monitor-legend">
    <span>
      <i style={{ background: "var(--destructive)" }} />
      wan
    </span>
    <span>
      <i style={{ background: "var(--brand)" }} />
      bridge / vlan
    </span>
    <span>
      <i style={{ background: "var(--sig)" }} />
      tunnel
    </span>
    <span>
      <i style={{ background: "var(--warning)" }} />
      wireless
    </span>
  </span>
);

/** "An edge gateway with 2 services open to the internet." */
function Verdict({ n }: { n: DeviceNarrativePayload }): ReactNode {
  const role = (n.identity.roles.primary?.label ?? "unknown role").toLowerCase();
  const article = /^[aeiou]/.test(role) ? "An" : "A";
  const count = n.exposure.length;
  return (
    <>
      {article} <span className="s">{role}</span> with{" "}
      {count === 0 ? (
        <span className="s">nothing</span>
      ) : (
        <em>{count === 1 ? "1 service" : `${count} services`}</em>
      )}{" "}
      open to the internet.
    </>
  );
}

export function ExplainView(): ReactNode {
  const [devices, setDevices] = useState<string[]>([]);
  const [defaultDevice, setDefaultDevice] = useState<string | null>(null);
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
        setDefaultDevice(d.defaultDevice ?? null);
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

  const n = payload?.narrative;
  const roles = n?.identity.roles;
  const deviceSnapshots = snapshots.filter((s) => !device || s.device === device);
  const snapshotOptions = deviceSnapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }));
  const sourceLabel = snapshot
    ? (snapshotOptions.find((o) => o.value === snapshot)?.label ?? snapshot)
    : "live device";

  const comparePanel = compare && (
    <MonitorPanel
      title="Compare two configurations"
      description="What the difference means, not a line diff. Use Snapshots for that."
      extra={
        <MonitorButton
          variant="primary"
          size="sm"
          icon={<Sparkle aria-hidden="true" />}
          disabled={diffing}
          aria-busy={diffing || undefined}
          onClick={() => void runDiff()}
        >
          Explain the difference
        </MonitorButton>
      }
      flush
    >
      <div className="monitor-panel-body explain-compare-pick">
        <Select
          size="sm"
          className="monitor-kit-select explain-select"
          leading={<Archive aria-hidden="true" />}
          value={beforeSnapshot}
          onChange={setBeforeSnapshot}
          label="Baseline configuration"
          options={[{ value: "", label: "pick a baseline…" }, ...snapshotOptions]}
        />
        <ChevronRight aria-hidden="true" className="explain-compare-arrow" />
        <Select
          size="sm"
          className="monitor-kit-select explain-select"
          value={afterSnapshot}
          onChange={setAfterSnapshot}
          label="Comparison configuration"
          options={[{ value: "", label: "the device as it is now" }, ...snapshotOptions]}
        />
      </div>
      {diff &&
        (diff.diff.identical ? (
          <p className="explain-cmp-same">
            Nothing this analysis covers is different. That is not the same as the two exports being
            identical — use Snapshots for the line diff.
          </p>
        ) : (
          diff.diff.changes.map((c) => (
            <div key={c.summary} className="explain-cmp-row">
              <Risk value={c.severity} map={SEVERITY_RISK} />
              <span className="justify-self-start">
                <Risk value={c.impact} map={IMPACT_RISK} />
              </span>
              <div className="min-w-0">
                <b className="explain-row-title">{c.summary}</b>
                {c.detail && <div className="explain-row-detail">{c.detail}</div>}
              </div>
            </div>
          ))
        ))}
    </MonitorPanel>
  );

  return (
    <section className="explain grid content-start gap-[18px]">
      <PageIntro
        eyebrow={`Explain · ${device || "no router"} · ${sourceLabel}`}
        verdict={n ? <Verdict n={n} /> : "Explain how a router is built."}
        lead={
          <>
            Read from <span className="mono">/export</span>, a read-only print that writes nothing.
            Pick a snapshot to explain the router as it was.
          </>
        }
        actions={
          <>
            <RouterPicker
              value={device}
              onChange={setDevice}
              routers={devices}
              defaultRouter={defaultDevice}
              label="Device to explain"
            />
            <Select
              size="sm"
              className="monitor-kit-select explain-select"
              leading={<Clock aria-hidden="true" />}
              value={snapshot}
              onChange={setSnapshot}
              label="Configuration source"
              options={[{ value: "", label: "live device" }, ...snapshotOptions]}
            />
            <MonitorButton
              variant="primary"
              icon={<Play aria-hidden="true" />}
              disabled={loading || !device}
              aria-busy={loading || undefined}
              onClick={() => void explain()}
            >
              Explain
            </MonitorButton>
            <MonitorButton
              variant="ghost"
              icon={<GitBranch aria-hidden="true" />}
              aria-pressed={compare}
              onClick={() => setCompare(!compare)}
            >
              {compare ? "Hide compare" : "Compare"}
            </MonitorButton>
          </>
        }
      />

      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {loading && !payload && <LoadingState label="Reading router architecture" layout="cards" />}

      {payload && n && (
        <>
          <MetricStrip label="Router summary">
            <Metric
              label="Role"
              value={roles?.primary?.label ?? "unknown"}
              hint={
                roles && roles.secondary.length > 0
                  ? `also ${roles.secondary.map((r) => r.label).join(", ")}`
                  : "no other roles"
              }
            />
            <Metric
              label="Exposed"
              value={String(n.exposure.length)}
              hint="reachable from outside"
              tone={n.exposure.length > 0 ? "bad" : "good"}
            />
            <Metric
              label="Subnets"
              value={String(n.subnets.length)}
              hint={`${n.interfaces.length} interfaces`}
            />
            <Metric
              label="Not covered"
              value={String(n.unknowns.length)}
              hint="menus not analysed"
              tone={n.unknowns.length > 0 ? "warn" : "default"}
            />
          </MetricStrip>

          <div className="explain-cols">
            <div className="explain-col">
              <ExposurePanel payload={payload} />
              <WansPanel n={n} />
              <SubnetsPanel n={n} />
            </div>
            <div className="explain-col">
              <MonitorPanel
                title="Topology"
                description="Router at the centre. Bridge ports fan out from their bridge."
                extra={TOPO_LEGEND}
              >
                <ExplainTopology narrative={n} />
              </MonitorPanel>
              {comparePanel}
            </div>
          </div>

          <MonitorPanel
            title="The document"
            description="Markdown, ready for a wiki. Diagram source travels with it."
            extra={
              <div className="flex flex-wrap items-center gap-2">
                <MonitorButton
                  variant="ghost"
                  size="sm"
                  icon={<Copy aria-hidden="true" />}
                  onClick={() => void copy()}
                >
                  Copy Markdown
                </MonitorButton>
                <MonitorButton
                  variant="ghost"
                  size="sm"
                  icon={<Download aria-hidden="true" />}
                  onClick={download}
                >
                  Download
                </MonitorButton>
              </div>
            }
          >
            <div
              className="explain-doc"
              // renderMarkdown escapes HTML entities before doing anything else,
              // so device-supplied config text cannot inject markup here.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(payload.markdown) }}
            />
          </MonitorPanel>
        </>
      )}

      {!payload && comparePanel}
    </section>
  );
}
