import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Check,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { api, withToken } from "./api";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  Segmented,
  StatusBadge,
  useStaggerIn,
} from "./monitoring-ui";
import {
  Combobox,
  DateTimePicker,
  DetailList,
  Field,
  RowDrawer,
  RowMenu,
  RowMore,
  tipProps,
} from "./kit";
import { OpenVpnBars, OpenVpnTreemap } from "./openvpn-graphics";
import { connectionDuration } from "../../src/core/openvpn-sessions-model";
import type {
  HistoryGroup,
  HistorySession,
  OpenVpnHistoryReport,
} from "../../src/observability/openvpn-history";

/** "Nov 14, 09:50" in local time. */
const timestamp = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const day = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });

type TreemapView = "person" | "ip" | "asn" | "country";
const treemapViews: { value: TreemapView; label: string }[] = [
  { value: "person", label: "People" },
  { value: "ip", label: "Source IPs" },
  { value: "asn", label: "Networks" },
  { value: "country", label: "Countries" },
];

type Preset = 7 | 30 | 90 | "all";
const PRESETS: { value: Preset | "custom"; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: "all", label: "All recorded" },
];

export function historyTreemapRows(rows: HistoryGroup[], total: number, useOrganization = false) {
  const nodes = rows
    .filter((row) => row.count > 0)
    .map((row) => ({
      name: useOrganization ? row.detail || row.label : row.label,
      detail: row.detail,
      value: row.count,
    }));
  const other = Math.max(0, total - nodes.reduce((sum, node) => sum + node.value, 0));
  if (other) nodes.push({ name: "Other", detail: "Beyond the top 20", value: other });
  return nodes;
}

export const historyTreemapPercent = (value: number, total: number) =>
  total ? Math.round((value / total) * 100) : 0;

function CountryFlag({ code }: { code: string }) {
  const [failed, setFailed] = useState(false);
  const known = /^[a-z]{2}$/i.test(code);
  return (
    <span className="monitor-chip ovpn-country" data-known={known || undefined}>
      {known && !failed ? (
        <img
          width={16}
          height={16}
          alt=""
          src={withToken(`/api/flag/${code.toLowerCase()}`)}
          onError={() => setFailed(true)}
        />
      ) : null}
      {known ? code.toUpperCase() : "—"}
    </span>
  );
}

