import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Download,
  RefreshCw,
  ShieldCheck,
  Users,
  Clock3,
  Database,
  Radio,
} from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { api } from "./api";
import { Button, Input, Note, Select } from "./geist";
import { bytes, num } from "./format";
import { saveDownload } from "./workspace-ui";
import type { UmReport } from "../../src/observability/um-reports";
import "./um-reports.css";

const chartConfig = {
  download: { label: "Download", color: "var(--chart-1)" },
  upload: { label: "Upload", color: "var(--chart-2)" },
  cumulativeDownload: { label: "Cumulative download", color: "var(--chart-1)" },
  cumulativeUpload: { label: "Cumulative upload", color: "var(--chart-2)" },
  sessions: { label: "Session starts", color: "var(--chart-1)" },
};
const duration = (s: number): string =>
  s >= 86400
    ? `${(s / 86400).toFixed(1)} days`
    : s >= 3600
      ? `${(s / 3600).toFixed(1)} hrs`
      : `${Math.round(s / 60)} min`;
const sourceNames: Record<string, string> = {
  users: "Users",
  sessions: "Accounting sessions",
  totals: "Live user counters",
  profiles: "Profiles",
  limitations: "Limitations",
  assignments: "Profile assignments",
  profileLimits: "Profile schedules",
  routers: "NAS clients",
  groups: "User groups",
  settings: "Server settings",
};

function ReportCard({
  title,
  eyebrow,
  children,
  className = "",
  extra,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  className?: string;
  extra?: ReactNode;
}) {
  return (
    <section className={`um-card ${className}`}>
      <header className="um-card-heading">
        <div>
          {eyebrow && <p className="um-kicker">{eyebrow}</p>}
          <h3>{title}</h3>
        </div>
        {extra}
      </header>
      {children}
    </section>
  );
}

