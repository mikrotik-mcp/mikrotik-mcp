import { useEffect, useRef, useState } from "react";
import { format, isValid, parseISO } from "date-fns";
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRight, Download, RefreshCw } from "lucide-react";
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
import { DateTimePicker, DetailList, RowDrawer, RowMenu, RowMore, tipProps } from "./kit";
import type { TipCard, Tone as KitTone } from "./kit";
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
const kitTone = { good: "ok", warn: "warn", bad: "bad" } as const satisfies Record<string, KitTone>;
/** "+1.2 GiB" or "−300 KiB" against the previous value. */
function delta(now: number, before: number): { value: string; tone?: "up" | "down" } {
  const d = now - before;
  if (d === 0) return { value: "no change" };
  return { value: `${d > 0 ? "+" : "−"}${bytes(Math.abs(d))}`, tone: d > 0 ? "up" : "down" };
}
/** Enter or Space on a focusable row runs its click. */
function onEnter(run: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  };
}
/** The columns of an inventory table: every key its rows carry, except .id. */
function invTitle(key: string, row: Record<string, string>, i: number): string {
  return row.name || row[".id"] || `${sourceNames[key]} ${i + 1}`;
}
function columns(rows: Record<string, string>[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== ".id");
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
  /** The row open in the details drawer: which list, and its index. */
  const [open, setOpen] = useState<{ list: string; i: number } | null>(null);
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
  const onlyDay = (d: string) => {
    setFrom(d);
    setTo(d);
  };
  const selected = report?.users.find((u) => u.name === user);
  const ready = report?.sources.sessions.available;
  const summary = report?.summary;
  const issues = report ? Object.entries(report.sources).filter(([, s]) => !s.available) : [];
  const maxUserBytes = report?.users.reduce((n, u) => Math.max(n, u.download + u.upload), 1) ?? 1;
  const maxStarts = report?.series.reduce((n, d) => Math.max(n, d.sessions), 1) ?? 1;
  const maxCause = report?.causes.reduce((n, c) => Math.max(n, c.value), 1) ?? 1;
  const closed = report?.causes.reduce((n, c) => n + c.value, 0) || 1;
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
            label="From date"
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
            label="Through date"
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
                      card={(i): TipCard => {
                        const d = series[i]!;
                        const prev = series[i - 1];
                        const daily = mode === "daily";
                        return {
                          title: day(d.day, "EEE, MMM d"),
                          sub: daily ? "by start day" : "cumulative",
                          rows: [
                            {
                              label: "Download",
                              value: bytes(daily ? d.download : d.cumulativeDownload),
                              color: "var(--sig)",
                            },
                            {
                              label: "Upload",
                              value: bytes(daily ? d.upload : d.cumulativeUpload),
                              color: "var(--warning)",
                            },
                            { label: "Sessions started", value: num(d.sessions) },
                          ],
                          foot:
                            daily && prev
                              ? {
                                  label: "Download vs day before",
                                  ...delta(d.download, prev.download),
                                }
                              : undefined,
                        };
                      }}
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
                        <RowMenu
                          key={u.name}
                          title={u.name}
                          sub={`${num(u.sessions)} sessions in period · ${bytes(u.download + u.upload)}`}
                          onOpen={() => setOpen({ list: "users", i })}
                          cells={{
                            user: {
                              value: u.name,
                              filter: () => focus(u.name),
                              clearFilter: user ? () => focus("") : undefined,
                            },
                            bytes: { value: bytes(u.download + u.upload) },
                          }}
                          copies={[{ label: "User name", value: u.name }]}
                          row={u}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            className="um-user-button"
                            aria-pressed={user === u.name}
                            onClick={() => focus(u.name)}
                            onKeyDown={onEnter(() => focus(u.name))}
                          >
                            <span className="um-user-rank">{String(i + 1).padStart(2, "0")}</span>
                            <span className="um-user-name" data-col="user">
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
                            <span className="um-user-bytes" data-col="bytes">
                              {bytes(u.download + u.upload)}
                            </span>
                            <RowMore />
                          </div>
                        </RowMenu>
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
                    card={(i): TipCard => {
                      const hr = report.hours[i]!;
                      const total = report.summary.sessions;
                      return {
                        title: `${hr.hour}–${hr.hour.slice(0, 2)}:59`,
                        sub: `router time, ${report.clock.zone}`,
                        rows: [
                          {
                            label: "Session starts",
                            value: num(hr.sessions),
                            color: "var(--chart-1)",
                          },
                          {
                            label: "Share of the period",
                            value: total ? `${Math.round((hr.sessions / total) * 100)}%` : "—",
                          },
                        ],
                      };
                    }}
                  />
                </MonitorPanel>
                <MonitorPanel
                  title="How sessions ended"
                  description="Termination reasons in the period."
                >
                  {report.causes.length ? (
                    <div className="um-hbars kit-tips">
                      {report.causes.map((c) => (
                        <div
                          key={c.name}
                          className="um-hbar um-cause"
                          {...tipProps((): TipCard => ({
                            title: c.name,
                            led: kitTone[causeTone(c.name)],
                            rows: [
                              { label: "Sessions ended", value: num(c.value) },
                              {
                                label: "Share of closed sessions",
                                value: `${Math.round((c.value / closed) * 100)}%`,
                              },
                            ],
                          }))}
                        >
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
                      {report.nas.map((n, i) => (
                        <RowMenu
                          key={n.name}
                          title={n.name || "Unknown NAS"}
                          sub={`${num(n.sessions)} sessions`}
                          onOpen={() => setOpen({ list: "nas", i })}
                          cells={{
                            name: { value: n.name || "Unknown NAS", copy: Boolean(n.name) },
                            sessions: { value: `${num(n.sessions)} sessions` },
                          }}
                          copies={n.name ? [{ label: "NAS", value: n.name }] : undefined}
                          row={n}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            aria-label={`${n.name || "Unknown NAS"}, ${num(n.sessions)} sessions`}
                            className="um-nas-row"
                            onClick={() => setOpen({ list: "nas", i })}
                            onKeyDown={onEnter(() => setOpen({ list: "nas", i }))}
                          >
                            <div className="um-nas-main">
                              <div className="um-nas-top">
                                <span className="um-nas-name" data-col="name">
                                  {n.name || "Unknown NAS"}
                                </span>
                                <span className="um-nas-n" data-col="sessions">
                                  {num(n.sessions)} sessions
                                </span>
                              </div>
                              <span className="um-nas-bytes">
                                ↓ {bytes(n.download)} · ↑ {bytes(n.upload)}
                              </span>
                            </div>
                            <RowMore />
                          </div>
                        </RowMenu>
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
                  className="um-calendar kit-tips"
                  role="group"
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
                      {...tipProps((): TipCard => ({
                        title: day(d.day, "EEE, MMM d, yyyy"),
                        rows: [
                          { label: "Session starts", value: num(d.sessions), color: "var(--sig)" },
                          { label: "Download", value: bytes(d.download) },
                          { label: "Upload", value: bytes(d.upload) },
                        ],
                        action: { label: "Show only this day", onClick: () => onlyDay(d.day) },
                      }))}
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
                          <th className="um-more" aria-label="Row actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {series.map((d, i) => (
                          <RowMenu
                            key={d.day}
                            title={day(d.day, "EEE, MMM d, yyyy")}
                            sub={`${num(d.sessions)} starts · ↓ ${bytes(d.download)} · ↑ ${bytes(d.upload)}`}
                            onOpen={() => setOpen({ list: "daily", i })}
                            cells={{
                              date: {
                                value: d.day,
                                kind: "time",
                                filter: () => onlyDay(d.day),
                                clearFilter: from || to ? () => onlyDay("") : undefined,
                              },
                              starts: { value: num(d.sessions) },
                              download: { value: bytes(d.download) },
                              upload: { value: bytes(d.upload) },
                              uptime: { value: duration(d.seconds), kind: "duration" },
                            }}
                            row={d}
                          >
                            <tr
                              tabIndex={0}
                              onClick={() => setOpen({ list: "daily", i })}
                              onKeyDown={onEnter(() => setOpen({ list: "daily", i }))}
                            >
                              <td data-col="date">{d.day}</td>
                              <td data-col="starts">{num(d.sessions)}</td>
                              <td data-col="download">{bytes(d.download)}</td>
                              <td data-col="upload">{bytes(d.upload)}</td>
                              <td data-col="uptime">{duration(d.seconds)}</td>
                              <td className="um-more">
                                <RowMore />
                              </td>
                            </tr>
                          </RowMenu>
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
                              {columns(rows).map((k) => (
                                <th key={k}>{k.replaceAll("-", " ")}</th>
                              ))}
                              <th className="um-more" aria-label="Row actions" />
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row, i) => (
                              <RowMenu
                                key={row[".id"] || i}
                                title={invTitle(key, row, i)}
                                sub={sourceNames[key]}
                                onOpen={() => setOpen({ list: `inv:${key}`, i })}
                                cells={Object.fromEntries(
                                  columns(rows).map((k) => [k, { value: row[k] || "" }]),
                                )}
                                copies={[
                                  ...(row[".id"]
                                    ? [{ label: "Router ID", value: row[".id"] }]
                                    : []),
                                  ...(row.name ? [{ label: "Name", value: row.name }] : []),
                                ]}
                                row={row}
                              >
                                <tr
                                  tabIndex={0}
                                  onClick={() => setOpen({ list: `inv:${key}`, i })}
                                  onKeyDown={onEnter(() => setOpen({ list: `inv:${key}`, i }))}
                                >
                                  {columns(rows).map((k) => (
                                    <td key={k} data-col={k}>
                                      {row[k] || "—"}
                                    </td>
                                  ))}
                                  <td className="um-more">
                                    <RowMore />
                                  </td>
                                </tr>
                              </RowMenu>
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
              <div className="um-hbars kit-tips">
                {healthRows
                  .filter(([key]) => report.sources[key])
                  .map(([key, label]) => {
                    const s = report.sources[key];
                    return (
                      <div
                        key={key}
                        className="um-hbar um-health"
                        {...tipProps((): TipCard => ({
                          title: sourceNames[key],
                          led: s.available ? "ok" : "bad",
                          rows: s.available
                            ? [
                                { label: "Records", value: num(s.count) },
                                ...(s.collectionMs == null
                                  ? []
                                  : [
                                      {
                                        label: "Read in",
                                        value: `${(s.collectionMs / 1000).toFixed(1)} s`,
                                      },
                                    ]),
                              ]
                            : [{ label: "Not read", value: s.error || "Unsupported or not read" }],
                        }))}
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
      {report && open && (
        <UmRowDrawer
          report={report}
          open={open}
          setOpen={setOpen}
          user={user}
          focus={focus}
          onlyDay={onlyDay}
        />
      )}
    </div>
  );
}

type Detail = { label: string; value: ReactNode; mono?: boolean };

/** One row of the report's lists and tables in the kit's details drawer. */
function UmRowDrawer({
  report,
  open,
  setOpen,
  user,
  focus,
  onlyDay,
}: {
  report: UmReport;
  open: { list: string; i: number };
  setOpen: (o: { list: string; i: number } | null) => void;
  user: string;
  focus: (name: string) => void;
  onlyDay: (d: string) => void;
}): ReactNode {
  const { list, i } = open;
  let total = 0;
  let title = "";
  let meta: ReactNode;
  let status: { tone: KitTone; label: ReactNode } | undefined;
  let items: Detail[] = [];
  let primary: ReactNode;
  if (list === "users") {
    const u = report.users[i];
    total = report.users.length;
    if (!u) return null;
    title = u.name;
    meta = `${num(u.sessions)} sessions in period · ${bytes(u.download + u.upload)}`;
    status = !u.configured
      ? { tone: "off", label: "Historical user" }
      : u.disabled
        ? { tone: "warn", label: "Disabled" }
        : { tone: "ok", label: "Enabled" };
    items = [
      { label: "Download in period", value: bytes(u.download), mono: true },
      { label: "Upload in period", value: bytes(u.upload), mono: true },
      { label: "Sessions in period", value: num(u.sessions) },
      {
        label: "Active now",
        value:
          u.active == null
            ? "Monitor unavailable"
            : u.active
              ? `${u.active} active`
              : "No active sessions",
      },
      { label: "Active profile", value: u.profile || "Not reported" },
      { label: "Group", value: u.group || "—" },
      {
        label: "Total download",
        value: u.totalDownload == null ? "—" : bytes(u.totalDownload),
        mono: true,
      },
      {
        label: "Total upload",
        value: u.totalUpload == null ? "—" : bytes(u.totalUpload),
        mono: true,
      },
      { label: "Total uptime", value: u.totalSeconds == null ? "—" : duration(u.totalSeconds) },
      { label: "Latest session start", value: u.latest || "—", mono: true },
      ...(u.comment ? [{ label: "Comment", value: u.comment }] : []),
    ];
    primary =
      user === u.name ? (
        <MonitorButton size="sm" variant="ghost" onClick={() => focus("")}>
          Back to all users
        </MonitorButton>
      ) : (
        <MonitorButton size="sm" onClick={() => focus(u.name)}>
          Focus this user
        </MonitorButton>
      );
  } else if (list === "nas") {
    const n = report.nas[i];
    total = report.nas.length;
    if (!n) return null;
    title = n.name || "Unknown NAS";
    meta = "Sessions by NAS in the period";
    items = [
      { label: "Sessions", value: num(n.sessions) },
      { label: "Download", value: bytes(n.download), mono: true },
      { label: "Upload", value: bytes(n.upload), mono: true },
    ];
  } else if (list === "daily") {
    const d = report.series[i];
    total = report.series.length;
    if (!d) return null;
    title = day(d.day, "EEE, MMM d, yyyy");
    meta = "Sessions grouped by the day they started";
    items = [
      { label: "Date", value: d.day, mono: true },
      { label: "Session starts", value: num(d.sessions) },
      { label: "Download", value: bytes(d.download), mono: true },
      { label: "Upload", value: bytes(d.upload), mono: true },
      { label: "Uptime", value: duration(d.seconds) },
      { label: "Download so far", value: bytes(d.cumulativeDownload), mono: true },
      { label: "Upload so far", value: bytes(d.cumulativeUpload), mono: true },
    ];
    primary = (
      <MonitorButton size="sm" onClick={() => onlyDay(d.day)}>
        Show only this day
      </MonitorButton>
    );
  } else if (list.startsWith("inv:")) {
    const key = list.slice(4);
    const rows = (report.inventory as Record<string, Record<string, string>[]>)[key] ?? [];
    const row = rows[i];
    total = rows.length;
    if (!row) return null;
    title = invTitle(key, row, i);
    meta = sourceNames[key];
    items = [
      ...(row[".id"] ? [{ label: "Router ID", value: row[".id"], mono: true }] : []),
      ...columns(rows).map((k) => ({
        label: k.replaceAll("-", " "),
        value: row[k] || "—",
        mono: true,
      })),
    ];
  }
  const go = (k: number) => setOpen({ list, i: k });
  return (
    <RowDrawer
      open
      onClose={() => setOpen(null)}
      label={`Report row details: ${title}`}
      storageKey="um-reports"
      rowKey={`${list}:${i}`}
      nav={{
        index: i,
        total,
        onPrev: i > 0 ? () => go(i - 1) : undefined,
        onNext: i < total - 1 ? () => go(i + 1) : undefined,
      }}
      status={status}
      title={title}
      meta={meta}
      primary={primary}
    >
      <DetailList items={items} />
    </RowDrawer>
  );
}
