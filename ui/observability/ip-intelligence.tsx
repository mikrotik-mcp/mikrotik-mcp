import { useEffect, useRef, useState } from "react";
import { Copy, Download, Globe2, Loader2, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { IpIntelligence, IpProviderResult } from "../../src/core/ip-intelligence";
import { postJson, withToken } from "./api";
import { saveDownload } from "./workspace-ui";
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
    <article className="ipi-provider" aria-label={`${name} result`}>
      <header className="ipi-provider-head">
        <div>
          <span className="ipi-kicker">Independent source</span>
          <h3>
            {name}
            <span className={`ipi-state ipi-state--${result.status}`}>
              {result.status === "ready"
                ? "Received"
                : result.status === "skipped"
                  ? "Local only"
                  : "Unavailable"}
            </span>
          </h3>
        </div>
        <span className="ipi-muted">
          {result.elapsedMs === undefined
            ? "No external request"
            : `${result.elapsedMs.toLocaleString()} ms`}
        </span>
      </header>
      {result.status !== "ready" ? (
        <div className="ipi-provider-empty" role="status">
          <ShieldCheck size={24} />
          <p>{result.error ?? "No provider data available"}</p>
        </div>
      ) : (
        <>
          <div className="ipi-summary">
            <div>
              <span>Network organization</span>
              <strong>{get("isp.org", "asn_organization", "organization", "org")}</strong>
              <small>{get("isp.asn", "asn")}</small>
            </div>
            <div>
              <span>Approximate location</span>
              <strong>
                {/^[a-z]{2}$/i.test(countryCode) && (
                  <img
                    alt={countryCode.toUpperCase()}
                    src={withToken(`/api/flag/${countryCode.toLowerCase()}`)}
                    width="20"
                    height="15"
                  />
                )}
                {get("location.country", "country")}
              </strong>
              <small>{get("location.city", "city")}</small>
            </div>
          </div>
          <div className="ipi-field-search">
            <Search size={15} aria-hidden="true" />
            <Input
              aria-label={`Search ${name} fields`}
              placeholder="Find a field or value…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span>
              {visible.length} / {rows.length}
            </span>
          </div>
          <ScrollArea className="h-80" aria-label={`${name} complete fields`}>
            <dl className="ipi-fields">
              {visible.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {!visible.length && <p className="ipi-muted p-5">No matching fields.</p>}
          </ScrollArea>
          <details className="ipi-json">
            <summary>Original JSON · all fields</summary>
            <ScrollArea className="h-64">
              <pre>{JSON.stringify(result.data, null, 2)}</pre>
            </ScrollArea>
          </details>
        </>
      )}
    </article>
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
  return (
    <div className="ipi-workspace">
      <header className="ipi-hero">
        <div>
          <span className="ipi-kicker">
            <Globe2 size={14} />
            Public IP / intelligence
          </span>
          <h2>
            An IP.
            <br />
            <span>Two perspectives.</span>
          </h2>
          <p>
            Understand the network behind an address.
            <br />
            Compare its organization, location and risk — without losing a single field.
          </p>
        </div>
        <aside>
          <ShieldCheck size={24} />
          <strong>Information, not identity.</strong>
          <p>
            Provider claims are approximate. They do not prove a user's identity, a threat or your
            router's actual exit path.
          </p>
        </aside>
      </header>
      <form
        className="ipi-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && ip.trim()) void lookup();
        }}
      >
        <label htmlFor="ipi-address">
          IP address <span>IPv4 or IPv6</span>
        </label>
        <div>
          <Input
            id="ipi-address"
            placeholder="e.g. 1.1.1.1 or 2606:4700::1111"
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            value={ip}
            onChange={(event) => {
              setIp(event.target.value);
              generation.current++;
              setBusy(false);
              setResult(null);
              setError("");
              setCopyState("");
            }}
          />
          <Button type="submit" disabled={busy || !ip.trim()}>
            {busy ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
            {busy ? "Looking up…" : "Look up IP"}
          </Button>
        </div>
        <p>
          Only when you submit: public IPs are sent to ipquery and ipkit from the MCP host. Private
          addresses stay local. No router changes.
        </p>
      </form>
      {error && (
        <div className="ipi-error" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <div className="ipi-empty" role="status">
          <Loader2 className="animate-spin" size={28} />
          <h3>Gathering two independent perspectives</h3>
          <p>Each provider has an 8-second request deadline.</p>
        </div>
      )}
      {!busy && !result && !error && (
        <div className="ipi-empty">
          <Globe2 size={36} />
          <h3>Start with an address</h3>
          <p>Full provider responses. Searchable fields. Exportable evidence.</p>
          <div className="ipi-examples">
            {["1.1.1.1", "8.8.8.8", "2606:4700::1111"].map((value) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                key={value}
                onClick={() => setIp(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          <small>Examples fill the input; they do not send a request.</small>
        </div>
      )}
      {result && (
        <>
          <section className="ipi-result-head" aria-label="Lookup summary">
            <div>
              <span className="ipi-kicker">
                {result.public ? "Public address" : "Non-public address"} · IPv{result.version}
              </span>
              <h3>{result.ip}</h3>
              <p>
                {result.cached ? "Cached result" : "Fresh result"} ·{" "}
                {new Date(result.lookedUpAt).toLocaleString()} ·{" "}
                {
                  Object.values(result.providers).filter((provider) => provider.status === "ready")
                    .length
                }{" "}
                of 2 sources received
              </p>
              {result.public && (
                <small>
                  Cache valid until {new Date(result.expiresAt).toLocaleTimeString()}. Submit again
                  after expiry to refresh.
                </small>
              )}
            </div>
            <div>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                <Copy size={14} />
                Copy report
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  saveDownload(
                    `ip-${result.ip.replaceAll(":", "-")}.json`,
                    JSON.stringify(result, null, 2),
                    "application/json",
                  )
                }
              >
                <Download size={14} />
                Export JSON
              </Button>
              <span role="status">{copyState}</span>
            </div>
          </section>
          <div className="ipi-providers">
            <ProviderCard
              key={`${result.ip}-ipquery`}
              name="ipquery"
              result={result.providers.ipquery}
            />
            <ProviderCard key={`${result.ip}-ipkit`} name="ipkit" result={result.providers.ipkit} />
          </div>
          <p className="ipi-footnote">
            Sources can disagree; each response stays separate. All fields below come from the named
            provider and are untrusted reference data. False, zero and null values are preserved.
          </p>
        </>
      )}
    </div>
  );
}
