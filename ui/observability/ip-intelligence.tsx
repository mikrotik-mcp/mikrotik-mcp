import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Copy, Download, Globe2, Search, Shield, ShieldCheck } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { IpIntelligence, IpProviderResult } from "../../src/core/ip-intelligence";
import { postJson } from "./api";
import { saveDownload } from "./workspace-ui";
import {
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorSearch,
  PageIntro,
  StatusBadge,
} from "./monitoring-ui";
import { PerspectiveGraphic } from "./ip-perspective";
import { TextInput } from "./kit";
import type { PerspectiveSource } from "./ip-perspective";
import "./ip-intelligence.css";

/** Keep unknown fields, false, zero, null and arrays visible as providers evolve. */
function fields(data: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  const pending: [string, unknown][] = Object.entries(data).reverse();
  while (pending.length) {
    const [path, value] = pending.pop()!;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value).reverse())
        pending.push([`${path}.${key}`, child]);
    } else rows.push([path, typeof value === "string" ? value : JSON.stringify(value)]);
  }
  return rows;
}

/** "17 Nov 2026, 14:02" */
function dateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "15:02" */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const PROVIDERS = ["ipquery", "ipkit"] as const;

function elapsed(result: IpProviderResult): string {
  return result.elapsedMs === undefined
    ? "No external request"
    : `${result.elapsedMs.toLocaleString()} ms`;
}