/** One breakdown panel: label, count, share, a bar against the top row, a detail line. */
function Breakdown({
  title,
  rows,
  total,
  kind,
}: {
  title: string;
  rows: HistoryGroup[];
  total: number;
  kind: "country" | "ip" | "network";
}) {
  const top = Math.max(1, ...rows.map((r) => r.count));
  return (
    <MonitorPanel title={title} description="Top 20 · connections" className="ovpn-breakdown-panel">
      {rows.length ? (
        <div className="ovpn-breakdown-list kit-tips">
          {rows.map((row) => {
            const label = kind === "network" ? row.detail || row.label : row.label;
            const detail =
              kind === "network"
                ? row.label
                : kind === "ip"
                  ? row.detail || "Organization unavailable"
                  : "";
            const share = total ? Math.round((row.count / total) * 100) : 0;
            return (
              <div
                className="ovpn-breakdown"
                key={row.label}
                {...tipProps(() => ({
                  title: label,
                  sub: detail || undefined,
                  rows: [
                    {
                      label: "Connections",
                      value: row.count.toLocaleString(),
                      color: "var(--sig)",
                    },
                    { label: "Share", value: `${share}%` },
                  ],
                  foot: { label: "All in range", value: total.toLocaleString() },
                }))}
              >
                <div className="ovpn-breakdown-line">
                  {kind === "country" && <CountryFlag code={row.detail} />}
                  <span className="ovpn-breakdown-label">{label}</span>
                  <span className="ovpn-mono ovpn-tx ovpn-num">{row.count.toLocaleString()}</span>
                  <span className="ovpn-mono ovpn-faint ovpn-share">{share}%</span>
                </div>
                <span
                  className="monitor-bar ovpn-breakdown-bar"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={Math.max(1, total)}
                  aria-valuenow={row.count}
                  aria-label={`${label}: ${row.count} connections`}
                >
                  <span data-tone="good" style={{ width: `${(row.count / top) * 100}%` }} />
                </span>
                {detail && <span className="ovpn-sub">{detail}</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="ovpn-sub">No connections in this selection.</p>
      )}
    </MonitorPanel>
  );
}

export function OpenVpnHistory({ device, controls }: { device: string; controls?: ReactNode }) {
  const [user, setUser] = useState("");
  const [draftUser, setDraftUser] = useState("");
  const [from, setFrom] = useState<Date>();
  const [to, setTo] = useState<Date>();
  const [preset, setPreset] = useState<Preset | "custom">("all");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [sample, setSample] = useState<{ key: string; data: OpenVpnHistoryReport }>();
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [treemapView, setTreemapView] = useState<TreemapView>("person");
  // The journal row drawer, by session id.
  const [inspect, setInspect] = useState<string | null>(null);
  const journalRef = useRef<HTMLDivElement>(null);
  const fromMs = from?.getTime();
  const toMs = to?.getTime();
  const invalid = fromMs !== undefined && toMs !== undefined && fromMs > toMs;
  const key = JSON.stringify([device, user, fromMs, toMs, offset, revision]);
  const data = sample?.key === key ? sample.data : undefined;
  useEffect(() => {
    if (invalid) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ device, user, offset: String(offset) });
    if (fromMs !== undefined) params.set("from", String(fromMs));
    if (toMs !== undefined) params.set("to", String(toMs));
    async function read() {
      setLoading(true);
      try {
        const report = await api<OpenVpnHistoryReport>(
          `/api/openvpn/history?${params}`,
          AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
        );
        if (!abort.signal.aborted) {
          setSample({ key, data: report });
          setNow(Date.now());
          setError("");
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "History unavailable.");
      } finally {
        if (!abort.signal.aborted) {
          setNow(Date.now());
          setLoading(false);
          timer = setTimeout(() => void read(), 30_000);
        }
      }
    }
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [device, user, fromMs, toMs, offset, revision, invalid, key]);
  useStaggerIn(journalRef, ".ovpn-journal-row", `${device}:${user}:${fromMs}:${toMs}:${offset}`);
  const total = data?.totals;
  const treemapRows =
    data && total
      ? historyTreemapRows(
          treemapView === "person"
            ? data.people
            : treemapView === "ip"
              ? data.ips
              : treemapView === "asn"
                ? data.networks
                : data.countries,
          total.connections,
          treemapView === "asn",
        )
      : [];
  const coverage = data?.coverage;
  const stale = !!error || !coverage || now - coverage.last > 45_000;
  const who = user || "all users";
  const filterUser = (name: string) => {
    setDraftUser(name);
    setUser(name);
    setOffset(0);
  };
  const ended = (session: HistorySession): string =>
    session.ended
      ? timestamp(session.ended)
      : stale
        ? "Unknown · collector delayed"
        : "Present at last read";
  function range(value: Preset | "custom") {
    if (value === "custom") return;
    setPreset(value);
    setFrom(value === "all" ? undefined : new Date(now - value * 86400000));
    setTo(undefined);
    setOffset(0);
  }
  return (
    <section className="ovpn-history" aria-label="OpenVPN connection history" aria-busy={loading}>
      <PageIntro
        eyebrow="OpenVPN · connection history"
        heading="Every observed connection."
        lead="Patterns, source networks and countries across all users, or one person at a time. Stored on your MCP host, so this page never reads the router."
        actions={controls}
      />
      <section className="glass ovpn-history-controls" aria-label="History filters">
        <form
          className="monitor-fl"
          onSubmit={(e) => {
            e.preventDefault();
            setUser(draftUser.trim());
            setOffset(0);
          }}
        >
          <Field label="User · empty for everyone" id="ovpn-history-user">
            {/* The kit stops Enter on its input; Enter on a closed list still applies the filter. */}
            <div
              onKeyDown={(e) => {
                const el = e.target as HTMLElement;
                if (e.key === "Enter" && el.getAttribute("aria-expanded") !== "true")
                  el.closest("form")?.requestSubmit();
              }}
            >
              <Combobox
                label="User · empty for everyone"
                noun="user"
                placeholder="Find a username"
                value={draftUser}
                onChange={setDraftUser}
                options={(data?.users ?? []).map((name) => ({ value: name, label: name }))}
                icon={
                  <button type="submit" className="ovpn-field-icon" aria-label="Apply user filter">
                    <Search aria-hidden="true" />
                  </button>
                }
              />
            </div>
          </Field>
        </form>
        <div className="monitor-fl">
          <span className="monitor-label">From · local time</span>
          <DateTimePicker
            label="History from"
            placeholder="Earliest recorded"
            value={from}
            onChange={(v) => {
              setFrom(v);
              setPreset("custom");
              setOffset(0);
            }}
            max={to}
          />
        </div>
        <div className="monitor-fl">
          <span className="monitor-label">Through · local time</span>
          <DateTimePicker
            label="History through"
            placeholder="Now"
            value={to}
            onChange={(v) => {
              setTo(v);
              setPreset("custom");
              setOffset(0);
            }}
            min={from}
          />
        </div>
        <div className="ovpn-range">
          <Segmented value={preset} options={PRESETS} onChange={range} label="Session start time" />
          <MonitorButton
            disabled={loading || invalid}
            onClick={() => setRevision((r) => r + 1)}
            icon={<RefreshCw aria-hidden="true" />}
          >
            Refresh
          </MonitorButton>
        </div>
      </section>
      {invalid && (
        <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
          From must be before Through.
        </MonitorNote>
      )}
      {error && (
        <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
          {error}
        </MonitorNote>
      )}
      {!invalid && !data && !error && (
        <LoadingState label="Reading connection history" layout="chart" />
      )}
      {!invalid && data && total && (
        <>
          <MonitorNote
            tone={coverage && !stale ? "good" : "warn"}
            role="status"
            icon={
              coverage && !stale ? (
                <Check aria-hidden="true" />
              ) : (
                <TriangleAlert aria-hidden="true" />
              )
            }
            className="ovpn-coverage"
          >
            {coverage ? (
              <>
                <b>{stale ? "Collection delayed." : "Background collection active."}</b> Recording
                since {day(coverage.first)} · last read {clock(coverage.last)} · {coverage.gaps}{" "}
                collection {coverage.gaps === 1 ? "gap" : "gaps"} · {coverage.failures} failed{" "}
                {coverage.failures === 1 ? "read" : "reads"}. Sampled every ~15 s; older history is
                not backfilled.
              </>
            ) : (
              <>
                <b>Waiting for the first successful router read.</b> History begins with this
                installation. Keep the MCP service running to collect connections.
              </>
            )}
          </MonitorNote>
          <MetricStrip label="Connection history summary" className="ovpn-kpis-4">
            <Metric
              label="Connections in range"
              value={total.connections.toLocaleString()}
              hint={`${data.allTime.toLocaleString()} all recorded · ${who}`}
              spark={
                data.timeline.length > 1 ? data.timeline.slice(-12).map((d) => d.count) : undefined
              }
            />
            <Metric
              label="Distinct source IPs"
              value={total.ips.toLocaleString()}
              hint={`${total.users.toLocaleString()} ${total.users === 1 ? "user" : "users"} in selection`}
            />
            <Metric
              label="Networks / countries"
              value={
                <>
                  {total.networks.toLocaleString()} <small>/ {total.countries}</small>
                </>
              }
              hint="known ASN or country only"
            />
            <Metric
              label="Recorded session time"
              value={
                <>
                  {(total.seconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  <small>h</small>
                </>
              }
              hint="sum of reported uptime, not billable"
            />
          </MetricStrip>
          <MonitorPanel
            title="Connection rhythm"
            description="Daily starts · UTC · totals cover the full range."
            extra={<span className="ovpn-mono ovpn-mut">{who}</span>}
          >
            {total.connections && data.timeline.length ? (
              <OpenVpnBars days={data.timeline} />
            ) : (
              <MonitorEmpty compact icon={<CalendarDays />} title="No connections in this range">
                Try another date range or user.
              </MonitorEmpty>
            )}
          </MonitorPanel>
          <section className="ovpn-grid-treemap">
            <MonitorPanel
              title="Where connections come from"
              description="Top 20 plus Other."
              extra={
                <Segmented
                  className="ovpn-treemap-switch"
                  value={treemapView}
                  options={treemapViews}
                  onChange={setTreemapView}
                  label="Group connections by"
                />
              }
              aria-label="Connection distribution treemap"
            >
              {treemapRows.length ? (
                <>
                  <OpenVpnTreemap
                    tiles={treemapRows}
                    total={total.connections}
                    percent={historyTreemapPercent}
                  />
                  <p className="monitor-hint ovpn-treemap-hint">
                    {treemapRows.length} {treemapRows.length === 1 ? "group" : "groups"} ·{" "}
                    {total.connections.toLocaleString()} connections · {who}. Area is the share of
                    connections.
                  </p>
                </>
              ) : (
                <p className="ovpn-sub">No connections in this selection.</p>
              )}
            </MonitorPanel>
            <Breakdown
              title="Countries"
              rows={data.countries}
              total={total.connections}
              kind="country"
            />
          </section>
          <section className="ovpn-grid-halves">
            <Breakdown title="Source IPs" rows={data.ips} total={total.connections} kind="ip" />
            <Breakdown
              title="Network organizations"
              rows={data.networks}
              total={total.connections}
              kind="network"
            />
          </section>
          <MonitorPanel
            title="Connection journal"
            description="Local time · the end is detected between last seen and first absent."
            extra={
              <span className="ovpn-mono ovpn-mut">
                {total.connections.toLocaleString()} records
              </span>
            }
            flush
          >
            <div className="ovpn-journal-scroll">
              <div ref={journalRef} role="table" aria-label="Connection journal">
                <div role="row" className="monitor-thead ovpn-journal-grid">
                  {[
                    "User / source",
                    "Network / country",
                    "Started ≈",
                    "Last seen",
                    "End detected",
                    "Uptime",
                  ].map((label) => (
                    <span role="columnheader" key={label}>
                      {label}
                    </span>
                  ))}
                  <span role="columnheader" />
                </div>
                {data.sessions.map((session) => (
                  <RowMenu
                    key={session.id}
                    title={session.user}
                    sub={`${session.ip || "Unknown source"} · ${timestamp(session.started)}`}
                    onOpen={() => setInspect(session.id)}
                    cells={{
                      user: {
                        value: session.user,
                        filter: () => filterUser(session.user),
                        clearFilter: user ? () => filterUser("") : undefined,
                      },
                      network: { value: session.organization || session.asn },
                      started: { value: timestamp(session.started), kind: "time" },
                      lastSeen: { value: timestamp(session.lastSeen), kind: "time" },
                      ended: { value: session.ended ? timestamp(session.ended) : "", kind: "time" },
                      uptime: { value: connectionDuration(session.uptime), kind: "duration" },
                    }}
                    copies={[
                      { label: "User name", value: session.user },
                      ...(session.ip ? [{ label: "Source IP", value: session.ip }] : []),
                      ...(session.tunnel ? [{ label: "Tunnel IP", value: session.tunnel }] : []),
                    ]}
                    row={session}
                  >
                    <div
                      role="row"
                      tabIndex={0}
                      className="monitor-row ovpn-journal-grid ovpn-journal-row"
                      data-selected={inspect === session.id || undefined}
                      onClick={() => setInspect(session.id)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setInspect(session.id);
                        }
                      }}
                    >
                      <span role="cell" data-col="user" className="ovpn-stack ovpn-stack-2">
                        <button
                          type="button"
                          className="ovpn-history-user-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            filterUser(session.user);
                          }}
                        >
                          {session.user}
                        </button>
                        <span className="ovpn-mono ovpn-mut ovpn-trunc">
                          {session.ip || "Unknown source"} · tunnel{" "}
                          {session.tunnel || "not reported"}
                        </span>
                      </span>
                      <span role="cell" data-col="network" className="ovpn-stack ovpn-stack-2">
                        <span className="ovpn-trunc">
                          {session.organization || session.asn || "Unknown network"}
                        </span>
                        <span className="ovpn-sub ovpn-trunc">
                          {session.country || "Unknown country"}
                          {session.asn ? ` · ${session.asn}` : ""}
                        </span>
                      </span>
                      <span role="cell" data-col="started" className="ovpn-stack ovpn-stack-2">
                        <span className="ovpn-mono">{timestamp(session.started)}</span>
                        {!!session.uncertain && (
                          <span className="ovpn-sub ovpn-warn-text">Timing uncertain</span>
                        )}
                        {coverage && session.started < coverage.first && (
                          <span className="ovpn-sub ovpn-trunc">
                            Already connected when recording began
                          </span>
                        )}
                      </span>
                      <span role="cell" data-col="lastSeen" className="ovpn-mono">
                        {timestamp(session.lastSeen)}
                      </span>
                      <span role="cell" data-col="ended">
                        {session.ended ? (
                          <span className="ovpn-mono">{timestamp(session.ended)}</span>
                        ) : stale ? (
                          <span className="ovpn-mut">Unknown · collector delayed</span>
                        ) : (
                          <StatusBadge tone="good">Present at last read</StatusBadge>
                        )}
                      </span>
                      <span role="cell" data-col="uptime" className="ovpn-mono">
                        {connectionDuration(session.uptime)}
                      </span>
                      <span role="cell">
                        <RowMore />
                      </span>
                    </div>
                  </RowMenu>
                ))}
              </div>
            </div>
            {!data.sessions.length && (
              <p className="ovpn-sub ovpn-journal-empty">No matching sessions.</p>
            )}
            <div className="monitor-foot">
              <span>
                Cached at {clock(data.generatedAt)} · {offset + (data.sessions.length ? 1 : 0)}–
                {offset + data.sessions.length}
              </span>
              <span className="flex-1" />
              <MonitorButton
                size="sm"
                icon={<ChevronLeft aria-hidden="true" />}
                disabled={!offset || loading}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous
              </MonitorButton>
              <MonitorButton
                size="sm"
                icon={<ChevronRight aria-hidden="true" />}
                disabled={offset + 50 >= total.connections || loading}
                onClick={() => setOffset(offset + 50)}
              >
                Next
              </MonitorButton>
            </div>
          </MonitorPanel>
          {(() => {
            const list = data.sessions;
            const at = list.findIndex((x) => x.id === inspect);
            const s = at >= 0 ? list[at]! : null;
            if (!s) return null;
            return (
              <RowDrawer
                open
                onClose={() => setInspect(null)}
                label={`Session details: ${s.user}`}
                status={
                  s.ended
                    ? { tone: "off", label: `Ended ${timestamp(s.ended)}` }
                    : stale
                      ? { tone: "warn", label: "Unknown · collector delayed" }
                      : { tone: "ok", label: "Present at last read" }
                }
                title={s.user}
                meta={`${s.ip || "Unknown source"} · tunnel ${s.tunnel || "not reported"}`}
                rowKey={s.id}
                nav={{
                  index: at,
                  total: list.length,
                  onPrev: at > 0 ? () => setInspect(list[at - 1]!.id) : undefined,
                  onNext: at < list.length - 1 ? () => setInspect(list[at + 1]!.id) : undefined,
                }}
                storageKey="openvpn-history"
                primary={
                  <MonitorButton size="sm" onClick={() => filterUser(s.user)}>
                    Show only {s.user}
                  </MonitorButton>
                }
              >
                <DetailList
                  items={[
                    { label: "User", value: s.user },
                    ...(s.identity ? [{ label: "Identity", value: s.identity, mono: true }] : []),
                    { label: "Source IP", value: s.ip || "Unknown source", mono: true },
                    { label: "Tunnel IP", value: s.tunnel || "not reported", mono: true },
                    { label: "Network", value: s.organization || s.asn || "Unknown network" },
                    ...(s.asn ? [{ label: "ASN", value: s.asn, mono: true }] : []),
                    { label: "Country", value: s.country || "Unknown country" },
                    { label: "Started ≈", value: timestamp(s.started), mono: true },
                    { label: "First seen", value: timestamp(s.firstSeen), mono: true },
                    { label: "Last seen", value: timestamp(s.lastSeen), mono: true },
                    { label: "End detected", value: ended(s), mono: !!s.ended },
                    { label: "Uptime", value: connectionDuration(s.uptime), mono: true },
                    ...(s.uncertain ? [{ label: "Timing", value: "Timing uncertain" }] : []),
                  ]}
                />
              </RowDrawer>
            );
          })()}
        </>
      )}
    </section>
  );
}
