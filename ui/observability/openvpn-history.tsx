import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Database, RefreshCw, Search } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { api, withToken } from "./api";
import { WorkspaceError } from "./operations-ui";
import { connectionDuration } from "../../src/core/openvpn-sessions-model";
import type { HistoryGroup, OpenVpnHistoryReport } from "../../src/observability/openvpn-history";

const timestamp = (at: number) => new Date(at).toLocaleString();
const chartConfig = { count: { label: "Connections", color: "var(--chart-1)" } };

function Breakdown({
  title,
  rows,
  total,
  countries = false,
}: {
  title: string;
  rows: HistoryGroup[];
  total: number;
  countries?: boolean;
}) {
  return (
    <section className="ovpn-history-panel">
      <header>
        <h3>{title}</h3>
        <small>Top 20 · connections</small>
      </header>
      <ScrollArea className="ovpn-breakdown-scroll">
        {rows.length ? (
          rows.map((row) => (
            <div className="ovpn-breakdown" key={row.label}>
              <div>
                <span className="ovpn-breakdown-label">
                  {countries && /^[a-z]{2}$/i.test(row.detail) && (
                    <img
                      width={18}
                      height={18}
                      alt=""
                      src={withToken(`/api/flag/${row.detail.toLowerCase()}`)}
                    />
                  )}
                  <span title={row.label}>{row.label}</span>
                </span>
                <strong>
                  {row.count.toLocaleString()}{" "}
                  <small>{total ? Math.round((row.count / total) * 100) : 0}%</small>
                </strong>
              </div>
              {!countries && <small>{row.detail || "Organization unavailable"}</small>}
              <meter
                min={0}
                max={Math.max(1, total)}
                value={row.count}
                aria-label={`${row.label}: ${row.count} connections`}
              />
            </div>
          ))
        ) : (
          <p className="ovpn-caption">No connections in this selection.</p>
        )}
      </ScrollArea>
    </section>
  );
}

