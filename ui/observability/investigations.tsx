import { LoadingState } from "./loading-state";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ChevronRight, Plus, Search, Server } from "lucide-react";
import type { Investigation } from "../../src/investigations/model";
import { api, postJson } from "./api";
import { InvestigationClients } from "./investigation-clients";
import { InvestigationResult } from "./investigation-result";
import {
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  RouterPicker,
} from "./monitoring-ui";
import { Checkbox, TextInput } from "./kit";
import "./monitoring.css";
import "./investigations.css";

type CaseSummary = Omit<Investigation, "evidence" | "nextTests"> & {
  evidenceCount: number;
  unknownCount: number;
};

/** "Today 13:42", "Yesterday 17:20", "15 Nov 09:12". */
function caseTime(at: number): string {
  const d = new Date(at);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (diff === 0) return `Today ${hm}`;
  if (diff === 1) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${hm}`;
}

/** One case workspace: explicit scope, saved evidence and the next experiments nobody ran yet. */
export function InvestigationsView(): ReactNode {
  const vantageId = useId();
  const seed = new URLSearchParams(location.search);
  const [device, setDevice] = useState(seed.get("investigationDevice") ?? "");
  const [defaultDevice, setDefaultDevice] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [devices, setDevices] = useState<string[]>([]);
  const [client, setClient] = useState(seed.get("investigationClient") ?? "");
  const [target, setTarget] = useState("");
  const [service, setService] = useState("");
  const [vantages, setVantages] = useState<string[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selected, setSelected] = useState<Investigation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [starting, setStarting] = useState(seed.has("investigationClient"));
  const generation = useRef(0);
  const endpoint = `/api/investigations?device=${encodeURIComponent(device)}`;
  useEffect(() => {
    let disposed = false;
    void api<{ devices: { name: string }[]; defaultDevice: string }>("/api/devices")
      .then((r) => {
        if (disposed) return;
        setDevices(r.devices.map((d) => d.name));
        setDefaultDevice(r.defaultDevice);
        setDevice((d) => d || r.defaultDevice);
      })
      .catch(() => {
        if (!disposed) setError("Could not load devices. Check the dashboard connection.");
      })
      .finally(() => {
        if (!disposed) setInitialLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    const revision = ++generation.current;
    if (!device) return;
    let disposed = false;
    void api<{ cases: CaseSummary[] }>(endpoint)
      .then((r) => {
        if (!disposed && revision === generation.current) setCases(r.cases);
      })
      .catch(() => {
        if (!disposed && revision === generation.current)
          setError("Could not load case history for this device. Check access and local storage.");
      });
    return () => {
      disposed = true;
    };
  }, [device, endpoint]);
  function changeDevice(name: string): void {
    generation.current++;
    setDevice(name);
    setClient("");
    setSelected(null);
    setCases([]);
    setVantages([]);
    setError("");
    setFormError("");
  }
  async function create(): Promise<void> {
    const revision = generation.current;
    setBusy(true);
    setFormError("");
    try {
      const result = await postJson<Investigation & { error?: string }>(endpoint, {
        client,
        target,
        service,
        vantage_devices: vantages,
      });
      if (revision !== generation.current) return;
      if (result.error) throw new Error(result.error);
      if (!result.id)
        throw new Error("The server returned no saved case. Retry after checking storage.");
      setSelected(result);
      setStarting(false);
      const history = await api<{ cases: CaseSummary[] }>(endpoint);
      if (revision === generation.current) setCases(history.cases);
    } catch (e) {
      if (revision === generation.current)
        setFormError(e instanceof Error ? e.message : "Investigation failed");
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string): Promise<void> {
    const revision = ++generation.current;
    setSelected(null);
    setError("");
    try {
      const result = await api<Investigation>(
        `/api/investigations/${encodeURIComponent(id)}?device=${encodeURIComponent(device)}`,
      );
      if (revision === generation.current) setSelected(result);
    } catch {
      if (revision === generation.current)
        setError("Could not open this case. Access is checked for every evidence device.");
    }
  }
  if (initialLoading) return <LoadingState label="Loading investigations" layout="form" />;

  const others = devices.filter((d) => d !== device);
  const selectedId = selected?.id;
  const unknownText = (n: number): ReactNode =>
    n ? <span className="inv-warn">{n} unknown</span> : <span>0 unknown</span>;
  const startButton = (
    <MonitorButton
      variant="primary"
      icon={<Plus aria-hidden="true" />}
      disabled={!device}
      onClick={() => {
        setFormError("");
        setStarting(true);
      }}
    >
      New investigation
    </MonitorButton>
  );

  return (
    <div className="inv-page">
      <PageIntro
        eyebrow="Investigations"
        heading="Follow the evidence."
        lead="Investigate one client and one service. Probes run only when you create a case, and router configuration stays untouched."
        actions={
          <>
            <RouterPicker
              label="Access router"
              value={device}
              routers={devices}
              defaultRouter={defaultDevice}
              disabled={busy || !devices.length}
              onChange={changeDevice}
            />
            {startButton}
          </>
        }
      />
      {error && (
        <MonitorNote tone="bad" role="alert" icon={<AlertTriangle aria-hidden="true" />}>
          {error}
        </MonitorNote>
      )}

      {cases.length > 0 && (
        <div className="inv-strip" aria-label="Saved cases">
          {cases.map((c) => (
            <button
              key={c.id}
              type="button"
              className="glass"
              disabled={busy}
              aria-pressed={selectedId === c.id}
              onClick={() => void open(c.id)}
            >
              <b className="inv-trunc">{c.service}</b>
              <span className="inv-mono inv-mut inv-trunc">{c.client}</span>
              <span className="inv-hint">
                {caseTime(c.createdAt)} · {c.unknownCount} unknown
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="inv-grid">
        <div className="inv-col inv-left">
          <MonitorPanel
            className="inv-cases-panel"
            flush
            title="Saved cases"
            description={`${cases.length} on ${device || "this router"}`}
          >
            {cases.length ? (
              cases.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="monitor-row inv-case-row"
                  disabled={busy}
                  aria-pressed={selectedId === c.id}
                  data-selected={selectedId === c.id || undefined}
                  onClick={() => void open(c.id)}
                >
                  <span className="p inv-trunc">{c.service}</span>
                  <span className="inv-mono inv-mut inv-trunc">{c.client}</span>
                  <span className="inv-case-when">
                    {caseTime(c.createdAt)} · {unknownText(c.unknownCount)}
                  </span>
                </button>
              ))
            ) : (
              <MonitorEmpty compact title="No saved cases">
                Start an investigation to keep its evidence here.
              </MonitorEmpty>
            )}
          </MonitorPanel>
          {selected && selected.nextTests.length > 0 && (
            <MonitorPanel
              className="inv-next-panel"
              title="Close the evidence gaps"
              description={
                <>
                  <span className="inv-long">Next experiments. None run automatically.</span>
                  <span className="inv-short">Not run automatically.</span>
                </>
              }
            >
              <ol className="inv-next">
                {selected.nextTests.map((t, i) => (
                  <li key={t}>
                    <span className="monitor-chip">{i + 1}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol>
            </MonitorPanel>
          )}
        </div>
        {selected ? (
          <InvestigationResult investigation={selected} />
        ) : (
          <div className="glass">
            <MonitorEmpty
              icon={<Search />}
              title="Pick a saved case or start a new one"
              action={startButton}
            >
              The client picker reads DHCP and ARP records. Probes run only when you create a case.
            </MonitorEmpty>
          </div>
        )}
      </div>

      <MonitorDialog
        open={starting}
        onOpenChange={(v) => {
          if (!busy) setStarting(v);
        }}
        dismissible={false}
        closeDisabled={busy}
        width={760}
        title="Start an investigation"
        description="One client, one service. Router configuration stays untouched."
        footer={
          <>
            <span className="inv-hint flex-1">
              {busy
                ? "Reading sources one by one. Sources that fail stay unknown."
                : "Three ICMP probes per router. No probe from the client."}
            </span>
            <MonitorButton variant="ghost" disabled={busy} onClick={() => setStarting(false)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              type="submit"
              form={`${vantageId}-form`}
              variant="primary"
              disabled={busy || !device || !devices.includes(device)}
            >
              {busy ? "Collecting evidence…" : "Create investigation"}
              <ChevronRight aria-hidden="true" />
            </MonitorButton>
          </>
        }
      >
        <form
          id={`${vantageId}-form`}
          className="monitor-dialog-body inv-dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !device || !devices.includes(device)) return;
            void create();
          }}
        >
          <div className="inv-two">
            <div className="monitor-fl inv-full">
              <span className="monitor-label">Access router</span>
              <RouterPicker
                label="Access router"
                value={device}
                routers={devices}
                defaultRouter={defaultDevice}
                disabled={busy || !devices.length}
                onChange={changeDevice}
              />
            </div>
            <label className="monitor-fl">
              <span className="monitor-label">Client IPv4 or MAC</span>
              <TextInput
                mono
                label="Client IPv4 or MAC"
                value={client}
                onChange={setClient}
                placeholder="Pick below or type an IPv4 or MAC"
                required
                disabled={busy}
              />
            </label>
          </div>
          <InvestigationClients
            key={device}
            device={device}
            value={client}
            disabled={busy}
            onSelect={setClient}
          />
          <div className="inv-two">
            <label className="monitor-fl">
              <span className="monitor-label">Destination hostname or IPv4</span>
              <TextInput
                mono
                label="Destination hostname or IPv4"
                value={target}
                onChange={setTarget}
                placeholder="payments.example.com"
                required
                disabled={busy}
              />
            </label>
            <label className="monitor-fl">
              <span className="monitor-label">Service label</span>
              <TextInput
                label="Service label"
                value={service}
                onChange={setService}
                placeholder="Branch payment service"
                maxLength={120}
                required
                disabled={busy}
              />
              <span className="monitor-hint">Up to 120 characters.</span>
            </label>
          </div>
          <fieldset className="monitor-fl min-w-0" aria-describedby={`${vantageId}-help`}>
            <legend className="sr-only">Other routers to compare</legend>
            <span className="inv-persp-head">
              <span className="monitor-label">Other routers to compare · optional</span>
              <span className="monitor-chip" aria-live="polite">
                {vantages.length} / 2 selected
              </span>
            </span>
            {others.length ? (
              <div className="inv-persp">
                {others.map((d) => {
                  const checked = vantages.includes(d);
                  const atLimit = !checked && vantages.length >= 2;
                  const off = busy || atLimit;
                  return (
                    <label
                      key={d}
                      className="monitor-choice"
                      data-on={checked || undefined}
                      data-off={off || undefined}
                    >
                      <Server aria-hidden="true" />
                      <span className="inv-persp-name">
                        <span className="inv-mono inv-trunc" title={d}>
                          {d}
                        </span>
                        <small>
                          {checked
                            ? "Included in investigation"
                            : atLimit
                              ? "Two-router limit reached"
                              : "Add another perspective"}
                        </small>
                      </span>
                      <Checkbox
                        aria-label={`Include ${d} as an additional router`}
                        checked={checked}
                        disabled={off}
                        onCheckedChange={(next) => {
                          setVantages((current) => {
                            if (!next) return current.filter((name) => name !== d);
                            if (current.includes(d) || current.length >= 2) return current;
                            return [...current, d];
                          });
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="inv-hint">No other routers. The access router alone is enough.</p>
            )}
            <span id={`${vantageId}-help`} className="monitor-hint">
              Compare evidence from up to two more routers. Selecting one does not contact it.
            </span>
          </fieldset>
          {formError && (
            <MonitorNote tone="bad" role="alert" icon={<AlertTriangle aria-hidden="true" />}>
              {formError}
            </MonitorNote>
          )}
        </form>
      </MonitorDialog>
    </div>
  );
}
