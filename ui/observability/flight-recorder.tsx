import { api } from "./api";
import { LoadingState } from "./loading-state";
import { useEffect, useState } from "react";
import {
  Activity,
  Download,
  Pause,
  Pin,
  RotateCw,
  Shield,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import {
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  RouterPicker,
  StatusBadge,
  StatusDot,
  Ticker,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { useOperations } from "./operations-ui";
import { FlightSignal } from "./flight-signal";
import type { FlightEvent, FlightRecord } from "../../src/flight-recorder/model";
import { NumberInput, TextInput } from "./kit";
import "./monitoring.css";
import "./flight-recorder.css";

const STROKE = 1.6;

function dayTime(at: number, year = false): string {
  const d = new Date(at);
  const day = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${time}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Router log lines that read as a loss: link down, failed handshake, timeouts. */
const LOSS = /\b(down|fail|failed|error|lost|timeout|timed out|did not|unreachable|disconnect)/i;

function eventTone(e: FlightEvent): Tone {
  if (e.source === "operator") return "brand";
  if (e.source === "mcp") return e.failed ? "bad" : "good";
  return LOSS.test(e.title) ? "warn" : "good";
}

export function FlightRecorderView() {
  const w = useOperations<{ recorder: FlightRecord; toolEventsAvailable: boolean }>(
    "/api/flight-recorder",
  );
  const r = w.data?.recorder;
  const [selected, setSelected] = useState<string>();
  const [configure, setConfigure] = useState(false),
    [freeze, setFreeze] = useState(false);
  const [interval, setIntervalValue] = useState(60),
    [window, setWindow] = useState(60),
    [retention, setRetention] = useState(7),
    [title, setTitle] = useState("");
  const [exportError, setExportError] = useState("");
  const incident = r?.incidents.find((i) => i.id === selected);
  const samples = incident?.samples ?? r?.samples ?? [],
    events = incident?.events ?? r?.events ?? [];
  const { refresh, busy } = w;
  // Only for the "(default)" mark in the router picker.
  const [defaultRouter, setDefaultRouter] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    api<{ defaultDevice?: string }>("/api/devices", abort.signal)
      .then((d) => setDefaultRouter(d?.defaultDevice))
      .catch(() => {});
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      if (!busy && document.visibilityState === "visible") void refresh();
    }, 10000);
    return () => clearInterval(t);
  }, [refresh, busy]);
  const last = r?.samples.at(-1);
  const age = last ? Math.max(0, Math.floor((w.observedAt - last.finishedAt) / 1000)) : undefined;
  async function download() {
    if (!incident) return;
    setExportError("");
    const value = await w.action<object>("/export", { id: incident.id });
    if (!value) return;
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `incident-${incident.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError("Your browser could not download this report.");
    }
  }
  if (!w.data && w.loading && !w.error)
    return <LoadingState label="Loading workspace evidence" layout="cards" />;

  const state = !r?.enabled
    ? "paused"
    : age === undefined || age > r.intervalSeconds * 3
      ? "unknown"
      : "recording";
  const timeline = [
    ...events.map((e) => ({
      key: e.id,
      at: e.at,
      source: e.source as string,
      title: e.title,
      mono: e.source === "mcp",
      tone: eventTone(e),
      detail: e.routerTime
        ? `Router clock: ${e.routerTime} · uncorrected`
        : e.risk
          ? `${e.risk} · ${e.failed ? "failed / outcome may be uncertain" : "tool completed"}`
          : e.source === "operator"
            ? "Manual trigger"
            : "",
    })),
    ...samples
      .filter((s) => s.gaps.length)
      .map((s) => ({
        key: `gap:${s.at}`,
        at: s.at,
        source: "coverage gap",
        title: s.gaps.join(" "),
        mono: false,
        tone: "bad" as Tone,
        detail: "Not a healthy sample",
      })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 500);
  const errors = [w.error, exportError, r?.error].filter(Boolean);

  return (
    <div className="flight-page">
      <PageIntro
        eyebrow="Flight recorder · incident evidence"
        heading="Keep the moments that matter."
        lead="A rolling memory of your network. Freeze the lead-up, follow the recovery, and investigate from evidence, not recollection."
        actions={
          <>
            <RouterPicker
              value={w.device}
              routers={w.devices}
              defaultRouter={defaultRouter}
              disabled={w.busy}
              onChange={(d) => {
                setSelected(undefined);
                setConfigure(false);
                setFreeze(false);
                w.setDevice(d);
              }}
            />
            <MonitorButton
              variant="ghost"
              aria-label="Refresh"
              title="Refresh"
              disabled={w.busy}
              onClick={() => void w.refresh()}
              icon={<RotateCw aria-hidden="true" strokeWidth={STROKE} />}
            />
            <MonitorButton
              disabled={!r || w.busy}
              icon={<SlidersHorizontal aria-hidden="true" strokeWidth={STROKE} />}
              onClick={() => {
                setIntervalValue(r!.intervalSeconds);
                setWindow(r!.windowMinutes);
                setRetention(r!.retentionDays);
                setConfigure(true);
              }}
            >
              Capture settings
            </MonitorButton>
          </>
        }
      />
      {errors.map((message, i) => (
        <MonitorNote
          key={i}
          tone="bad"
          role="alert"
          icon={<TriangleAlert aria-hidden="true" strokeWidth={STROKE} />}
        >
          {message}
        </MonitorNote>
      ))}
      <section className="flight-console glass" aria-label="Recorder status">
        <div className="flight-console-state" data-state={state}>
          <Activity aria-hidden="true" strokeWidth={STROKE} />
          <div className="flight-console-text">
            <span className="flight-console-led">
              <StatusDot
                tone={state === "recording" ? "good" : state === "unknown" ? "warn" : "default"}
                pulse={state === "recording"}
              />
              <b>
                {state === "recording"
                  ? "Recording"
                  : state === "unknown"
                    ? "Waiting for samples"
                    : "Paused"}
              </b>
            </span>
            <span className="monitor-hint">
              {age === undefined
                ? "No samples received yet"
                : `Last sample ${age} s ago · every ${r?.intervalSeconds} s`}
            </span>
          </div>
        </div>
        <div className="flight-stat">
          <span className="flight-stat-v">
            {r ? <Ticker value={r.windowMinutes} format={(n) => `${Math.round(n)}`} /> : "—"}{" "}
            <small>min</small>
          </span>
          <span className="monitor-hint">Rolling window</span>
        </div>
        <div className="flight-stat">
          <span className="flight-stat-v">
            {r ? <Ticker value={r.incidents.length} format={(n) => `${Math.round(n)}`} /> : "—"}
          </span>
          <span className="monitor-hint">Saved incidents</span>
        </div>
        <div className="flight-console-actions">
          <MonitorButton
            variant="primary"
            disabled={!r || w.busy}
            icon={<Pin aria-hidden="true" strokeWidth={STROKE} />}
            onClick={() => {
              setTitle("");
              setFreeze(true);
            }}
          >
            Freeze incident
          </MonitorButton>
          {r?.enabled && (
            <MonitorButton
              variant="ghost"
              disabled={w.busy}
              icon={<Pause aria-hidden="true" strokeWidth={STROKE} />}
              onClick={() =>
                void w.action("/configure", {
                  enabled: false,
                  intervalSeconds: r.intervalSeconds,
                  windowMinutes: r.windowMinutes,
                  retentionDays: r.retentionDays,
                })
              }
            >
              Pause
            </MonitorButton>
          )}
        </div>
      </section>
      {!r?.enabled && (
        <MonitorNote>
          Recording is paused. Open Capture settings to enable read-only polling. Existing evidence
          remains available until its retention limit.
        </MonitorNote>
      )}
      <div className="flight-grid">
        <MonitorPanel
          title="Incident history"
          description="Up to 30 per router."
          flush
          aria-label="Incident history"
        >
          <button
            type="button"
            className="monitor-row flight-incident"
            data-selected={!incident || undefined}
            aria-pressed={!incident}
            onClick={() => setSelected(undefined)}
          >
            <span className="p">Live rolling window</span>
            <span className="monitor-hint">Latest observations · not a packet capture</span>
          </button>
          {[...(r?.incidents ?? [])].reverse().map((i) => (
            <button
              key={i.id}
              type="button"
              className="monitor-row flight-incident"
              data-selected={incident?.id === i.id || undefined}
              aria-pressed={incident?.id === i.id}
              onClick={() => setSelected(i.id)}
            >
              <span className="p">{i.title}</span>
              <span className="monitor-hint">
                {dayTime(i.at)} · {i.samples.length} samples · {i.events.length} events
              </span>
              <span>
                <StatusBadge tone="good" pulse={!i.complete}>
                  {i.complete ? "preserved" : "recording"}
                </StatusBadge>
              </span>
            </button>
          ))}
        </MonitorPanel>
        <div className="flight-col">
          <MonitorPanel
            title={incident?.title ?? "Live rolling window"}
            description={
              incident
                ? `${dayTime(incident.at, true)} · ${incident.complete ? "window preserved" : "collecting two minutes of follow-up"} · host receipt time`
                : "Host receipt time · dots show management observations; the line shows CPU when measured."
            }
            extra={
              incident && (
                <MonitorButton
                  size="sm"
                  disabled={w.busy}
                  icon={<Download aria-hidden="true" strokeWidth={STROKE} />}
                  onClick={() => void download()}
                >
                  Export evidence
                </MonitorButton>
              )
            }
          >
            <div className="flight-chart-wrap">
              {samples.length ? (
                <FlightSignal
                  samples={samples}
                  frozenAt={incident?.at}
                  drawKey={`${w.device}:${incident?.id ?? "live"}`}
                />
              ) : (
                <MonitorEmpty
                  compact
                  icon={<Activity strokeWidth={STROKE} />}
                  title="No timeline yet."
                >
                  Enable recording to collect evidence before the next incident.
                </MonitorEmpty>
              )}
              <span className="monitor-legend flight-legend">
                <span>
                  <i data-k="ok" />
                  Management responded
                </span>
                <span>
                  <i data-k="bad" />
                  Read failed
                </span>
                <span>
                  <i data-k="skip" />
                  Unavailable or skipped
                </span>
                <span>
                  <i data-k="cpu" />
                  CPU %
                </span>
              </span>
            </div>
          </MonitorPanel>
          <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" strokeWidth={STROKE} />}>
            A management timeout is not proof of a tunnel failure. Missing samples and capture gaps
            stay visible.{" "}
            {w.data?.toolEventsAvailable
              ? "MCP write and failure metadata is connected."
              : "MCP tool events are unavailable: dashboard recording is off."}
          </MonitorNote>
          <MonitorPanel title="Evidence timeline" description="Newest first." flush>
            <ol className="flight-timeline">
              {timeline.map((e) => (
                <li key={e.key} className="monitor-row flight-event">
                  <time className="flight-event-t" dateTime={new Date(e.at).toISOString()}>
                    {clock(e.at)}
                  </time>
                  <StatusDot tone={e.tone} />
                  <span className="flight-event-main">
                    <span className={e.mono ? "p flight-mono" : "p"}>{e.title}</span>
                    {e.detail && <span className="monitor-hint">{e.detail}</span>}
                  </span>
                  <span className="monitor-chip flight-event-src">{e.source}</span>
                </li>
              ))}
            </ol>
            <div className="monitor-foot">
              {timeline.length
                ? `${timeline.length} ${timeline.length === 1 ? "event" : "events"} in this window. An empty window would not prove that nothing changed.`
                : "No events in this window. This does not prove that no changes occurred."}
            </div>
          </MonitorPanel>
        </div>
      </div>
      <MonitorDialog
        open={configure}
        onOpenChange={setConfigure}
        title="Capture, with clear limits."
        description="Read-only collection persists on this MCP host and resumes after restart. It never enables router logging or changes network settings."
        width={520}
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton variant="ghost" onClick={() => setConfigure(false)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="primary"
              disabled={
                w.busy ||
                interval < 30 ||
                interval > 300 ||
                window < 15 ||
                window > 360 ||
                retention < 1 ||
                retention > 30
              }
              onClick={async () => {
                if (
                  await w.action("/configure", {
                    enabled: true,
                    intervalSeconds: interval,
                    windowMinutes: window,
                    retentionDays: retention,
                  })
                )
                  setConfigure(false);
              }}
            >
              Enable recording
            </MonitorButton>
          </>
        }
      >
        <div className="flight-dialog-body">
          <div className="monitor-fl">
            <span className="monitor-label">Sample interval · seconds</span>
            <NumberInput
              label="Sample interval · seconds"
              min={30}
              max={300}
              value={interval}
              onChange={(n) => setIntervalValue(n ?? 30)}
            />
          </div>
          <div className="monitor-fl">
            <span className="monitor-label">Rolling window · minutes</span>
            <NumberInput
              label="Rolling window · minutes"
              min={15}
              max={360}
              value={window}
              onChange={(n) => setWindow(n ?? 15)}
            />
          </div>
          <div className="monitor-fl">
            <span className="monitor-label">Incident retention · days</span>
            <NumberInput
              label="Incident retention · days"
              min={1}
              max={30}
              value={retention}
              onChange={(n) => setRetention(n ?? 1)}
            />
          </div>
          <MonitorNote>
            Up to 720 samples, 500 metadata events and 30 incidents per router. Raw log messages are
            not stored. Logs are polled over SSH, not a lossless remote syslog stream.
          </MonitorNote>
        </div>
      </MonitorDialog>
      <MonitorDialog
        open={freeze}
        onOpenChange={setFreeze}
        title="Mark this moment."
        description="Preserve the available lead-up and, while recording, two minutes of follow-up."
        width={520}
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton variant="ghost" onClick={() => setFreeze(false)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="primary"
              disabled={w.busy || !title.trim()}
              icon={<Pin aria-hidden="true" strokeWidth={STROKE} />}
              onClick={async () => {
                if (await w.action("/freeze", { title })) setFreeze(false);
              }}
            >
              Preserve window
            </MonitorButton>
          </>
        }
      >
        <div className="flight-dialog-body flight-freeze">
          <label className="monitor-fl">
            <span className="monitor-label">Incident title</span>
            <TextInput
              label="Incident title"
              value={title}
              maxLength={120}
              autoFocus
              onChange={setTitle}
              placeholder="VPN disconnected during a call"
            />
          </label>
          <dl className="monitor-facts">
            <dt>Lead-up kept</dt>
            <dd>
              Last {r?.windowMinutes ?? "—"} min · {r?.samples.length ?? 0} samples
            </dd>
            <dt>Follow-up</dt>
            <dd>{r?.enabled ? "Two more minutes while recording" : "None while paused"}</dd>
            <dt>Router</dt>
            <dd>
              <span className="flight-mono">{w.device}</span>
            </dd>
          </dl>
          <MonitorNote tone="good" icon={<Shield aria-hidden="true" strokeWidth={STROKE} />}>
            No router configuration is applied. Evidence stays on this MCP host.
          </MonitorNote>
        </div>
      </MonitorDialog>
    </div>
  );
}