/** Live router accounting, not a fabricated time series of counter differences. */
export function UmReports({ device }: { device: string }) {
  const [period, setPeriod] = useState("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [user, setUser] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState("daily");
  const [data, setReport] = useState<UmReport | null>(null);
  // Never display the previous router's accounting while switching devices.
  const report = data?.device === device ? data : null;
  const lastRefresh = useRef(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const invalidDates = !!from && !!to && from > to;
  useEffect(() => {
    if (!device || invalidDates) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const query = new URLSearchParams({
      device,
      days: period,
      user,
      from,
      to,
    });
    setLoading(true);
    setError("");
    const load = async (force = false) => {
      let delay = 60_000;
      try {
        const data = await api<UmReport>(
          `/api/aaa/reports?${query}${force ? "&refresh=true" : ""}`,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          if (data.device !== device) throw new Error("Report belongs to a different device.");
          setReport(data);
          setError("");
          delay = Math.max(1000, data.refreshAfterMs);
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Report could not be loaded.");
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void load(), delay);
        }
      }
    };
    void load(refresh !== lastRefresh.current);
    lastRefresh.current = refresh;
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [device, period, user, from, to, refresh, invalidDates]);
  const focus = (name: string) => {
    setUser(name);
  };
  const selected = report?.users.find((u) => u.name === user);
  const ready = report?.sources.sessions.available;
  const summary = report?.summary;
  const issues = report ? Object.entries(report.sources).filter(([, s]) => !s.available) : [];
  const maxUserBytes = report?.users.reduce((n, u) => Math.max(n, u.download + u.upload), 1) ?? 1;
  const maxStarts = report?.series.reduce((n, d) => Math.max(n, d.sessions), 1) ?? 1;
  return (
    <div className="um-reports">
      <div className="um-intro">
        <div>
          <p className="um-kicker">
            <ShieldCheck size={13} /> ACCOUNTING INTELLIGENCE
          </p>
          <h2>
            Every connection.
            <br />
            <span>A clearer picture.</span>
          </h2>
          <p>
            From the whole network to one user. Explore traffic, connection statistics and the
            policies behind them.
          </p>
        </div>
        <div className="um-stamp">
          <Radio size={20} />
          <div>
            <strong>Read-only reporting</strong>
            <span>
              {error || report?.cache?.error
                ? "Router data unavailable"
                : report
                  ? `${report.cache?.refreshing ? "Refreshing cached report" : report.cache?.stale ? "Stale snapshot" : "Cached snapshot"} · ${new Date(report.collectedAt).toLocaleTimeString()}`
                  : "Reading router accounting"}
            </span>
            <small>60-second cache · background refresh · read-only</small>
          </div>
        </div>
      </div>

      <div className="um-controls">
        <label>
          <span>Report scope</span>
          <Select
            aria-label="Report user"
            value={user}
            onValueChange={focus}
            options={[
              { value: "", label: "All users · network overview" },
              ...(report?.users ?? (user ? [{ name: user }] : [])).map((u) => ({
                value: u.name,
                label: u.name,
              })),
            ]}
          />
        </label>
        <label>
          <span>Period · session start date</span>
          <Select
            aria-label="Report period"
            value={period}
            onValueChange={(v) => {
              setPeriod(v);
              setFrom("");
              setTo("");
            }}
            options={[
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
              { value: "365", label: "Last year" },
              { value: "0", label: "All retained history" },
            ]}
          />
        </label>
        <label>
          <span>From</span>
          <Input
            type="date"
            aria-label="From date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
            }}
          />
        </label>
        <label>
          <span>Through</span>
          <Input
            type="date"
            aria-label="Through date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
            }}
          />
        </label>
        <Button
          size="sm"
          ghost
          icon={<RefreshCw />}
          loading={loading && !!device}
          disabled={invalidDates || !device}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh
        </Button>
        <Button
          size="sm"
          ghost
          icon={<Download />}
          disabled={!report || !ready || invalidDates || !!error || loading}
          onClick={() =>
            report &&
            saveDownload(
              "user-manager-report.json",
              JSON.stringify(
                {
                  ...report,
                  sessions: undefined,
                  exportNote:
                    "Statistics cover the full selected period. Individual session records are not included.",
                },
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          Export report
        </Button>
      </div>
      {invalidDates && <Note type="error">The start date must be on or before the end date.</Note>}
      {(loading || report?.cache?.refreshing) && report && (
        <p className="um-caption" role="status">
          {loading
            ? "Updating report… The previous snapshot remains visible until the new filters have loaded."
            : "Refreshing in the background… Showing the cached snapshot until collection completes."}
        </p>
      )}
      {report?.cache?.stale && !error && (
        <Note type="warning" label="Cached report">
          {report.cache.error || "This snapshot is older than 60 seconds and is being refreshed."}{" "}
          Last collected: {new Date(report.collectedAt).toLocaleString()}. Counters are not live.
        </Note>
      )}
      {error && (
        <Note type="error" label="Report unavailable">
          {error}. Check router connectivity and retry. {report && "The snapshot below is stale."}
        </Note>
      )}
      {!device && <Note>Select a configured router to inspect User Manager.</Note>}
      {loading && !report && device && (
        <div className="um-loading" role="status">
          <div className="um-loading-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <h3>Putting your accounting in perspective</h3>
          <p>
            Building the first cached snapshot from the router. Large histories can take more than a
            minute; subsequent visits use the cache while it refreshes in the background.
          </p>
        </div>
      )}
      {report && !report.available && (
        <Note type="warning" label="User Manager is unavailable">
          {report.sources.users.error ||
            "This router did not expose the User Manager menu. Check that the package is installed and your account can read it."}{" "}
          RADIUS client management is still available in the other tabs.
        </Note>
      )}
      {report?.available && (
        <>
          {issues.length > 0 && (
            <Note type="warning" label="Partial report">
              {issues.map(([key]) => sourceNames[key]).join(", ")} could not be read. Missing
              sources are not zero usage; inspect source health below.
            </Note>
          )}
          <div className="um-metrics">
            <div className="um-metric um-download">
              <ArrowDownLeft />
              <span>Download accounted</span>
              <strong>{ready ? bytes(summary!.download) : "—"}</strong>
              <small>Sessions started in the selected period</small>
            </div>
            <div className="um-metric um-upload">
              <ArrowUpRight />
              <span>Upload accounted</span>
              <strong>{ready ? bytes(summary!.upload) : "—"}</strong>
              <small>From the user’s perspective</small>
            </div>
            <div className="um-metric">
              <Activity />
              <span>Active now</span>
              <strong>
                {summary!.active == null ? "—" : num(summary!.active)}
                <em>sessions</em>
              </strong>
              <small>Monitor snapshot · independent of date filter</small>
            </div>
            <div className="um-metric">
              <Clock3 />
              <span>Connected time</span>
              <strong>{ready ? duration(summary!.seconds) : "—"}</strong>
              <small>
                {ready
                  ? `${num(summary!.sessions)} sessions · ${num(summary!.users)} users in period`
                  : "Accounting source unavailable"}
              </small>
            </div>
          </div>
          {selected && (
            <ReportCard
              title={selected.name}
              eyebrow="INDIVIDUAL USER"
              className="um-focus"
              extra={
                <Button size="sm" ghost onClick={() => focus("")}>
                  Back to all users
                </Button>
              }
            >
              <div className="um-user-facts">
                <div>
                  <span>Account</span>
                  <strong>
                    {!selected.configured
                      ? "Historical user"
                      : selected.disabled
                        ? "Disabled"
                        : "Enabled"}
                  </strong>
                </div>
                <div>
                  <span>Active profile</span>
                  <strong>{selected.profile || "Not reported"}</strong>
                </div>
                <div>
                  <span>Group</span>
                  <strong>{selected.group || "—"}</strong>
                </div>
                <div>
                  <span>Total download counter</span>
                  <strong>
                    {selected.totalDownload == null ? "—" : bytes(selected.totalDownload)}
                  </strong>
                </div>
                <div>
                  <span>Total upload counter</span>
                  <strong>
                    {selected.totalUpload == null ? "—" : bytes(selected.totalUpload)}
                  </strong>
                </div>
                <div>
                  <span>Total uptime counter</span>
                  <strong>
                    {selected.totalSeconds == null ? "—" : duration(selected.totalSeconds)}
                  </strong>
                </div>
                <div>
                  <span>Shared users / sub-sessions</span>
                  <strong>
                    {selected.sharedUsers || "—"} / {selected.subSessions ?? "—"}
                  </strong>
                </div>
                <div>
                  <span>Latest session start</span>
                  <strong>{selected.latest || "—"}</strong>
                </div>
              </div>
              {selected.comment && <p className="um-caption">{selected.comment}</p>}
              <p className="um-caption">
                Live counters follow the router’s reset policy; they may differ from retained
                session totals. Neither is a billing ledger.
              </p>
            </ReportCard>
          )}
          {ready ? (
            <>
              <div className="um-main-grid">
                <ReportCard
                  title={user ? `${user} · traffic story` : "The traffic story"}
                  eyebrow="DOWNLOAD / UPLOAD"
                  extra={
                    <div className="um-segment" aria-label="Chart display">
                      {["daily", "cumulative"].map((v) => (
                        <button
                          type="button"
                          key={v}
                          aria-pressed={mode === v}
                          onClick={() => setMode(v)}
                        >
                          {v === "daily" ? "By start day" : "Cumulative"}
                        </button>
                      ))}
                    </div>
                  }
                >
                  <div className="um-chart-legend">
                    <span>
                      <i className="um-blue" />
                      Download
                    </span>
                    <span>
                      <i className="um-teal" />
                      Upload
                    </span>
                    <span>
                      {report.coverage.from} — {report.coverage.to}
                    </span>
                  </div>
                  {report.summary.sessions ? (
                    <ChartContainer config={chartConfig} className="um-traffic-chart">
                      <AreaChart
                        accessibilityLayer
                        data={report.series}
                        margin={{ left: 6, right: 12, top: 12, bottom: 0 }}
                      >
                        <CartesianGrid vertical={false} />
                        <XAxis
                          dataKey="day"
                          tickFormatter={(s: string) => s.slice(5)}
                          minTickGap={32}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis tickFormatter={bytes} width={70} tickLine={false} axisLine={false} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              formatter={(v, name) => (
                                <span>
                                  {chartConfig[name as keyof typeof chartConfig]?.label || name}:{" "}
                                  {bytes(Number(v))}
                                </span>
                              )}
                            />
                          }
                        />
                        <Area
                          type="monotone"
                          dataKey={mode === "daily" ? "download" : "cumulativeDownload"}
                          stroke="var(--chart-1)"
                          fill="var(--chart-1)"
                          fillOpacity={0.15}
                          strokeWidth={2}
                          isAnimationActive={false}
                        />
                        <Area
                          type="monotone"
                          dataKey={mode === "daily" ? "upload" : "cumulativeUpload"}
                          stroke="var(--chart-2)"
                          fill="var(--chart-2)"
                          fillOpacity={0.12}
                          strokeWidth={2}
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ChartContainer>
                  ) : (
                    <div className="um-empty">
                      <Database />
                      <h4>No sessions in this period</h4>
                      <p>
                        Choose a wider period or another user. Accounting must be enabled on the NAS
                        for sessions to be recorded.
                      </p>
                    </div>
                  )}
                  <p className="um-caption">
                    Session byte totals are grouped by the day the session <b>started</b> (
                    {report.clock.zone}). A multi-day session is not split into daily consumption.
                    These are bytes, not real-time speeds.
                  </p>
                </ReportCard>
                <ReportCard
                  title="Who’s using the network"
                  eyebrow="USER BREAKDOWN"
                  className="um-users-card"
                  extra={<Users size={17} />}
                >
                  <p className="um-caption">Select a user to focus every report.</p>
                  <div className="um-user-list">
                    {report.users.length ? (
                      report.users.map((u, i) => (
                        <button
                          key={u.name}
                          type="button"
                          className="um-user-button"
                          aria-pressed={user === u.name}
                          onClick={() => focus(u.name)}
                        >
                          <span className="um-user-rank">{String(i + 1).padStart(2, "0")}</span>
                          <span className="um-user-name">
                            <strong>{u.name}</strong>
                            <small>
                              {u.active == null
                                ? "Monitor unavailable"
                                : u.active
                                  ? `${u.active} active`
                                  : "No active sessions"}{" "}
                              · {num(u.sessions)} in period
                            </small>
                            <span className="um-user-meter">
                              <i
                                style={{
                                  width: `${Math.max(0, ((u.download + u.upload) / maxUserBytes) * 100)}%`,
                                }}
                              />
                            </span>
                          </span>
                          <span className="um-user-bytes">
                            {bytes(u.download + u.upload)}
                            <ArrowRight size={12} />
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="um-caption">No configured or historical users.</p>
                    )}
                  </div>
                </ReportCard>
              </div>
              <div className="um-secondary-grid">
                <ReportCard title="When connections happen" eyebrow="STARTS BY HOUR">
                  <ChartContainer config={chartConfig} className="um-hour-chart">
                    <BarChart accessibilityLayer data={report.hours}>
                      <XAxis dataKey="hour" interval={5} tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} width={38} tickLine={false} axisLine={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar
                        dataKey="sessions"
                        fill="var(--chart-1)"
                        radius={[3, 3, 0, 0]}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ChartContainer>
                  <p className="um-caption">Router time · {report.clock.zone}</p>
                </ReportCard>
                <ReportCard title="How sessions ended" eyebrow="TERMINATION REASONS">
                  <div className="um-breakdown">
                    {report.causes.length ? (
                      report.causes.map((c) => (
                        <div key={c.name}>
                          <span>{c.name}</span>
                          <strong>{num(c.value)}</strong>
                          <meter
                            min={0}
                            max={Math.max(1, report.summary.sessions)}
                            value={c.value}
                            aria-label={`${c.name}: ${c.value} sessions`}
                          />
                        </div>
                      ))
                    ) : (
                      <p className="um-caption">No closed sessions in the selected period.</p>
                    )}
                  </div>
                </ReportCard>
                <ReportCard title="Access points of entry" eyebrow="NAS BREAKDOWN">
                  <div className="um-breakdown">
                    {report.nas.length ? (
                      report.nas.map((n) => (
                        <div key={n.name}>
                          <span>{n.name}</span>
                          <strong>{num(n.sessions)}</strong>
                          <small>
                            ↓ {bytes(n.download)} · ↑ {bytes(n.upload)}
                          </small>
                        </div>
                      ))
                    ) : (
                      <p className="um-caption">No NAS accounting in this period.</p>
                    )}
                  </div>
                </ReportCard>
              </div>
              <ReportCard
                title="Connection calendar"
                eyebrow={user || "ALL USERS"}
                extra={<span className="um-caption">{num(report.summary.sessions)} starts</span>}
              >
                <div
                  className="um-calendar"
                  role="img"
                  aria-label={`Daily session starts for ${user || "all users"}; exact daily data is available below and in Export report.`}
                >
                  {report.series.map((d) => (
                    <div
                      key={d.day}
                      className="um-calendar-day"
                      style={{ opacity: d.sessions ? 0.3 + (0.7 * d.sessions) / maxStarts : 1 }}
                      data-active={d.sessions > 0}
                      title={`${d.day}: ${num(d.sessions)} session starts · ↓ ${bytes(d.download)} · ↑ ${bytes(d.upload)}`}
                    />
                  ))}
                </div>
                <div className="um-calendar-labels">
                  <span>{report.coverage.from}</span>
                  <span>Less ▫ ▪ More</span>
                  <span>{report.coverage.to}</span>
                </div>
                <details className="um-details">
                  <summary>Daily data · accessible table</summary>
                  <div className="um-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Starts</th>
                          <th>Download</th>
                          <th>Upload</th>
                          <th>Uptime</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.series.map((d) => (
                          <tr key={d.day}>
                            <td>{d.day}</td>
                            <td>{num(d.sessions)}</td>
                            <td>{bytes(d.download)}</td>
                            <td>{bytes(d.upload)}</td>
                            <td>{duration(d.seconds)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </ReportCard>
            </>
          ) : (
            <Note type="warning" label="Accounting unavailable">
              No charts are calculated from a failed read. Retry after checking the accounting
              source.
            </Note>
          )}
          <ReportCard
            title={user ? `${user} · policy context` : "The policies behind the numbers"}
            eyebrow="PROFILES, LIMITS & CONFIGURATION"
          >
            <p className="um-caption">
              Configured limits and reset schedules are shown as reported. Remaining quota is not
              inferred from lifetime counters. Financial transactions and credentials are
              intentionally excluded.
            </p>
            <div className="um-inventory">
              {Object.entries(report.inventory).map(([key, rows]) => (
                <details key={key} className="um-details">
                  <summary>
                    <span>{sourceNames[key]}</span>
                    <span className="um-count">
                      {report.sources[key]?.available ? rows.length : "Unavailable"}
                    </span>
                  </summary>
                  {rows.length ? (
                    <div className="um-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {[...new Set(rows.flatMap((r) => Object.keys(r)))]
                              .filter((k) => k !== ".id")
                              .map((k) => (
                                <th key={k}>{k.replaceAll("-", " ")}</th>
                              ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => (
                            <tr key={row[".id"] || i}>
                              {[...new Set(rows.flatMap((r) => Object.keys(r)))]
                                .filter((k) => k !== ".id")
                                .map((k) => (
                                  <td key={k}>{row[k] || "—"}</td>
                                ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="um-empty-small">
                      {report.sources[key]?.available
                        ? "No entries reported."
                        : report.sources[key]?.error || "Source not supported or not read."}
                    </p>
                  )}
                </details>
              ))}
            </div>
          </ReportCard>
          <details className="um-source-health">
            <summary>
              <Database size={14} /> Source health & accounting coverage{" "}
              <span>{num(report.coverage.retained)} retained records</span>
            </summary>
            <p>
              Coverage begins {report.coverage.first || "when accounting records arrive"}. Deleted
              router sessions cannot be reconstructed.{" "}
              {report.coverage.undated > 0 &&
                `${num(report.coverage.undated)} records have no valid start date and are excluded from period totals.`}{" "}
              This is a sequential snapshot, not an atomic capture. Collected in{" "}
              {(report.collectionMs / 1000).toFixed(1)}s; cached for 60 seconds, then refreshed in
              the background. Manual Refresh waits for a new collection.
            </p>
            <div className="um-source-grid">
              {Object.entries(report.sources).map(([key, s]) => (
                <div key={key}>
                  <strong>{sourceNames[key]}</strong>
                  <span>
                    {s.available
                      ? `${num(s.count)} records · read successfully${s.collectionMs == null ? "" : ` · ${(s.collectionMs / 1000).toFixed(1)}s`}`
                      : s.error || "Unsupported or not read"}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
