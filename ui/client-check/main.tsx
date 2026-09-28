import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { summarizeRun, CHECK_HEARTBEAT_MS } from "../../src/client-check/model";
import { runCheck } from "./runner";
import type { Measurement, TestProgress } from "./runner";
import "./style.css";

function App() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [credentials] = useState(() => {
    const [id, token] = location.hash.slice(1).split(".");
    history.replaceState(null, "", location.pathname);
    return { id, token };
  });
  const [info, setInfo] = useState<{ label: string; expiresAt: number; runs: number } | null>(null),
    [error, setError] = useState("");
  const [presence, setPresence] = useState("Connecting to dashboard…");
  const [path, setPath] = useState<Measurement["path"]>("wifi"),
    [label, setLabel] = useState("First comparison"),
    [consent, setConsent] = useState(false);
  const [progress, setProgress] = useState<TestProgress | null>(null),
    [result, setResult] = useState<Measurement | null>(null),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const request = useCallback(
    async (action: string, body?: unknown) => {
      const r = await fetch(`/client-check-api/${credentials.id}/${action}`, {
        method: body ? "POST" : "GET",
        headers: { "x-client-check-token": credentials.token, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const value = await r.json();
      if (!r.ok) throw new Error(value.error ?? "Check unavailable");
      return value;
    },
    [credentials],
  );
  useEffect(() => {
    let active = true;
    request("info")
      .then((v) => {
        if (active) setInfo(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      abort.current?.abort();
    };
  }, [request]);
  const expiresAt = info?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const heartbeat = async () => {
      if (Date.now() >= expiresAt) {
        if (active) setPresence("Invitation expired");
        return;
      }
      try {
        await request("presence", {});
        if (active) setPresence("Connected · visible on the dashboard");
      } catch {
        if (active) setPresence("Connection interrupted · reconnecting…");
      }
      if (active) timer = setTimeout(() => void heartbeat(), CHECK_HEARTBEAT_MS);
    };
    void heartbeat();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [expiresAt, request]);
  async function start() {
    setBusy(true);
    setError("");
    setResult(null);
    setSaved(false);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const r = await runCheck(
        credentials.id,
        credentials.token,
        label,
        path,
        controller.signal,
        setProgress,
      );
      setResult(r);
      setProgress(null);
      if (!controller.signal.aborted) {
        await request("result", r);
        setSaved(true);
        setInfo((i) => (i ? { ...i, runs: i.runs + 1 } : i));
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save this run. Measurements remain below.",
      );
    } finally {
      setBusy(false);
    }
  }
  const stats = result ? summarizeRun(result) : null;
  return (
    <main>
      <header>
        <span className="eyebrow">MIKROTIK MCP / CLIENT CHECK</span>
        <span className="pill">No router changes</span>
      </header>
      <section className="intro">
        <h1>
          Your connection.
          <br />
          <span>From your side.</span>
        </h1>
        <p>
          Test the path from this device to the MCP host. Compare Wi-Fi with your VPN without
          guessing what the router sees.
        </p>
      </section>
      <div className="path">
        <span>This browser</span>
        <span aria-hidden="true">⟶</span>
        <span>{location.host}</span>
      </div>
      {info && (
        <p role="status" className="connection-status">
          {presence}
        </p>
      )}
      <p className="scope">
        A server inside your home measures LAN/VPN access, not internet speed. For WAN measurements,
        use an approved MCP test host across that WAN. HTTP timings are not ICMP ping or application
        availability.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!info && !error && <p role="status">Checking your invitation…</p>}
      {info && (
        <section className="card">
          <div className="section-heading">
            <h2>{info.label}</h2>
            <span>{info.runs}/6 saved</span>
          </div>
          <p>
            Invitation expires {new Date(info.expiresAt).toLocaleTimeString()}. Refreshing this page
            clears your private invitation; reopen the original link if needed.
          </p>
          <div className="form-grid">
            <label>
              Connection
              <select
                value={path}
                onChange={(e) => setPath(e.target.value as Measurement["path"])}
                disabled={busy}
              >
                {["wifi", "vpn", "mobile", "ethernet", "other"].map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Run label
              <input
                value={label}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
          </div>
          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              disabled={busy}
            />
            I agree to transfer up to 20 MiB and save measurements plus the IP address seen by this
            server. No browsing history is collected.
          </label>
          <div className="actions">
            <button
              onClick={() => void start()}
              disabled={!consent || busy || !label.trim() || info.runs >= 6 || info.expiresAt < now}
            >
              {result ? "Run another comparison" : "Start measurement"}
            </button>
            {busy && (
              <button className="secondary" onClick={() => abort.current?.abort()}>
                Cancel test
              </button>
            )}
          </div>
        </section>
      )}
      {progress && (
        <section className="card" role="status">
          <div className="section-heading">
            <h2>{progress.phase}</h2>
            <span>{(progress.transferred / 1048576).toFixed(1)} / 20 MiB</span>
          </div>
          <progress max={20 * 1048576} value={progress.transferred} />
          <div className="spark" aria-label="HTTP latency samples">
            {progress.samples.map((v, i) => (
              <i
                key={i}
                style={{ height: `${Math.max(4, Math.min(90, v))}px` }}
                title={`${v.toFixed(1)} ms`}
              />
            ))}
          </div>
        </section>
      )}
      {stats && (
        <section className="card">
          <div className="section-heading">
            <h2>{stats.complete ? "Measurement complete" : "Partial measurement"}</h2>
            <span className="pill">{saved ? "Saved to dashboard" : "Not saved"}</span>
          </div>
          <div className="metrics">
            {[
              ["Download", stats.downloadMbps, "Mbps"],
              ["Upload", stats.uploadMbps, "Mbps"],
              ["Idle latency", stats.idleMs, "ms"],
              ["Loaded latency", stats.loadedMs, "ms"],
            ].map(([name, v, unit]) => (
              <div key={String(name)}>
                <span>{name}</span>
                <strong>
                  {typeof v === "number" ? v.toFixed(1) : "—"}
                  <small>{unit}</small>
                </strong>
              </div>
            ))}
          </div>
          {!!result?.errors.length && (
            <p className="error">
              Unavailable phases: {result.errors.join(", ")}. Missing data is not zero.
            </p>
          )}
          <p>
            For an A/B comparison, change your network or VPN yourself, keep this page open, select
            the matching connection label and run again. Short transfers may under-estimate
            high-capacity links.
          </p>
        </section>
      )}
      <footer>Scoped invitation · no dashboard access · no automatic configuration changes</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
