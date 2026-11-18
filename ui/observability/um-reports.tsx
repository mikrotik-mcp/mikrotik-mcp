import { useEffect, useRef, useState } from "react";
import { format, isValid, parseISO } from "date-fns";
import type { ReactNode } from "react";
import { ChevronRight, Download, RefreshCw } from "lucide-react";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { api } from "./api";
import { num } from "./format";
import { saveDownload } from "./workspace-ui";
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
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { AaaSelect, compactBytes as bytes } from "./aaa-ui";
import { HourBars, TrafficChart } from "./um-report-charts";
import type { UmCollectionState, UmReport } from "../../src/observability/um-reports";
import { UmReportLoading } from "./um-report-loading";
import "./um-reports.css";

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
/** Source health rows: the board's short lowercase names, in the board's order. */
const healthRows: [string, string][] = [
  ["sessions", "sessions"],
  ["users", "users"],
  ["profiles", "profiles"],
  ["totals", "monitor"],
  ["limitations", "limitations"],
  ["assignments", "assignments"],
  ["profileLimits", "schedules"],
  ["routers", "nas"],
  ["groups", "groups"],
  ["settings", "settings"],
];
const PERIODS = [
  { value: "7", label: "Last 7 days", phrase: "this week" },
  { value: "30", label: "Last 30 days", phrase: "this month" },
  { value: "90", label: "Last 90 days", phrase: "in the last 90 days" },
  { value: "365", label: "Last year", phrase: "this year" },
  { value: "0", label: "All retained history", phrase: "in retained history" },
];
const LEVELS = [0, 0.22, 0.42, 0.66, 0.95];

const duration = (s: number): string =>
  s >= 86400
    ? `${(s / 86400).toFixed(1)} days`
    : s >= 3600
      ? `${(s / 3600).toFixed(1)} hrs`
      : `${Math.round(s / 60)} min`;
