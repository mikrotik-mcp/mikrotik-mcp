import { useEffect, useState } from "react";
import { Radio, Pause, BookmarkPlus, Download, Settings2, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useOperations,
  WorkspaceHeader,
  WorkspaceError,
  WorkspaceSafety,
  EvidenceState,
} from "./operations-ui";
import type { FlightRecord, FlightSample } from "../../src/flight-recorder/model";
import "./flight-recorder.css";

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
  return (
    <div className="ops-workspace">
      <WorkspaceHeader
        eyebrow="FLIGHT RECORDER / INCIDENT EVIDENCE"
        title="Keep the moments that matter."
        description="A rolling memory of your network. Freeze the lead-up, follow the recovery, and investigate from evidence—not recollection."
        device={w.device}
        devices={w.devices}
        onDevice={(d) => {
          setSelected(undefined);
          setConfigure(false);
          setFreeze(false);
          w.setDevice(d);
        }}
        busy={w.busy}
        onRefresh={() => void w.refresh()}
      >
        <Button
          variant="outline"
          disabled={!r || w.busy}
          onClick={() => {
            setIntervalValue(r!.intervalSeconds);
            setWindow(r!.windowMinutes);
            setRetention(r!.retentionDays);
            setConfigure(true);
          }}
        >
          <Settings2 size={15} />
          Capture settings
        </Button>
      </WorkspaceHeader>
      <WorkspaceError message={w.error || exportError} />
      <div className="flight-console">
        <div className="flight-console__state">
          <Radio size={24} />
          <div>
            <EvidenceState
              state={
                !r?.enabled
                  ? "paused"
                  : age === undefined || age > r.intervalSeconds * 3
                    ? "unknown"
                    : "recording"
              }
            />
            <p>
              {age === undefined
                ? "No samples received yet"
                : `Last sample ${age}s ago · every ${r?.intervalSeconds}s`}
            </p>
          </div>
        </div>
        <div>
          <strong>
            {r?.windowMinutes ?? "—"}
            <small> min</small>
          </strong>
          <span>Rolling window</span>
        </div>
        <div>
          <strong>{r?.incidents.length ?? "—"}</strong>
          <span>Saved incidents</span>
        </div>
        <div className="ops-toolbar">
          <Button
            disabled={!r || w.busy}
            variant="outline"
            onClick={() => {
              setTitle("");
              setFreeze(true);
            }}
          >
            <BookmarkPlus size={15} />
            Freeze incident
          </Button>
          {r?.enabled && (
            <Button
              variant="ghost"
              disabled={w.busy}
              onClick={() =>
                void w.action("/configure", {
                  enabled: false,
                  intervalSeconds: r.intervalSeconds,
                  windowMinutes: r.windowMinutes,
                  retentionDays: r.retentionDays,
                })
              }
            >
              <Pause size={15} />
              Pause
            </Button>
          )}
        </div>
      </div>
      {!r?.enabled && (
        <WorkspaceSafety>
          Recording is paused. Open Capture settings to enable read-only polling. Existing evidence
          remains available until its retention limit.
        </WorkspaceSafety>
      )}
      {r?.error && <WorkspaceError message={r.error} />}
      <div className="ops-split">
        <aside aria-label="Incident history">
          <ScrollArea className="h-[520px]">
            <div className="ops-list">
              <button
                className="ops-list-item"
                aria-pressed={!incident}
                onClick={() => setSelected(undefined)}
              >
                <strong>Live rolling window</strong>
                <small>Latest observations · not a packet capture</small>
              </button>
              {[...(r?.incidents ?? [])].reverse().map((i) => (
                <button
                  key={i.id}
                  className="ops-list-item"
                  aria-pressed={incident?.id === i.id}
                  onClick={() => setSelected(i.id)}
                >
                  <small>{new Date(i.at).toLocaleString()}</small>
                  <strong>{i.title}</strong>
                  <EvidenceState state={i.complete ? "preserved" : "recording"} />
                  <small>
                    {i.samples.length} samples · {i.events.length} events
                  </small>
                </button>
              ))}
            </div>
          </ScrollArea>
        </aside>
        <section className="ops-panel">
          <div className="ops-toolbar">
            <Clock3 size={18} />
            <h3>{incident?.title ?? "The signal before the story"}</h3>
            {incident && (
              <Button variant="outline" disabled={w.busy} onClick={() => void download()}>
                <Download size={15} />
                Export evidence
              </Button>
            )}
          </div>
          <p className="ops-description">
            {incident
              ? `${new Date(incident.at).toLocaleString()} · ${incident.complete ? "Window preserved" : "Collecting two minutes of follow-up"}`
              : "Host receipt time · dots show management observations; the line shows CPU when measured."}
          </p>
          <FlightSignal samples={samples} />
          <div className="flight-legend">
            <span>● Management responded</span>
            <span>● Read failed</span>
            <span>○ Unavailable / skipped</span>
            <span>— CPU %</span>
          </div>
          <WorkspaceSafety>
            A management timeout is not proof of a tunnel failure. Missing samples and capture gaps
            are kept visible.{" "}
            {w.data?.toolEventsAvailable
              ? "MCP write/failure metadata is connected."
              : "MCP tool events unavailable: dashboard recording is disabled."}
          </WorkspaceSafety>
          <h3>Evidence timeline</h3>
          <ScrollArea className="h-[360px]">
            <ol className="flight-timeline">
              {[
                ...events.map((e) => ({
                  key: e.id,
                  at: e.at,
                  source: e.source,
                  title: e.title,
                  detail: e.routerTime
                    ? `Router clock: ${e.routerTime} · uncorrected`
                    : e.risk
                      ? `${e.risk} · ${e.failed ? "failed / outcome may be uncertain" : "tool completed"}`
                      : "",
                })),
                ...samples
                  .filter((s) => s.gaps.length)
                  .map((s) => ({
                    key: `gap:${s.at}`,
                    at: s.at,
                    source: "coverage gap",
                    title: s.gaps.join(" "),
                    detail: "Not a healthy sample",
                  })),
              ]
                .sort((a, b) => b.at - a.at)
                .slice(0, 500)
                .map((e) => (
                  <li key={e.key}>
                    <time>{new Date(e.at).toLocaleTimeString()}</time>
                    <div>
                      <small>{e.source}</small>
                      <strong>{e.title}</strong>
                      <p>{e.detail}</p>
                    </div>
                  </li>
                ))}
            </ol>
            {!events.length && !samples.some((s) => s.gaps.length) && (
              <p className="ops-empty">
                No events in this window. This does not prove that no changes occurred.
              </p>
            )}
          </ScrollArea>
        </section>
      </div>
      <Dialog open={configure} onOpenChange={setConfigure}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Capture, with clear limits.</DialogTitle>
            <DialogDescription>
              Read-only collection persists on this MCP host and resumes after restart. It never
              enables router logging or changes network settings.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh]">
            <div className="ops-form">
              <label>
                Sample interval · seconds
                <Input
                  type="number"
                  min={30}
                  max={300}
                  value={interval}
                  onChange={(e) => setIntervalValue(Number(e.target.value))}
                />
              </label>
              <label>
                Rolling window · minutes
                <Input
                  type="number"
                  min={15}
                  max={360}
                  value={window}
                  onChange={(e) => setWindow(Number(e.target.value))}
                />
              </label>
              <label>
                Incident retention · days
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={retention}
                  onChange={(e) => setRetention(Number(e.target.value))}
                />
              </label>
              <WorkspaceSafety>
                Up to 720 samples, 500 metadata events and 30 incidents per router. Raw log messages
                are not stored. Logs are polled over SSH, not a lossless remote syslog stream.
              </WorkspaceSafety>
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfigure(false)}>
              Cancel
            </Button>
            <Button
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
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={freeze} onOpenChange={setFreeze}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark this moment.</DialogTitle>
            <DialogDescription>
              Preserve the available lead-up and, while recording, two minutes of follow-up. No new
              router configuration is applied.
            </DialogDescription>
          </DialogHeader>
          <label>
            Incident title
            <Input
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="VPN disconnected during a call"
            />
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFreeze(false)}>
              Cancel
            </Button>
            <Button
              disabled={w.busy || !title.trim()}
              onClick={async () => {
                if (await w.action("/freeze", { title })) setFreeze(false);
              }}
            >
              Preserve window
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function FlightSignal({ samples }: { samples: FlightSample[] }) {
  if (!samples.length)
    return (
      <div className="flight-empty">
        No timeline yet.<span>Enable recording to collect evidence before the next incident.</span>
      </div>
    );
  const start = samples[0].at,
    span = Math.max(1, samples.at(-1)!.at - start),
    x = (s: FlightSample) => 12 + ((s.at - start) / span) * 976;
  return (
    <svg
      className="flight-signal"
      viewBox="0 0 1000 160"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${samples.length} management observations and available CPU samples`}
    >
      <line x1="12" x2="988" y1="136" y2="136" stroke="var(--border)" />
      {samples.map((s, i) => (
        <g key={s.at}>
          <circle
            cx={x(s)}
            cy="145"
            r="3"
            fill={
              s.reachable === true
                ? "var(--chart-2)"
                : s.reachable === false
                  ? "var(--destructive)"
                  : "var(--muted-foreground)"
            }
          />
          {s.cpu !== undefined && <circle cx={x(s)} cy={124 - s.cpu} r="2" fill="var(--primary)" />}
          {i > 0 &&
            s.cpu !== undefined &&
            samples[i - 1].cpu !== undefined &&
            s.at - samples[i - 1].at <= 300000 && (
              <line
                x1={x(samples[i - 1])}
                y1={124 - samples[i - 1].cpu!}
                x2={x(s)}
                y2={124 - s.cpu}
                stroke="var(--primary)"
                strokeWidth="2"
              />
            )}
        </g>
      ))}
    </svg>
  );
}
