import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Plus, RefreshCw, Route } from "lucide-react";
import { ServiceProbesSettings } from "./service-probes-settings";
import { AddressSets } from "./address-sets";
import { ServiceProbePicker } from "./service-probe-picker";
import { RoutingDomainFields } from "./service-routing-domain-fields";
import { RoutingTrafficPanel } from "./service-routing-traffic";
import { IpNetwork } from "./ip-network";
import { api } from "./api";
import { routingDomain, isWildcard } from "../../src/service-routing/domain";
import type { RoutingPolicy } from "../../src/service-routing/model";
import {
  RouterRoutingInventory,
  useRoutingInventory,
  routeAvailable,
  policyBlockers,
} from "./service-routing-inventory";
import { useOperations } from "./operations-ui";
import {
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  RouterPicker,
  Segmented,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { CheckRow, FieldSelect, StatusLine, hhmm } from "./service-routing-ui";
import { cn } from "@/lib/utils";
import "./service-routing.css";

type Mode = "router" | "policies" | "sets";

const POLICY_STATE: Record<RoutingPolicy["state"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  draft: { label: "Draft", tone: "default" },
  removed: { label: "Removed", tone: "default" },
  uncertain: { label: "Uncertain", tone: "warn" },
};
const SAMPLE_STATE: Record<string, { label: string; tone: Tone }> = {
  pass: { label: "Pass", tone: "good" },
  fail: { label: "Fail", tone: "bad" },
  unknown: { label: "Unknown", tone: "warn" },
  untested: { label: "Untested", tone: "default" },
};

const LEAD: Record<Mode, string> = {
  router:
    "See where traffic leaves this router: routes, mangle marks and routing rules, in router order.",
  policies:
    "Send one service's traffic out a chosen exit, check that exit works, and switch only when you allow it.",
  sets: "Routes, policy rules and the address lists they use, plus the service exits MCP manages.",
};

/** The boards' `.note`: an icon, a message, and an optional action. */
function Note({
  tone,
  children,
  action,
}: {
  tone?: "warn" | "bad";
  children: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="monitor-note" data-tone={tone} role={tone === "bad" ? "alert" : "status"}>
      <AlertTriangle
        aria-hidden="true"
        className={tone === "bad" ? "text-destructive" : tone === "warn" ? "text-warning" : ""}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-fg-secondary">{children}</div>
      {action}
    </div>
  );
}

export function ServiceRoutingView() {
  const w = useOperations<{ policies: RoutingPolicy[] }>("/api/service-routing");
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [managingProbes, setManagingProbes] = useState(false);
  const [consent, setConsent] = useState(false);
  const [review, setReview] = useState(false);
  const [arming, setArming] = useState(false);
  const [view, setView] = useState<Mode>("router");
  const [addressBusy, setAddressBusy] = useState(false);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [defaultRouter, setDefaultRouter] = useState<string | null>(null);
  const routing = useRoutingInventory(
    w.device,
    w.busy || creating || review || arming || addressBusy,
  );
  const inventory = routing.data,
    inventoryError = routing.error;
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [domain, setDomain] = useState("");
  const [dnsConfirmed, setDnsConfirmed] = useState(false);
  const [beforeExisting, setBeforeExisting] = useState(false);
  const [family, setFamily] = useState("ipv4");
  const [sources, setSources] = useState("");
  const [tables, setTables] = useState<string[]>([]);
  const [primary, setPrimary] = useState("");
  const policies = w.data?.policies ?? [],
    policy = policies.find((p) => p.id === selected) ?? policies[0];
  const blockers = policy && inventory ? policyBlockers(inventory, policy) : [];
  const busyAny = w.busy || creating || review || arming || addressBusy;
  const changeDevice = (next: string) => {
    if (addressBusy) return;
    w.setDevice(next);
    setSelected("");
    setReview(false);
    setArming(false);
    setCreating(false);
    setView("router");
  };
  const { busy, refresh } = w;
  useEffect(() => {
    let stopped = false;
    void api<{ defaultDevice?: string }>("/api/devices")
      .then((r) => {
        if (!stopped) setDefaultRouter(r?.defaultDevice ?? null);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        !busy &&
        !creating &&
        !review &&
        !arming &&
        !addressBusy &&
        document.visibilityState === "visible"
      )
        void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [busy, refresh, creating, review, arming, addressBusy]);
  function openCreate() {
    setCreating(true);
    setName("");
    setTarget("");
    setDomain("");
    setDnsConfirmed(false);
    setBeforeExisting(false);
    setSources("");
    setTables([]);
    setPrimary("");
    setFamily("ipv4");
    if (!inventory && !routing.loading) void routing.refresh();
  }
  async function create() {
    const result = await w.action<RoutingPolicy>("", {
      name,
      target: target || undefined,
      domain: domain.trim() || undefined,
      dnsLearningConfirmed: dnsConfirmed,
      precedence: beforeExisting ? "before-existing" : undefined,
      family,
      sources: sources.split(/[\s,]+/).filter(Boolean),
      tables,
      primary,
    });
    if (result) {
      setCreating(false);
      setSelected(result.id);
      setView("policies");
    }
  }
  async function preview(table: string, remove = false) {
    if (!policy) return;
    const result = await w.action<RoutingPolicy>("/preview", { id: policy.id, table, remove });
    if (result) {
      setReview(true);
      setConsent(false);
    }
  }
  const latest = (table: string) => policy?.samples.filter((s) => s.table === table).at(-1);
  const armed = (p: RoutingPolicy) => (p.armedUntil ?? 0) > w.observedAt;

  // ── Header status line, per mode ────────────────────────────────────────
  let tone: Tone = "default";
  let status: ReactNode;
  if (view === "policies") {
    const count = (s: RoutingPolicy["state"]) => policies.filter((p) => p.state === s).length;
    const uncertain = count("uncertain");
    if (w.loading && !w.data) status = <StatusLine lead="Loading MCP policies" />;
    else {
      tone = uncertain ? "warn" : count("active") ? "good" : "default";
      status = (
        <StatusLine
          lead={`${policies.length} MCP ${policies.length === 1 ? "policy" : "policies"}`}
          rest={`${count("active")} active, ${count("draft")} draft${uncertain ? `, ${uncertain} uncertain` : ""} · automatic failover ${policies.some(armed) ? "on" : "off"}`}
        />
      );
    }
  } else if (!inventory) {
    tone = inventoryError ? "bad" : "default";
    status = (
      <StatusLine
        lead={inventoryError ? "Router configuration unavailable" : "Reading router configuration"}
        rest={inventoryError ? "nothing on the router changed" : undefined}
      />
    );
  } else if (view === "sets") {
    tone = "good";
    status = (
      <StatusLine
        lead="Configuration loaded"
        rest={`read ${hhmm(inventory.observedAt)} from ${inventory.device}`}
      />
    );
  } else {
    // The board keeps "Read-only snapshot" when some sections failed; the note below says which.
    // When none could be read there is no snapshot to speak of.
    const sections = Object.values(inventory.sections);
    const noneRead = sections.length > 0 && sections.every((s) => s.state !== "ready");
    tone = noneRead ? "bad" : inventoryError ? "warn" : "good";
    status = (
      <StatusLine
        lead={
          noneRead
            ? "Could not read the router"
            : inventoryError
              ? "Last read snapshot"
              : "Read-only snapshot"
        }
        rest={
          routing.loading
            ? "reading again now"
            : `read ${hhmm(inventory.observedAt)} · refreshes every 30 s`
        }
      />
    );
  }

  return (
    <section className="service-routing grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
      <PageIntro
        tone={tone}
        title={status}
        controls={
          <>
            <RouterPicker
              value={w.device}
              routers={w.devices}
              defaultRouter={defaultRouter}
              disabled={busyAny || !w.devices.length}
              onChange={changeDevice}
            />
            <MonitorButton
              size="sm"
              aria-label="Refresh"
              disabled={busyAny}
              icon={<RefreshCw />}
              onClick={() => {
                setInventoryRevision((n) => n + 1);
                void w.refresh();
                void routing.refresh();
              }}
            />
            <MonitorButton size="sm" disabled={w.busy} onClick={() => setManagingProbes(true)}>
              Service probes
            </MonitorButton>
            <MonitorButton
              size="sm"
              variant="inverse"
              icon={<Plus />}
              disabled={!w.device || w.busy}
              onClick={openCreate}
            >
              New policy
            </MonitorButton>
          </>
        }
      >
        {LEAD[view]}
      </PageIntro>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented<Mode>
          label="Mode"
          value={view}
          onChange={(next) => {
            if (!addressBusy) setView(next);
          }}
          options={[
            { value: "router", label: "Router configuration" },
            { value: "policies", label: `MCP policies (${policies.length})` },
            { value: "sets", label: "Address sets" },
          ]}
        />
        {view === "policies" && (
          <p className="text-[12px] text-muted-foreground">
            Only policies MCP created show here. A draft never changes the router until you review
            and apply it.
          </p>
        )}
      </div>

      {w.error && !creating && !review && !arming && (
        <Note tone="bad">
          <span>{w.error}</span>
        </Note>
      )}

      {view === "sets" ? (
        <AddressSets
          key={w.device}
          device={w.device}
          inventory={inventory}
          onBusy={setAddressBusy}
        />
      ) : view === "router" ? (
        <RouterRoutingInventory
          key={`${w.device}-${inventoryRevision}`}
          data={inventory}
          loading={routing.loading}
          error={inventoryError}
          onRetry={() => void routing.refresh()}
        />
      ) : w.loading && !w.data ? (
        <section className="monitor-panel">
          <MonitorEmpty icon={<Route />} title="Loading MCP policies" />
        </section>
      ) : !policies.length ? (
        <section className="monitor-panel">
          <MonitorEmpty
            icon={<Route />}
            title="No MCP policies for this router"
            action={
              <span className="flex flex-wrap justify-center gap-2">
                <MonitorButton
                  size="sm"
                  variant="inverse"
                  icon={<Plus />}
                  disabled={!w.device}
                  onClick={openCreate}
                >
                  New policy
                </MonitorButton>
                <MonitorButton size="sm" onClick={() => setManagingProbes(true)}>
                  Service probes
                </MonitorButton>
              </span>
            }
          >
            Your router can still have routes: see Router configuration. A policy reuses exits that
            already exist. It never creates a WAN, VPN or NAT.
          </MonitorEmpty>
        </section>
      ) : (
        policy && (
          <>
            <section className="monitor-panel flex-row flex-wrap overflow-hidden">
              <nav
                aria-label="Policies"
                className="sr-policy-list flex max-w-[300px] flex-[1_1_260px] flex-col border-r border-border"
              >
                <p className="monitor-label px-5 pt-4 pb-2">Policies</p>
                {policies.map((p) => {
                  const on = policy.id === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-current={on || undefined}
                      disabled={w.busy}
                      onClick={() => {
                        setSelected(p.id);
                        setReview(false);
                        setArming(false);
                      }}
                      className={cn(
                        "flex w-full flex-col gap-1 border-t border-border px-5 py-3 text-left transition-colors hover:bg-overlay-03 disabled:cursor-not-allowed",
                        on && "bg-accent shadow-[inset_2px_0_0_var(--chart-1)] hover:bg-accent",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
                          {p.name}
                        </span>
                        <StatusBadge tone={POLICY_STATE[p.state].tone}>
                          {POLICY_STATE[p.state].label}
                        </StatusBadge>
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">
                        {p.host} · {p.family === "ipv6" ? "IPv6" : "IPv4"}
                      </span>
                    </button>
                  );
                })}
              </nav>

              <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5 px-6 pt-5 pb-6 max-sm:px-4">
                <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                  <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="min-w-0 truncate font-mono text-[16px] font-medium text-emphasis">
                        {policy.name}
                      </h2>
                      <StatusBadge tone={POLICY_STATE[policy.state].tone}>
                        {POLICY_STATE[policy.state].label}
                      </StatusBadge>
                    </div>
                    <p className="text-[13px] break-words text-muted-foreground">
                      <span className="font-mono text-[12px] text-fg-secondary">{policy.host}</span>{" "}
                      · {policy.family === "ipv6" ? "IPv6" : "IPv4"} · from{" "}
                      {policy.sources.map((s, i) => (
                        <span key={s}>
                          {i > 0 && ", "}
                          <span className="font-mono text-[12px] text-fg-secondary">{s}</span>
                        </span>
                      ))}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <MonitorButton
                      size="sm"
                      disabled={w.busy || !policy.target}
                      onClick={() => void w.action("/probe", { id: policy.id })}
                    >
                      Check exits
                    </MonitorButton>
                    {armed(policy) ? (
                      <MonitorButton
                        size="sm"
                        disabled={w.busy}
                        onClick={() =>
                          void w.action("/arm", { id: policy.id, minutes: 0, confirm: true })
                        }
                      >
                        Pause automation
                      </MonitorButton>
                    ) : (
                      <MonitorButton
                        size="sm"
                        disabled={w.busy || policy.state !== "active" || !policy.target}
                        onClick={() => {
                          setArming(true);
                          setConsent(false);
                        }}
                      >
                        Authorize failover
                      </MonitorButton>
                    )}
                    {policy.state === "active" && (
                      <MonitorButton
                        size="sm"
                        variant="danger"
                        disabled={w.busy}
                        onClick={() => void preview(policy.activeTable!, true)}
                      >
                        Remove policy…
                      </MonitorButton>
                    )}
                  </div>
                </div>

                {blockers.length > 0 && (
                  <Note
                    tone="warn"
                    action={
                      <MonitorButton size="sm" onClick={() => setView("router")}>
                        Open router configuration
                      </MonitorButton>
                    }
                  >
                    <span className="font-[510] text-foreground">
                      Review needed before you apply
                    </span>
                    {blockers.map((reason) => (
                      <span key={reason} className="text-[12px] text-muted-foreground">
                        {reason}
                      </span>
                    ))}
                  </Note>
                )}
                {policy.error && (
                  <Note tone="bad">
                    <span>{policy.error}</span>
                  </Note>
                )}

                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-3">
                  {policy.tables.map((table) => {
                    const sample = latest(table);
                    const ev = SAMPLE_STATE[sample?.state ?? "untested"];
                    const current = policy.activeTable === table;
                    return (
                      <div
                        key={table}
                        className="flex min-w-0 flex-col gap-2.5 rounded-lg bg-overlay-02 p-4"
                        style={{
                          boxShadow: `inset 0 0 0 1px var(${current ? "--input" : "--border"})`,
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="flex-1 text-[12px] font-[510] text-muted-foreground">
                            {table === policy.primary ? "Primary exit" : "Approved fallback"}
                            {current ? " · Current" : ""}
                          </span>
                          <StatusBadge tone={ev.tone}>{ev.label}</StatusBadge>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-fg-secondary">
                          <span className="font-mono text-[12px]">{w.device}</span>
                          <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground" />
                          <span>Client traffic</span>
                          <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground" />
                          <span className="font-mono text-[12px] text-foreground">{table}</span>
                        </div>
                        <p className="text-[12px] text-fg-secondary">
                          {sample?.detail ??
                            (policy.target
                              ? "Not checked yet. Use Check exits to test it before you allow failover."
                              : "Manual route with no service probe. It doesn't need one.")}
                        </p>
                        <div className="flex items-center gap-2">
                          <span className="flex-1 text-[12px] text-muted-foreground">
                            Last read {sample ? hhmm(sample.at) : "—"}
                          </span>
                          <MonitorButton
                            size="sm"
                            disabled={w.busy || policy.state === "uncertain" || blockers.length > 0}
                            onClick={() => void preview(table)}
                          >
                            {current ? "Preview current route" : `Preview route via ${table}`}
                          </MonitorButton>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-col gap-1.5 border-t border-border pt-4 text-[13px] text-fg-secondary">
                  <span className="flex items-center gap-2">
                    <StatusDot tone={armed(policy) ? "good" : "default"} />
                    {armed(policy)
                      ? `Automatic failover on until ${hhmm(policy.armedUntil)}`
                      : "Automatic failover off"}{" "}
                    · switches after {policy.failuresBeforeSwitch} failures ·{" "}
                    {policy.cooldownSeconds} s cooldown
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    Domains resolve on the router. CDNs change addresses often, so a few connections
                    may still leave through the main table.
                  </span>
                </div>
              </div>
            </section>

            <div className="flex flex-wrap gap-6">
              <RoutingTrafficPanel
                key={`${policy.device}:${policy.id}:${policy.state}:${policy.activeTable}:${policy.lastSwitchAt}`}
                policy={policy}
                paused={w.busy || creating || review || arming || managingProbes}
              />
              <MonitorPanel
                className="flex-[1_1_300px]"
                title="Decision history"
                description="What MCP did with this policy, newest first."
                flush
              >
                {policy.history.length ? (
                  <ol className="max-h-[360px] overflow-y-auto">
                    {[...policy.history]
                      .sort((a, b) => b.at - a.at)
                      .map((h, i) => (
                        <li
                          key={`${h.at}-${i}`}
                          className="monitor-row grid-cols-[44px_minmax(0,1fr)] items-start hover:bg-transparent"
                        >
                          <time
                            className="font-mono text-[12px] text-muted-foreground"
                            dateTime={new Date(h.at).toISOString()}
                            title={new Date(h.at).toLocaleString()}
                          >
                            {hhmm(h.at)}
                          </time>
                          <span className="text-fg-secondary">{h.message}</span>
                        </li>
                      ))}
                  </ol>
                ) : (
                  <MonitorEmpty compact title="Nothing decided yet" />
                )}
              </MonitorPanel>
            </div>
          </>
        )
      )}

      <MonitorDialog
        open={creating && !managingProbes}
        onOpenChange={(v) => {
          if (!w.busy) setCreating(v);
        }}
        dismissible={false}
        width={680}
        title="New service route"
        description={`For ${w.device}. Saved as a draft: nothing changes until you review and apply it.`}
        footer={
          <>
            <span className="flex-1 text-[12px] text-muted-foreground">
              Draft only · not applied
            </span>
            <MonitorButton
              size="sm"
              variant="ghost"
              disabled={w.busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </MonitorButton>
            <MonitorButton
              size="sm"
              variant="inverse"
              disabled={
                w.busy ||
                !name.trim() ||
                (!target && !domain.trim()) ||
                (!!domain.trim() && !routingDomain.safeParse(domain).success) ||
                (isWildcard(domain.trim()) && !dnsConfirmed) ||
                !sources.trim() ||
                !primary ||
                !inventory ||
                !tables.every((t) => routeAvailable(inventory, t, family))
              }
              onClick={() => void create()}
            >
              {w.busy ? "Saving…" : "Save draft"}
            </MonitorButton>
          </>
        }
      >
        <div className="monitor-dialog-body grid gap-4">
          <div className="grid grid-cols-[minmax(0,1fr)_160px] gap-3 max-sm:grid-cols-1">
            <label className="monitor-fl">
              <span className="monitor-label">Policy name</span>
              <input
                className="monitor-input font-mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="stream-via-vpn"
              />
            </label>
            <div className="monitor-fl">
              <span className="monitor-label">IP family</span>
              <FieldSelect
                label="IP family"
                value={family}
                onChange={(next) => {
                  setFamily(next);
                  setTables([]);
                  setPrimary("");
                }}
                options={[
                  { value: "ipv4", label: "IPv4" },
                  { value: "ipv6", label: "IPv6" },
                ]}
              />
            </div>
          </div>
          <RoutingDomainFields
            domain={domain}
            onDomain={(value) => {
              setDomain(value);
              setDnsConfirmed(false);
            }}
            dnsConfirmed={dnsConfirmed}
            onDnsConfirmed={setDnsConfirmed}
            primary={primary}
          />
          <ServiceProbePicker
            device={w.device}
            value={target}
            onChange={setTarget}
            onManage={() => setManagingProbes(true)}
            optional
          />
          <div className="monitor-fl">
            <label className="monitor-label" htmlFor="sr-client-subnets">
              Client subnets
            </label>
            <input
              id="sr-client-subnets"
              className="monitor-input font-mono text-fg-secondary"
              value={sources}
              onChange={(e) => setSources(e.target.value)}
              placeholder={family === "ipv4" ? "192.168.88.0/24, 10.10.0.0/24" : "fd00:10::/64"}
            />
            {sources.trim() !== "" && (
              <div className="flex flex-wrap gap-1.5">
                {/* Keep the preview within the policy schema's eight-source limit. */}
                {[...new Set(sources.split(/[\s,]+/).filter(Boolean))]
                  .slice(0, 8)
                  .map((address) => (
                    <span key={address} className="monitor-chip sr-net max-w-full">
                      <span className="font-mono text-[12px] text-fg-secondary">{address}</span>
                      <span className="text-muted-foreground">·</span>
                      <IpNetwork address={address} />
                    </span>
                  ))}
              </div>
            )}
            <span className="monitor-hint">
              Separate with commas. Up to 8 subnets. No default routes; the other IP family stays as
              it is.
            </span>
          </div>
          <CheckRow checked={beforeExisting} onChange={setBeforeExisting}>
            <span>Place this route before existing routing rules</span>
            <span className="text-[12px] text-muted-foreground">
              Use it when an older rule would catch this traffic first. FastTrack stays blocked.
            </span>
          </CheckRow>
          <fieldset className="monitor-fl m-0 min-w-0 border-0 p-0">
            <legend className="monitor-label mb-1.5 p-0">
              Allowed exits <span className="font-normal">· pick up to 3</span>
            </legend>
            {!inventory ? (
              <span className="monitor-hint">
                {routing.loading
                  ? "Reading router exits…"
                  : "Router exits are unavailable. Close this dialog and read the router again."}
              </span>
            ) : inventory.sections.tables.state === "error" ? (
              <span className="monitor-err" role="alert">
                {inventory.sections.tables.error ?? "Routing tables could not be read."}
              </span>
            ) : !inventory.tables.length ? (
              <span className="monitor-hint">This router reported no enabled FIB tables.</span>
            ) : (
              <div className="flex flex-col overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--input)]">
                {inventory.tables.map((t, i) => {
                  const available = routeAvailable(inventory, t, family);
                  const disabled = !available || (!tables.includes(t) && tables.length >= 3);
                  return (
                    <CheckRow
                      key={t}
                      className={cn("flex px-3 py-2.5", i > 0 && "border-t border-border")}
                      checked={tables.includes(t)}
                      disabled={disabled}
                      onChange={(checked) => {
                        const next = checked ? [...tables, t] : tables.filter((v) => v !== t);
                        setTables(next);
                        if (!next.includes(primary)) setPrimary(next[0] ?? "");
                      }}
                    >
                      <span className="font-mono text-[12px] text-foreground">{t}</span>
                      <span className="text-[12px] text-muted-foreground">
                        {!available
                          ? inventory.sections[family === "ipv6" ? "routes6" : "routes4"].state ===
                            "error"
                            ? "Route state unknown: the routes could not be read"
                            : `No active ${family === "ipv6" ? "IPv6" : "IPv4"} default route`
                          : inventory.sections.vrfs.rows.some(
                                (v) => v.name === t && v.disabled !== "yes",
                              )
                            ? "Active default route · exit checks supported"
                            : "Active default route · manual only, exit checks need a VRF"}
                      </span>
                    </CheckRow>
                  );
                })}
              </div>
            )}
          </fieldset>
          <div className="monitor-fl max-w-[320px]">
            <span className="monitor-label">Primary exit</span>
            <FieldSelect
              label="Primary exit"
              mono
              value={primary}
              onChange={setPrimary}
              placeholder="Choose an allowed exit"
              options={tables.map((t) => ({ value: t, label: t }))}
            />
            <span className="monitor-hint">
              The other checked exit becomes the approved fallback.
            </span>
          </div>
          {(inventoryError || w.error) && (
            <Note tone="bad">
              <span>{inventoryError || w.error}</span>
            </Note>
          )}
        </div>
      </MonitorDialog>

      {managingProbes && (
        <ServiceProbesSettings
          onClose={() => {
            setManagingProbes(false);
          }}
          onReload={() => {}}
        />
      )}

      <MonitorDialog
        open={review && !!policy?.plan}
        onOpenChange={(v) => {
          if (!w.busy) setReview(v);
        }}
        width={680}
        title={policy?.plan?.remove ? "Review policy removal" : "Review routing change"}
        description="Only this router and the listed client subnets change. Open connections may drop."
        footer={
          <>
            <span className="flex-1 text-[12px] text-muted-foreground">
              {policy?.plan ? `Plan expires ${hhmm(policy.plan.expiresAt)}` : ""}
            </span>
            <MonitorButton
              size="sm"
              variant="ghost"
              disabled={w.busy}
              onClick={() => setReview(false)}
            >
              Cancel
            </MonitorButton>
            <MonitorButton
              size="sm"
              variant={policy?.plan?.remove ? "danger" : "inverse"}
              disabled={w.busy || !consent}
              onClick={() => {
                if (policy?.plan)
                  void w
                    .action("/apply", { id: policy.id, planId: policy.plan.id, confirm: true })
                    .then((r) => {
                      if (r) setReview(false);
                    });
              }}
            >
              {w.busy ? "Applying and checking…" : "Apply reviewed change"}
            </MonitorButton>
          </>
        }
      >
        <div className="monitor-dialog-body grid gap-4">
          {policy?.plan?.warnings?.map((warning) => (
            <Note key={warning} tone="warn">
              <span>{warning}</span>
            </Note>
          ))}
          <pre className="monitor-pre max-h-[45vh] overflow-auto">
            {policy?.plan?.commands.join("\n")}
          </pre>
          <CheckRow checked={consent} onChange={setConsent}>
            I reviewed the scope, the shared-IP risk and these commands. Apply this exact preview
            with a backup and Safe Mode.
          </CheckRow>
          {w.error && (
            <Note tone="bad">
              <span>{w.error}</span>
            </Note>
          )}
        </div>
      </MonitorDialog>

      <MonitorDialog
        open={arming}
        onOpenChange={(v) => {
          if (!w.busy) setArming(v);
        }}
        title="Authorize failover for 30 minutes?"
        description="MCP may switch to a saved exit only after repeated confirmed failures."
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton
              size="sm"
              variant="ghost"
              disabled={w.busy}
              onClick={() => setArming(false)}
            >
              Cancel
            </MonitorButton>
            <MonitorButton
              size="sm"
              variant="inverse"
              disabled={!consent || w.busy}
              onClick={() => {
                if (policy)
                  void w.action("/arm", { id: policy.id, minutes: 30, confirm: true }).then((r) => {
                    if (r) setArming(false);
                  });
              }}
            >
              Authorize for 30 minutes
            </MonitorButton>
          </>
        }
      >
        <div className="monitor-dialog-body grid gap-4">
          <p className="text-[13px] text-fg-secondary">
            An unknown result never triggers a switch. When the 30 minutes run out, automation stops
            and the current route stays.
          </p>
          <CheckRow checked={consent} onChange={setConsent}>
            I allow these automatic router changes for this policy.
          </CheckRow>
          {w.error && (
            <Note tone="bad">
              <span>{w.error}</span>
            </Note>
          )}
        </div>
      </MonitorDialog>
    </section>
  );
}