/** "1.2 GiB" as a number and a unit, for a KPI value with the unit in <small>. */
function sized(n: number): ReactNode {
  const [value, unit] = bytes(n).split(" ");
  return (
    <>
      {value}
      <small>{unit}</small>
    </>
  );
}
function day(d: string, pattern = "MMM d"): string {
  const date = parseISO(d);
  return isValid(date) ? format(date, pattern) : d;
}
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
/** Tones for termination causes: lost links are a strain, NAS failures a fault. */
function causeTone(name: string): "good" | "warn" | "bad" {
  if (/NAS-(Reboot|Error)|Port-Error|Admin-Reboot/i.test(name)) return "bad";
  if (/Lost-|Unavailable/i.test(name)) return "warn";
  return "good";
}
function Bar({ pct, tone = "good" }: { pct: number; tone?: string }): ReactNode {
  return (
    <span className="monitor-bar">
      <span data-tone={tone} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

/** Live router accounting, not a fabricated time series of counter differences. */
export function UmReports({
  device,
  tabs,
  router,
}: {
  device: string;
  /** The page's tab strip, shown under the header. */
  tabs?: ReactNode;
  /** The router picker, shown on the header's right. */
  router?: ReactNode;
}) {
  const [period, setPeriod] = useState("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [user, setUser] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<"daily" | "cumulative">("daily");
  const [data, setReport] = useState<UmReport | null>(null);
  const [collection, setCollection] = useState<UmCollectionState | null>(null);
  const collecting = collection?.device === device && collection.status === "collecting";
  // Never display the previous router's accounting while switching devices.
  const report = data?.device === device ? data : null;
  const lastRefresh = useRef(0);
  const usersRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const invalidDates = !!from && !!to && from > to;
  const requestKey = JSON.stringify([device, period, user, from, to, refresh]);
  const [loadedKey, setLoadedKey] = useState(requestKey);
  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey);
    setLoading(true);
    setError("");
    setCollection(null);
  }
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
    const load = async (force = false) => {
      let delay = 30_000;
      const request = new AbortController();
      const timeout = setTimeout(() => request.abort(), 15_000);
      try {
        const data = await api<UmReport | UmCollectionState>(
          `/api/aaa/reports?${query}${force ? "&refresh=true" : ""}`,
          AbortSignal.any([abort.signal, request.signal]),
        );
        if (!abort.signal.aborted) {
          if (data.device !== device) throw new Error("Report belongs to a different device.");
          if ("status" in data) {
            setCollection(data);
            setError(data.status === "error" ? data.error || "Report collection failed." : "");
          } else {
            setReport(data);
            setCollection(null);
            setError("");
          }
          delay = Math.max(1000, data.refreshAfterMs);
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(
            request.signal.aborted
              ? "The dashboard did not respond within 15 seconds. Retrying shortly."
              : e instanceof Error
                ? e.message
                : "Report could not be loaded.",
          );
      } finally {
        clearTimeout(timeout);
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
  useStaggerIn(usersRef, ".um-user-button", report ? `${device}:${period}:${from}:${to}` : null);
  const focus = (name: string) => {
    setUser(name);
  };
  const selected = report?.users.find((u) => u.name === user);
  const ready = report?.sources.sessions.available;
  const summary = report?.summary;
  const issues = report ? Object.entries(report.sources).filter(([, s]) => !s.available) : [];
  const maxUserBytes = report?.users.reduce((n, u) => Math.max(n, u.download + u.upload), 1) ?? 1;
  const maxStarts = report?.series.reduce((n, d) => Math.max(n, d.sessions), 1) ?? 1;
  const maxCause = report?.causes.reduce((n, c) => Math.max(n, c.value), 1) ?? 1;
  const phrase =
    from || to ? "in this period" : (PERIODS.find((p) => p.value === period)?.phrase ?? "");

  const verdict =
    report?.available && ready && summary ? (
      <>
        {bytes(summary.download)} down {user ? "for " : "across "}
        <span className="s">
          {user || `${num(summary.users)} user${summary.users === 1 ? "" : "s"}`}
        </span>{" "}
        {phrase}.
      </>
    ) : error && !report ? (
      <em>Report unavailable.</em>
    ) : report && !report.available ? (
      <span className="w">User Manager is unavailable.</span>
    ) : (
      "Reading User Manager accounting."
    );
  const stamp: { tone: Tone; text: string; pulse?: boolean } =
    error || report?.cache?.error
      ? { tone: "bad", text: "Router data unavailable" }
      : report
        ? report.cache?.refreshing
          ? { tone: "good", pulse: true, text: `Refreshing · ${clockTime(report.collectedAt)}` }
          : report.cache?.stale
            ? { tone: "warn", text: `Stale snapshot · ${clockTime(report.collectedAt)}` }
            : { tone: "good", text: `Cached snapshot · ${clockTime(report.collectedAt)}` }
        : { tone: "default", text: "Reading router accounting" };

  const series = report?.series ?? [];
  const pick = series.length
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => series[Math.round(f * (series.length - 1))])
    : [];

  return (
    <div className="um-reports">
      <div className="aaa-head">
        <PageIntro
          eyebrow="RADIUS & User Manager · accounting"
          verdict={verdict}
          lead="From the whole network to one user: traffic, connection patterns and the policies behind them. Read-only reporting."
          aside={
            <div className="um-head-aside">
              {router}
              <StatusBadge tone={stamp.tone} pulse={stamp.pulse}>
                {stamp.text}
              </StatusBadge>
            </div>
          }
        />
        {tabs}
      </div>

      <section className="um-controls glass" aria-label="Report filters">
        <div className="monitor-fl">
          <span className="monitor-label">Report scope</span>
          <AaaSelect
            label="Report user"
            value={user}
            onChange={focus}
            options={[
              { value: "", label: "All users · network overview" },
              ...(report?.users ?? (user ? [{ name: user }] : [])).map((u) => ({
                value: u.name,
                label: u.name,
              })),
            ]}
          />
        </div>
        <div className="monitor-fl">
          <span className="monitor-label">Period · session start date</span>
          <AaaSelect
            label="Report period"
            value={period}
            onChange={(v) => {
              setPeriod(v);
              setFrom("");
              setTo("");
            }}
            options={PERIODS}
          />
        </div>
        <div className="monitor-fl um-date-field">
          <label className="monitor-label" htmlFor="um-report-from">
            From
          </label>
          <DateTimePicker
            id="um-report-from"
            aria-label="From date"
            showTime={false}
            placeholder={
              report?.coverage.from ? day(report.coverage.from, "MMM d, yyyy") : undefined
            }
            value={from ? parseISO(from) : undefined}
            max={to ? parseISO(to) : undefined}
            onChange={(date) => setFrom(date ? format(date, "yyyy-MM-dd") : "")}
          />
        </div>
        <div className="monitor-fl um-date-field">
          <label className="monitor-label" htmlFor="um-report-to">
            Through
          </label>
          <DateTimePicker
            id="um-report-to"
            aria-label="Through date"
            showTime={false}
            placeholder={report?.coverage.to ? day(report.coverage.to, "MMM d, yyyy") : undefined}
            value={to ? parseISO(to) : undefined}
            min={from ? parseISO(from) : undefined}
            onChange={(date) => setTo(date ? format(date, "yyyy-MM-dd") : "")}
          />
        </div>
        <div className="um-control-actions">
          <MonitorButton
            icon={
              <RefreshCw
                aria-hidden="true"
                className={loading && !!device ? "animate-spin motion-reduce:animate-none" : ""}
              />
            }
            aria-busy={loading && !!device}
            disabled={invalidDates || !device || collecting}
            onClick={() => setRefresh((n) => n + 1)}
          >
            Refresh
          </MonitorButton>
          <MonitorButton
            variant="ghost"
            icon={<Download aria-hidden="true" />}
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
          </MonitorButton>
        </div>
      </section>

      {invalidDates && (
        <MonitorNote tone="bad" role="alert">
          The start date must be on or before the end date.
        </MonitorNote>
      )}
      {(loading || collecting || report?.cache?.refreshing) && report && (
        <p className="monitor-hint" role="status">
          {loading
            ? "Updating the report. The last snapshot stays on screen until the new one loads."
            : "Refreshing in the background. Showing the cached snapshot until collection completes."}
        </p>
      )}
      {report?.cache?.stale && !error && (
        <MonitorNote tone="warn">
          <b>Cached report.</b>{" "}
          {report.cache.error || "This snapshot is due for a background refresh."} Last collected:{" "}
          {new Date(report.collectedAt).toLocaleString()}. Counters are not live.
        </MonitorNote>
      )}
      {report?.cache?.persisted === false && (
        <MonitorNote tone="warn">
          <b>Memory-only cache.</b> This report could not be saved to disk. Check the dashboard
          storage path and permissions; an in-memory dashboard does not keep reports after a
          restart.
        </MonitorNote>
      )}
      {error && (
        <MonitorNote tone="bad" role="alert">
          <b>Report unavailable.</b> {error.replace(/\.+$/, "")}. Check router connectivity and
          retry. {report && "The snapshot below is stale."}
        </MonitorNote>
      )}
      {!device && <MonitorNote>Select a configured router to inspect User Manager.</MonitorNote>}
      {(loading || collecting) && !error && !report && device && (
        <UmReportLoading
          progress={collection?.device === device ? collection.progress : undefined}
        />
      )}
      {report && !report.available && (
        <MonitorNote tone="warn">
          <b>User Manager is unavailable.</b>{" "}
          {report.sources.users.error ||
            "This router did not expose the User Manager menu. Check that the package is installed and your account can read it."}{" "}
          RADIUS client management is still available in the other tabs.
        </MonitorNote>
      )}
      {report?.available && summary && (
        <>
          {issues.length > 0 && (
            <MonitorNote tone="warn">
              <b>Partial report.</b> {issues.map(([key]) => sourceNames[key]).join(", ")} could not
              be read. Missing sources are not zero usage; see Source health below.
            </MonitorNote>
          )}
          <MetricStrip label="Accounting totals">
            <Metric
              label="Download accounted"
              value={ready ? sized(summary.download) : "—"}
              hint="sessions started in the period"
              spark={ready ? series.slice(-12).map((d) => d.download) : undefined}
            />
            <Metric
              label="Upload accounted"
              value={ready ? sized(summary.upload) : "—"}
              hint="from the user's side"
            />
            <Metric
              label="Active now"
              tone={summary.active == null ? "default" : "good"}
              value={summary.active == null ? "—" : <Ticker value={summary.active} format={num} />}
              hint="sessions · live, ignores the dates"
            />
            <Metric
              label="Connected time"
              value={
                ready ? (
                  summary.seconds < 3600 ? (
                    <>
                      {num(Math.round(summary.seconds / 60))}
                      <small>min</small>
                    </>
                  ) : (
                    <>
                      {num(Math.round(summary.seconds / 3600))}
                      <small>h</small>
                    </>
                  )
                ) : (
                  "—"
                )
              }
              hint={
                ready
                  ? `${num(summary.sessions)} sessions · ${num(summary.users)} users`
                  : "Accounting source unavailable"
              }
            />
          </MetricStrip>

          {selected && (
            <MonitorPanel
              title={selected.name}
              description="Individual user · the router's live account counters."
              extra={
                <MonitorButton variant="ghost" size="sm" onClick={() => focus("")}>
                  Back to all users
                </MonitorButton>
              }
            >
              <dl className="monitor-facts um-user-facts">
                <dt>Account</dt>
                <dd>
                  {!selected.configured
                    ? "Historical user"
                    : selected.disabled
                      ? "Disabled"
                      : "Enabled"}
                </dd>
                <dt>Active profile</dt>
                <dd>{selected.profile || "Not reported"}</dd>
                <dt>Group</dt>
                <dd>{selected.group || "—"}</dd>
                <dt>Total download</dt>
                <dd className="font-mono">
                  {selected.totalDownload == null ? "—" : bytes(selected.totalDownload)}
                </dd>
                <dt>Total upload</dt>
                <dd className="font-mono">
                  {selected.totalUpload == null ? "—" : bytes(selected.totalUpload)}
                </dd>
                <dt>Total uptime</dt>
                <dd>{selected.totalSeconds == null ? "—" : duration(selected.totalSeconds)}</dd>
                <dt>Shared / sub-sessions</dt>
                <dd>
                  {selected.sharedUsers || "—"} / {selected.subSessions ?? "—"}
                </dd>
                <dt>Latest session start</dt>
                <dd className="font-mono">{selected.latest || "—"}</dd>
              </dl>
              {selected.comment && <p className="monitor-hint mt-3">{selected.comment}</p>}
              <p className="monitor-hint mt-3">
                Live counters follow the router's reset policy and can differ from retained session
                totals. Neither is a billing ledger.
              </p>
            </MonitorPanel>
          )}

          {ready ? (
            <>
              <div className="um-main-grid">
                <MonitorPanel
                  title={user ? `${user} · traffic story` : "The traffic story"}
                  description="Bytes grouped by the day each session started."
                  extra={
                    <Segmented
                      label="Chart display"
                      value={mode}
                      onChange={setMode}
                      options={[
                        { value: "daily", label: "By start day" },
                        { value: "cumulative", label: "Cumulative" },
                      ]}
                    />
                  }
                >
                  {report.summary.sessions ? (
                    <TrafficChart
                      label={`Download and upload by session start day, ${report.coverage.from} to ${report.coverage.to}`}
                      drawKey={`${requestKey}:${mode}`}
                      down={series.map((d) =>
                        mode === "daily" ? d.download : d.cumulativeDownload,
                      )}
                      up={series.map((d) => (mode === "daily" ? d.upload : d.cumulativeUpload))}
                      labels={pick.map((d) => day(d.day))}
                      titles={series.map(
                        (d) =>
                          `${d.day} · ↓ ${bytes(mode === "daily" ? d.download : d.cumulativeDownload)} · ↑ ${bytes(mode === "daily" ? d.upload : d.cumulativeUpload)}`,
                      )}
                    />
                  ) : (
                    <MonitorEmpty compact title="No sessions in this period">
                      Choose a wider period or another user. The NAS must send accounting for
                      sessions to be recorded.
                    </MonitorEmpty>
                  )}
                </MonitorPanel>
                <MonitorPanel
                  title="Who's using the network"
                  description="Select a user to focus every report."
                >
                  <div ref={usersRef} className="um-user-list">
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
                            <span className="um-user-line">
                              <span className="um-user-who">{u.name}</span>
                              <span className="um-user-meta">
                                {u.active == null
                                  ? "Monitor unavailable"
                                  : u.active
                                    ? `${u.active} active`
                                    : "No active sessions"}{" "}
                                · {num(u.sessions)} in period
                              </span>
                            </span>
                            <Bar pct={((u.download + u.upload) / maxUserBytes) * 100} />
                          </span>
                          <span className="um-user-bytes">{bytes(u.download + u.upload)}</span>
                        </button>
                      ))
                    ) : (
                      <p className="monitor-hint">No configured or historical users.</p>
                    )}
                  </div>
                </MonitorPanel>
              </div>
              <div className="um-secondary-grid">
                <MonitorPanel
                  title="When connections happen"
                  description={`Starts by hour · router time, ${report.clock.zone}.`}
                >
                  <HourBars
                    label={`Session starts by hour, router time ${report.clock.zone}`}
                    drawKey={requestKey}
                    values={report.hours.map((h) => h.sessions)}
                    titles={report.hours.map((h) => `${h.hour} · ${num(h.sessions)} starts`)}
                  />
                </MonitorPanel>
                <MonitorPanel
                  title="How sessions ended"
                  description="Termination reasons in the period."
                >
                  {report.causes.length ? (
                    <div className="um-hbars">
                      {report.causes.map((c) => (
                        <div key={c.name} className="um-hbar um-cause">
                          <span className="um-hbar-label">{c.name}</span>
                          <Bar pct={(c.value / maxCause) * 100} tone={causeTone(c.name)} />
                          <span className="um-hbar-value">{num(c.value)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="monitor-hint">No closed sessions in the period.</p>
                  )}
                </MonitorPanel>
                <MonitorPanel title="Access points of entry" description="Sessions by NAS.">
                  {report.nas.length ? (
                    <div className="um-nas">
                      {report.nas.map((n) => (
                        <div key={n.name} className="um-nas-row">
                          <div className="um-nas-top">
                            <span className="um-nas-name">{n.name || "Unknown NAS"}</span>
                            <span className="um-nas-n">{num(n.sessions)} sessions</span>
                          </div>
                          <span className="um-nas-bytes">
                            ↓ {bytes(n.download)} · ↑ {bytes(n.upload)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="monitor-hint">No NAS accounting in the period.</p>
                  )}
                </MonitorPanel>
              </div>
            </>
          ) : (
            <MonitorNote tone="warn">
              <b>Accounting unavailable.</b> No charts are drawn from a failed read. Check the
              accounting source and retry.
            </MonitorNote>
          )}

          <div className="um-third-grid">
            {ready && (
              <MonitorPanel
                title="Connection calendar"
                description={`${user || "All users"} · one square per day.`}
                extra={<span className="um-starts">{num(report.summary.sessions)} starts</span>}
              >
                <div
                  className="um-calendar"
                  role="img"
                  aria-label={`Daily session starts for ${user || "all users"}; exact daily data is in the table below and in Export report.`}
                >
                  {series.map((d) => (
                    <span
                      key={d.day}
                      className="um-calendar-day"
                      style={
                        d.sessions
                          ? {
                              opacity:
                                LEVELS[
                                  Math.min(4, Math.max(1, Math.ceil((4 * d.sessions) / maxStarts)))
                                ],
                            }
                          : undefined
                      }
                      data-active={d.sessions > 0}
                      title={`${d.day}: ${num(d.sessions)} session starts · ↓ ${bytes(d.download)} · ↑ ${bytes(d.upload)}`}
                    />
                  ))}
                </div>
                <div className="um-calendar-legend">
                  <span className="font-mono">{day(report.coverage.from)}</span>
                  <span className="flex-1" />
                  Less
                  {[0.12, 0.3, 0.55, 0.95].map((o) => (
                    <i key={o} style={{ opacity: o }} />
                  ))}{" "}
                  More
                  <span className="flex-1" />
                  <span className="font-mono">{day(report.coverage.to)}</span>
                </div>
                <details className="um-details">
                  <summary>
                    <ChevronRight aria-hidden="true" />
                    Daily data · table view
                  </summary>
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
                        {series.map((d) => (
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
              </MonitorPanel>
            )}
            <MonitorPanel
              title={user ? `${user} · policy context` : "The policies behind the numbers"}
              description="Profiles, limits and server configuration as the router reports them."
            >
              <div className="um-inventory">
                {Object.entries(report.inventory).map(([key, rows]) => (
                  <details key={key} className="um-inv">
                    <summary>
                      <ChevronRight aria-hidden="true" />
                      <span className="um-inv-name">{sourceNames[key]}</span>
                      <span className="flex-1" />
                      {report.sources[key]?.available ? (
                        <span className="um-count">{rows.length}</span>
                      ) : (
                        <StatusBadge tone="warn" dot={false}>
                          Unavailable
                        </StatusBadge>
                      )}
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
                      <p className="monitor-hint um-inv-empty">
                        {report.sources[key]?.available
                          ? "No entries reported."
                          : report.sources[key]?.error || "Source not supported or not read."}
                      </p>
                    )}
                  </details>
                ))}
              </div>
            </MonitorPanel>
            <MonitorPanel title="Source health" description="What was read, and what could not be.">
              <div className="um-hbars">
                {healthRows
                  .filter(([key]) => report.sources[key])
                  .map(([key, label]) => {
                    const s = report.sources[key];
                    return (
                      <div
                        key={key}
                        className="um-hbar um-health"
                        title={
                          s.available
                            ? `${sourceNames[key]}: ${num(s.count)} records${s.collectionMs == null ? "" : ` · ${(s.collectionMs / 1000).toFixed(1)} s`}`
                            : `${sourceNames[key]}: ${s.error || "Unsupported or not read"}`
                        }
                      >
                        <span className="um-hbar-label">{label}</span>
                        <Bar pct={s.available ? 100 : 0} />
                        <span className="um-hbar-value" data-failed={!s.available || undefined}>
                          {s.available ? num(s.count) : "failed"}
                        </span>
                      </div>
                    );
                  })}
              </div>
              <p className="monitor-hint um-health-foot">
                {num(report.coverage.retained)} retained records · collected in{" "}
                {(report.collectionMs / 1000).toFixed(1)} s · cached for 60 s.
                {report.coverage.undated > 0 &&
                  ` ${num(report.coverage.undated)} records have no start date and are left out.`}
              </p>
            </MonitorPanel>
          </div>
        </>
      )}
    </div>
  );
}