function ProviderCard({ name, result }: { name: string; result: IpProviderResult }) {
  const [search, setSearch] = useState("");
  const rows = fields(result.data ?? {});
  const visible = rows.filter(([key, value]) =>
    `${key} ${value}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const get = (...paths: string[]) =>
    paths
      .map((path) => rows.find(([key]) => key === path)?.[1])
      .find((value) => value && value !== "null") ?? "Not reported";
  const countryCode = get("location.country_code", "country_code");
  return (
    <section className="monitor-panel ipi-provider" aria-label={`${name} result`}>
      <header className="monitor-panel-head">
        <div className="min-w-0">
          <p className="ipi-source-eyebrow">Independent source</p>
          <h2 className="ipi-source-name">
            {name}
            {result.status === "ready" ? (
              <StatusBadge tone="good">Received</StatusBadge>
            ) : result.status === "skipped" ? (
              <StatusBadge quiet>Local only</StatusBadge>
            ) : (
              <StatusBadge tone="bad">Unavailable</StatusBadge>
            )}
          </h2>
        </div>
        <span className="ipi-mono-mut">{elapsed(result)}</span>
      </header>
      {result.status !== "ready" ? (
        <div role="status">
          <MonitorEmpty
            compact
            icon={<ShieldCheck />}
            title={result.error ?? "No provider data available"}
          />
        </div>
      ) : (
        <>
          <div className="ipi-summary">
            <div className="glass">
              <span className="monitor-hint">Network organization</span>
              <b>{get("isp.org", "asn_organization", "organization", "org")}</b>
              <span className="ipi-mono-mut">{get("isp.asn", "asn")}</span>
            </div>
            <div className="glass">
              <span className="monitor-hint">Approximate location</span>
              <b className="ipi-country">
                {/^[a-z]{2}$/i.test(countryCode) && (
                  <span className="monitor-chip">{countryCode.toUpperCase()}</span>
                )}
                {get("location.country", "country")}
              </b>
              <span className="ipi-city">{get("location.city", "city")}</span>
            </div>
          </div>
          <div className="ipi-field-search">
            <MonitorSearch
              label={`Search ${name} fields`}
              placeholder="Find a field or value…"
              value={search}
              onChange={setSearch}
            />
            <span className="ipi-mono-mut">
              {visible.length} / {rows.length}
            </span>
          </div>
          <ScrollArea
            aria-label={`${name} complete fields`}
            viewportProps={{ className: "ipi-fields-viewport" }}
          >
            <dl className="ipi-fields">
              {visible.map(([key, value]) => (
                <div key={key}>
                  <dt title={key}>{key}</dt>
                  <dd title={value}>{value}</dd>
                </div>
              ))}
            </dl>
            {!visible.length && <p className="ipi-no-match monitor-hint">No matching fields.</p>}
          </ScrollArea>
          <details className="ipi-json">
            <summary>
              <ChevronRight aria-hidden="true" />
              <span>Original JSON · all fields</span>
              <span className="ipi-mono-mut">raw</span>
            </summary>
            <ScrollArea className="h-64">
              <pre className="monitor-pre">{JSON.stringify(result.data, null, 2)}</pre>
            </ScrollArea>
          </details>
        </>
      )}
    </section>
  );
}

export function IpIntelligenceView() {
  const [ip, setIp] = useState("");
  const [result, setResult] = useState<IpIntelligence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function lookup() {
    const ticket = ++generation.current;
    setBusy(true);
    setError("");
    setResult(null);
    setCopyState("");
    try {
      const data = await postJson<IpIntelligence | { error: string }>("/api/ip-intelligence", {
        ip: ip.trim(),
      });
      if (ticket !== generation.current) return;
      if ("error" in data) throw new Error(data.error);
      if (!data.providers) throw new Error("The server did not return an IP report. Please retry.");
      setResult(data);
    } catch (cause) {
      if (ticket === generation.current)
        setError(cause instanceof Error ? cause.message : "Lookup failed. Please retry.");
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  async function copy() {
    const ticket = generation.current;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      if (ticket === generation.current) setCopyState("Copied");
    } catch {
      if (ticket === generation.current) setCopyState("Copy unavailable; download JSON instead.");
    }
  }

  const received = result
    ? Object.values(result.providers).filter((provider) => provider.status === "ready").length
    : 0;
  const sources = PROVIDERS.map((name): PerspectiveSource => {
    const provider = result?.providers[name];
    if (!provider) return { name, detail: "—", tone: "good" };
    return {
      name,
      detail:
        provider.status === "ready" || provider.elapsedMs !== undefined
          ? elapsed(provider)
          : provider.status === "skipped"
            ? "Local only"
            : "Unavailable",
      tone: provider.status === "ready" ? "good" : provider.status === "skipped" ? "muted" : "bad",
    };
  }) as [PerspectiveSource, PerspectiveSource];

  return (
    <div className="ipi-page">
      <PageIntro
        eyebrow="Public IP · intelligence"
        verdict={
          <>
            An IP. <span className="s">Two perspectives.</span>
          </>
        }
        lead="See the network behind an address. Compare its organization, location and risk from two sources, with every field kept."
        actions={
          <form
            className="ipi-lookup glass"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && ip.trim()) void lookup();
            }}
          >
            <label htmlFor="ipi-address" className="monitor-label">
              IP address <span className="text-faint">· IPv4 or IPv6</span>
            </label>
            <div className="ipi-lookup-row">
              <TextInput
                id="ipi-address"
                mono
                placeholder="e.g. 1.1.1.1 or 2606:4700::1111"
                required
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                value={ip}
                onChange={(value) => {
                  setIp(value);
                  generation.current++;
                  setBusy(false);
                  setResult(null);
                  setError("");
                  setCopyState("");
                }}
              />
              <MonitorButton
                type="submit"
                variant="primary"
                disabled={busy || !ip.trim()}
                icon={<Search aria-hidden="true" />}
              >
                {busy ? "Looking up…" : "Look up IP"}
              </MonitorButton>
            </div>
            <span className="monitor-hint">
              Only when you submit: public IPs go to ipquery and ipkit from the MCP host. Private
              addresses stay local. No router changes.
            </span>
          </form>
        }
        aside={
          <div className="ipi-aside glass">
            <PerspectiveGraphic
              address={result?.ip ?? (ip.trim() || "—")}
              sources={sources}
              drawKey={result}
            />
            <MonitorNote icon={<Shield aria-hidden="true" />}>
              <b>Information, not identity.</b> Provider claims are approximate. They do not prove
              who a user is, a threat, or your router’s real exit path.
            </MonitorNote>
          </div>
        }
      />
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {busy && <LoadingState label="Gathering two independent perspectives" layout="cards" />}
      {!busy && !result && !error && (
        <section className="glass">
          <MonitorEmpty
            icon={<Globe2 />}
            title="Start with an address"
            action={
              <div className="ipi-examples">
                {["1.1.1.1", "8.8.8.8", "2606:4700::1111"].map((value) => (
                  <MonitorButton key={value} size="sm" onClick={() => setIp(value)}>
                    <span className="font-mono">{value}</span>
                  </MonitorButton>
                ))}
              </div>
            }
          >
            Full provider responses. Searchable fields. Exportable evidence.
            <span className="monitor-hint block pt-1">
              Examples fill the input; they do not send a request.
            </span>
          </MonitorEmpty>
        </section>
      )}
      {result && (
        <>
          <section className="ipi-result-head glass" aria-label="Lookup summary">
            <div className="ipi-result-main">
              <p className="ipi-eyebrow">
                {result.public ? "Public address" : "Non-public address"} · IPv{result.version}
              </p>
              <span className="ipi-address">{result.ip}</span>
              <span className="ipi-result-line">
                {result.cached ? "Cached result" : "Fresh result"} · {dateTime(result.lookedUpAt)} ·{" "}
                <span className={received === 2 ? "text-success" : "text-warning"}>
                  {received} of 2 sources received
                </span>
              </span>
              {result.public && (
                <span className="monitor-hint">
                  Cache valid until {clock(result.expiresAt)}. Submit again after that to refresh.
                </span>
              )}
            </div>
            <div className="ipi-result-actions">
              <span role="status" className="monitor-hint">
                {copyState}
              </span>
              <MonitorButton
                size="sm"
                icon={<Copy aria-hidden="true" />}
                onClick={() => void copy()}
              >
                Copy report
              </MonitorButton>
              <MonitorButton
                size="sm"
                icon={<Download aria-hidden="true" />}
                onClick={() =>
                  saveDownload(
                    `ip-${result.ip.replaceAll(":", "-")}.json`,
                    JSON.stringify(result, null, 2),
                    "application/json",
                  )
                }
              >
                Export JSON
              </MonitorButton>
            </div>
          </section>
          <div className="ipi-providers">
            {PROVIDERS.map((name) => (
              <ProviderCard
                key={`${result.ip}-${name}`}
                name={name}
                result={result.providers[name]}
              />
            ))}
          </div>
          <p className="monitor-hint">
            Sources can disagree, so each response stays separate. Every field comes from the named
            provider and is untrusted reference data. False, zero and null values are kept.
          </p>
        </>
      )}
    </div>
  );
}