export function OpenVpnHistory({ device }: { device: string }) {
  const [user, setUser] = useState("");
  const [draftUser, setDraftUser] = useState("");
  const [from, setFrom] = useState<Date>();
  const [to, setTo] = useState<Date>();
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [sample, setSample] = useState<{ key: string; data: OpenVpnHistoryReport }>();
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
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
  const total = data?.totals;
  const coverage = data?.coverage;
  const stale = !!error || !coverage || now - coverage.last > 45_000;
  function range(days?: number) {
    setFrom(days ? new Date(now - days * 86400000) : undefined);
    setTo(undefined);
    setOffset(0);
  }
  return (
    <section className="ovpn-history" aria-label="OpenVPN connection history" aria-busy={loading}>
      <div className="ovpn-history-heading">
        <div>
          <span className="ovpn-eyebrow">
            <Database size={14} /> CONNECTION JOURNAL
          </span>
        </div>
        <span className="ovpn-history-local">
          Stored on your MCP host
          <br />
          <small>30s report cache · no router reads on this page</small>
        </span>
      </div>
      <div className="ovpn-history-controls">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setUser(draftUser.trim());
            setOffset(0);
          }}
        >
          <label htmlFor="ovpn-history-user">User · empty for everyone</label>
          <div className="ovpn-history-user">
            <Input
              id="ovpn-history-user"
              list="ovpn-history-users"
              placeholder="Find a username…"
              value={draftUser}
              onChange={(e) => setDraftUser(e.target.value)}
            />
            <Button type="submit" variant="outline" aria-label="Apply user filter">
              <Search size={16} />
            </Button>
          </div>
          <datalist id="ovpn-history-users">
            {data?.users.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </form>
        <div>
          <label>From · local time</label>
          <DateTimePicker
            aria-label="History from"
            value={from}
            onChange={(v) => {
              setFrom(v);
              setOffset(0);
            }}
            max={to}
          />
        </div>
        <div>
          <label>Through · local time</label>
          <DateTimePicker
            aria-label="History through"
            value={to}
            onChange={(v) => {
              setTo(v);
              setOffset(0);
            }}
            min={from}
          />
        </div>
        <Button
          variant="outline"
          disabled={loading || invalid}
          onClick={() => setRevision((r) => r + 1)}
        >
          <RefreshCw size={15} /> Refresh
        </Button>
        <div className="ovpn-history-presets">
          <span>Session start time</span>
          {[7, 30, 90].map((days) => (
            <Button key={days} size="sm" variant="ghost" onClick={() => range(days)}>
              {days} days
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => range()}>
            All recorded
          </Button>
        </div>
      </div>
      {invalid && <WorkspaceError message="From must be before Through." />}
      {error && <WorkspaceError message={error} />}
      {!invalid && !data && !error && (
        <div className="ovpn-empty" role="status">
          Reading local connection history…
        </div>
      )}
      {!invalid && data && (
        <>
          <div className="ovpn-history-coverage" data-stale={stale} role="status">
            <strong>
              {coverage
                ? stale
                  ? "Collection delayed"
                  : "Background collection active"
                : "Waiting for the first successful router read"}
            </strong>
            <span>
              {coverage
                ? `Recording since ${timestamp(coverage.first)} · last read ${timestamp(coverage.last)} · ${coverage.gaps} collection gaps · ${coverage.failures} failed reads`
                : "History begins with this installation. Keep the MCP service running to collect connections."}
            </span>
            <small>
              Read-only sampling every ~15s per pass. Short connections between samples and service
              downtime can be missed. Older history is not backfilled. Start times are estimated
              from router uptime; country and ASN describe the source IP, not the person.
            </small>
          </div>
          <div className="ovpn-history-metrics">
            <div>
              <span>Connections in range</span>
              <strong>{total!.connections.toLocaleString()}</strong>
              <small>
                {data.allTime.toLocaleString()} all recorded · {user || "all users"}
              </small>
            </div>
            <div>
              <span>Distinct source IPs</span>
              <strong>{total!.ips.toLocaleString()}</strong>
              <small>{total!.users.toLocaleString()} users in selection</small>
            </div>
            <div>
              <span>Networks / countries</span>
              <strong>
                {total!.networks} <em>/ {total!.countries}</em>
              </strong>
              <small>Known ASN / known country only</small>
            </div>
            <div>
              <span>Recorded session time</span>
              <strong>
                {(total!.seconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                <em> h</em>
              </strong>
              <small>Sum of last reported uptime, not billable time</small>
            </div>
          </div>
          <section className="ovpn-history-panel">
            <header>
              <div>
                <h3>Connection rhythm</h3>
                <small>
                  Daily starts · UTC · last 90 calendar days of selection; totals cover the full
                  range
                </small>
              </div>
              <span className="ovpn-caption">{user || "All users"}</span>
            </header>
            {total!.connections && data.timeline.length ? (
              <ChartContainer config={chartConfig} className="h-[220px] w-full">
                <BarChart
                  accessibilityLayer
                  data={data.timeline}
                  margin={{ left: 0, right: 12, top: 16 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(day: string) => day.slice(5)}
                    minTickGap={25}
                  />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="count"
                    fill="var(--color-count)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={40}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="ovpn-empty">
                No connections recorded in this range. Try another date range or user.
              </div>
            )}
          </section>
          <div className="ovpn-history-breakdowns">
            <Breakdown title="Source IPs" rows={data.ips} total={total!.connections} />
            <Breakdown
              title="Network organizations"
              rows={data.networks}
              total={total!.connections}
            />
            <Breakdown
              title="Countries"
              rows={data.countries}
              total={total!.connections}
              countries
            />
          </div>
          <section className="ovpn-history-panel">
            <header>
              <div>
                <h3>Connection journal</h3>
                <small>Local time · end detected between last seen and first absent</small>
              </div>
              <span className="ovpn-caption">{total!.connections.toLocaleString()} records</span>
            </header>
            <ScrollArea
              className="ovpn-history-table"
              viewportProps={{ style: { maxHeight: 480 } }}
            >
              <table>
                <thead>
                  <tr>
                    {[
                      "User / source",
                      "Network / country",
                      "Started ≈",
                      "Last seen",
                      "End detected",
                      "Reported uptime",
                    ].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <button
                          className="ovpn-history-user-link"
                          onClick={() => {
                            setDraftUser(session.user);
                            setUser(session.user);
                            setOffset(0);
                          }}
                        >
                          {session.user}
                        </button>
                        <code>{session.ip || "Unknown source"}</code>
                        <small>Tunnel {session.tunnel || "not reported"}</small>
                      </td>
                      <td>
                        {session.organization || session.asn || "Unknown network"}
                        <small>
                          {session.country || "Unknown country"}
                          {session.asn ? ` · ${session.asn}` : ""}
                        </small>
                      </td>
                      <td>
                        {timestamp(session.started)}
                        {coverage && session.started < coverage.first && (
                          <small>Already connected when recording began</small>
                        )}
                        {!!session.uncertain && (
                          <small className="ovpn-history-warning">
                            Timing / continuity uncertain
                          </small>
                        )}
                      </td>
                      <td>{timestamp(session.lastSeen)}</td>
                      <td>
                        {session.ended
                          ? timestamp(session.ended)
                          : stale
                            ? "Unknown · collector delayed"
                            : "Present at last read"}
                      </td>
                      <td>
                        <code>{connectionDuration(session.uptime)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
            {!data.sessions.length && <p className="ovpn-caption">No matching sessions.</p>}
            <footer className="ovpn-history-pagination">
              <small>
                Cached at {timestamp(data.generatedAt)} · {offset + (data.sessions.length ? 1 : 0)}–
                {offset + data.sessions.length}
              </small>
              <Button
                variant="outline"
                size="sm"
                disabled={!offset || loading}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                <ArrowLeft size={14} /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + 50 >= total!.connections || loading}
                onClick={() => setOffset(offset + 50)}
              >
                Next <ArrowRight size={14} />
              </Button>
            </footer>
          </section>
        </>
      )}
    </section>
  );
}
