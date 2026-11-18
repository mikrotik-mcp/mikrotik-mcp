import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, Download, Eye, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "./api";
import { LoadingState } from "./loading-state";
import {
  MonitorButton,
  MonitorDialog,
  MonitorNote,
  MonitorPanel,
  MonitorSelect,
  PageIntro,
  RouterPicker,
  Segmented,
} from "./monitoring-ui";
import { saveDownload, useWorkspaceClock, workspacePost } from "./workspace-ui";
import type { DevicesPayload } from "./types";
import type { Bundle } from "../../src/support/bundle";
import type { Investigation } from "../../src/investigations/model";
import "./monitoring.css";
import "./support-bundles.css";

const STROKE = 1.6;

const WINDOWS = [
  { value: "1", label: "Last hour" },
  { value: "24", label: "Last 24 hours" },
  { value: "72", label: "Last 3 days" },
  { value: "168", label: "Last 7 days" },
];

function dayTime(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

/** "Today 13:42", "Yesterday 17:20", "15 Nov 09:12". */
function relativeDay(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?/g;
const ALIAS = /^"[a-z]+-\d+"$/;

/** The report as JSON, keys in the accent colour and aliases in teal, as text nodes only. */
function highlightJson(value: unknown): ReactNode[] {
  const text = JSON.stringify(value, null, 2);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[2] != null)
      out.push(
        <span key={i} className="sb-k">
          {m[1]}
        </span>,
        m[2],
      );
    else if (ALIAS.test(m[1]))
      out.push(
        <span key={i} className="sb-a">
          {m[1]}
        </span>,
      );
    else out.push(m[1]);
    last = i + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** "last 24 hours" from the report's own window, when it matches a preset. */
function windowLabel(b: Bundle): string | null {
  const w = b.report.window as { from?: string; to?: string } | undefined;
  if (!w?.from || !w.to) return null;
  const hours = Math.round((Date.parse(w.to) - Date.parse(w.from)) / 3600000);
  const preset = WINDOWS.find((o) => Number(o.value) === hours);
  return preset ? preset.label.toLowerCase() : null;
}

function errorNote(message: string): ReactNode {
  return (
    <MonitorNote
      tone="bad"
      role="alert"
      icon={<TriangleAlert aria-hidden="true" strokeWidth={STROKE} />}
    >
      {message}
    </MonitorNote>
  );
}

export function SupportBundlesView() {
  const [initialLoading, setInitialLoading] = useState(true);
  const [devices, setDevices] = useState<string[]>([]),
    [defaultDevice, setDefaultDevice] = useState<string>(),
    [device, setDevice] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    api<DevicesPayload>("/api/devices", abort.signal)
      .then((v) => {
        const enabled = v.devices.filter((d) => !d.disabled).map((d) => d.name);
        setDevices(enabled);
        setDefaultDevice(v.defaultDevice);
        setDevice(enabled.includes(v.defaultDevice) ? v.defaultDevice : (enabled[0] ?? ""));
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => setInitialLoading(false));
    return () => abort.abort();
  }, []);
  return (
    <div className="sb-page">
      <PageIntro
        eyebrow="Support bundles"
        heading="Share the evidence. Keep the private details."
        lead="Prepare a focused support report from saved network evidence. Review exactly what leaves the dashboard before you download it."
        actions={
          <>
            <span className="monitor-label">Workspace router</span>
            <RouterPicker
              label="Workspace router"
              value={device}
              routers={devices}
              defaultRouter={defaultDevice}
              onChange={setDevice}
            />
          </>
        }
      />
      {error && errorNote(error)}
      {initialLoading ? (
        <LoadingState label="Loading workspace routers" layout="form" />
      ) : device ? (
        <Bundles key={device} device={device} />
      ) : (
        <MonitorNote>Select a configured router to start.</MonitorNote>
      )}
    </div>
  );
}

function Stepper({ labels, active }: { labels: string[]; active: number }) {
  return (
    <ol aria-label="Workflow steps" className="sb-steps">
      {labels.map((label, i) => (
        <li
          key={label}
          className="sb-step"
          data-state={i < active ? "done" : i === active ? "on" : undefined}
          aria-current={i === active ? "step" : undefined}
        >
          <span className="sb-step-bar" />
          <span className="sb-step-label">
            <span className="monitor-chip">
              {i < active ? <Check aria-hidden="true" size={12} strokeWidth={STROKE} /> : i + 1}
            </span>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Bundles({ device }: { device: string }) {
  const now = useWorkspaceClock();
  const [casesError, setCasesError] = useState("");
  const [hours, setHours] = useState("24"),
    [cases, setCases] = useState<Investigation[]>([]),
    [chosen, setChosen] = useState<string[]>([]);
  const [include, setInclude] = useState({
    includeEvents: true,
    includeSnapshots: true,
    includeChecks: true,
  });
  const [bundles, setBundles] = useState<Bundle[]>([]),
    [selected, setSelected] = useState<Bundle | null>(null),
    [reviewed, setReviewed] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setBundles(await api<Bundle[]>(`/api/support-bundles?device=${encodeURIComponent(device)}`));
  }
  useEffect(() => {
    const abort = new AbortController();
    api<Bundle[]>(`/api/support-bundles?device=${encodeURIComponent(device)}`, abort.signal)
      .then(setBundles)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    api<{ cases: Investigation[] }>(
      `/api/investigations?device=${encodeURIComponent(device)}`,
      abort.signal,
    )
      .then((d) => setCases(d.cases ?? []))
      .catch((e) => {
        if (!abort.signal.aborted) setCasesError(e.message);
      });
    return () => abort.abort();
  }, [device]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    const until = Date.now(),
      since = until - Number(hours) * 3600000;
    const report = await workspacePost<Bundle>("/api/support-bundles", device, {
      since,
      until,
      cases: chosen,
      ...include,
    });
    setSelected(report);
    setReviewed(false);
    await load();
  }
  async function download(format: "json" | "html") {
    if (!selected || !reviewed) return;
    const data = await workspacePost<{ content: string }>("/api/support-bundles/export", device, {
      id: selected.id,
      format,
    });
    saveDownload(
      `network-support-${selected.id}.${format}`,
      data.content,
      format === "html" ? "text/html" : "application/json",
    );
  }
  const inWindow = cases.filter((c) => c.createdAt >= now - Number(hours) * 3600000);
  const contents = [
    ["includeEvents", "Tool activity", "Names, timings and outcomes. No arguments or output."],
    [
      "includeSnapshots",
      "Configuration inventory",
      "Section names and counts. No raw exports or values.",
    ],
    [
      "includeChecks",
      "Client measurements",
      "HTTP timing and transfer summaries. No invitation tokens.",
    ],
  ] as const;
  return (
    <div className="sb-body">
      <Stepper
        labels={["Choose evidence", "Review privacy", "Download locally"]}
        active={reviewed ? 2 : selected ? 1 : 0}
      />
      {error && errorNote(error)}
      <div className="sb-grid">
        <MonitorPanel title="Report contents">
          <div className="sb-stack">
            <div className="monitor-fl">
              <span className="monitor-label">Evidence window</span>
              <Segmented
                label="Evidence window"
                value={hours}
                options={WINDOWS}
                onChange={(v) => {
                  setHours(v);
                  setChosen([]);
                }}
              />
            </div>
            {contents.map(([key, title, description]) => (
              <label key={key} className="sb-choice" data-on={include[key] || undefined}>
                <span className="monitor-check sb-box">
                  <input
                    type="checkbox"
                    checked={include[key]}
                    onChange={(e) => setInclude((i) => ({ ...i, [key]: e.target.checked }))}
                  />
                </span>
                <span className="sb-choice-text">
                  <span className="sb-choice-title">{title}</span>
                  <small>{description}</small>
                </span>
              </label>
            ))}
            <div className="monitor-fl" role="group" aria-labelledby="sb-cases-label">
              <span className="sb-cases-head">
                <span id="sb-cases-label" className="monitor-label">
                  Investigation cases · optional, up to ten
                </span>
                <span className="monitor-chip">{chosen.length} selected</span>
              </span>
              {inWindow.map((c) => (
                <label key={c.id} className="sb-case">
                  <span className="monitor-check sb-box">
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.id)}
                      disabled={!chosen.includes(c.id) && chosen.length >= 10}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setChosen((a) => (on ? [...a, c.id] : a.filter((id) => id !== c.id)));
                      }}
                    />
                  </span>
                  <span className="sb-case-text">
                    <span className="sb-case-title">{c.service}</span>
                    <span className="sb-mono">
                      {c.client} · {relativeDay(c.createdAt, now)}
                    </span>
                  </span>
                </label>
              ))}
              {casesError && errorNote(`Could not load investigations: ${casesError}`)}
              {!casesError && !inWindow.length && (
                <p className="monitor-hint sb-case-empty">
                  No saved investigations in this window. Other evidence can still be included.
                </p>
              )}
            </div>
            <div className="sb-row">
              <MonitorButton
                variant="primary"
                disabled={busy}
                icon={<Eye aria-hidden="true" strokeWidth={STROKE} />}
                onClick={() => void work(create)}
              >
                {busy ? "Preparing…" : "Prepare private preview"}
              </MonitorButton>
              <span className="monitor-hint">
                Saved records only. Nothing is queried on a router or sent anywhere.
              </span>
            </div>
          </div>
        </MonitorPanel>
        <div className="sb-col">
          <MonitorPanel title="Saved reports">
            <div className="sb-stack">
              <span className="sb-select">
                <MonitorSelect
                  label="Saved support report"
                  value={selected?.id ?? ""}
                  onChange={(id) => {
                    setSelected(bundles.find((b) => b.id === id) ?? null);
                    setReviewed(false);
                  }}
                  options={[
                    { value: "", label: "Choose a prepared report" },
                    ...bundles.map((b) => {
                      const span = windowLabel(b);
                      return {
                        value: b.id,
                        label: `Report · ${dayTime(b.createdAt)}${span ? ` · ${span}` : ""}`,
                      };
                    }),
                  ]}
                />
              </span>
              {selected ? (
                <>
                  <div className="sb-export-head">
                    <b>This is the export</b>
                    <span className="monitor-chip">MINIMISED / v1</span>
                  </div>
                  <pre
                    aria-label="Support report preview"
                    tabIndex={0}
                    className="monitor-pre sb-pre"
                  >
                    {highlightJson(selected.report)}
                  </pre>
                  <p className="monitor-hint sb-digest">SHA-256 · {selected.digest}</p>
                  <label className="monitor-check">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    <span className="sb-review">
                      I reviewed the complete report. I understand minimisation does not guarantee
                      anonymity.
                    </span>
                  </label>
                  <div className="sb-row">
                    <MonitorButton
                      variant="primary"
                      disabled={!reviewed || busy}
                      icon={<Download aria-hidden="true" strokeWidth={STROKE} />}
                      onClick={() => void work(() => download("html"))}
                    >
                      Download HTML
                    </MonitorButton>
                    <MonitorButton
                      variant="ghost"
                      disabled={!reviewed || busy}
                      onClick={() => void work(() => download("json"))}
                    >
                      JSON
                    </MonitorButton>
                    <MonitorButton
                      variant="danger"
                      disabled={busy}
                      icon={<Trash2 aria-hidden="true" strokeWidth={STROKE} />}
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete report
                    </MonitorButton>
                    <span className="flex-1" />
                  </div>
                  <span className="monitor-hint">
                    HTML is self-contained and script-free. Downloading does not upload or share it.
                  </span>
                </>
              ) : (
                <MonitorNote>
                  Choose a time window and prepare a preview. You will see every exported field here
                  before downloading.
                </MonitorNote>
              )}
            </div>
          </MonitorPanel>
          <MonitorPanel title="What stays out">
            <div className="sb-stack">
              {[
                "Passwords and private keys",
                "Raw tool input and output",
                "Config values and raw logs",
                "Personal labels and hostnames",
              ].map((text) => (
                <span key={text} className="sb-out">
                  <X aria-hidden="true" size={14} strokeWidth={STROKE} />
                  {text}
                </span>
              ))}
              <MonitorNote>
                IP and MAC addresses and names become consistent aliases, so relationships stay
                useful. The reverse map is discarded. Timestamps and structure may still identify
                your network.
              </MonitorNote>
            </div>
          </MonitorPanel>
        </div>
      </div>
      <MonitorDialog
        confirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this local report?"
        description="Original evidence and exported copies are unchanged. This saved report will be removed from this server."
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="danger"
              icon={<Trash2 aria-hidden="true" strokeWidth={STROKE} />}
              onClick={() => {
                setConfirmDelete(false);
                if (!selected) return;
                void work(async () => {
                  await workspacePost("/api/support-bundles/delete", device, {
                    id: selected.id,
                    confirm: true,
                  });
                  setSelected(null);
                  await load();
                });
              }}
            >
              Delete report
            </MonitorButton>
          </>
        }
      >
        {null}
      </MonitorDialog>
    </div>
  );
}
