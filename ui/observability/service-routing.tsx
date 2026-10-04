import { useEffect, useState } from "react";
import { ArrowRight, Network, Plus, Play, ShieldCheck, Pause, Route, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { ServiceProbesSettings } from "./service-probes-settings";
import { ServiceProbePicker } from "./service-probe-picker";
import { RoutingDomainFields } from "./service-routing-domain-fields";
import { RoutingTrafficPanel } from "./service-routing-traffic";
import { routingDomain, isWildcard } from "../../src/service-routing/domain";
import type { RoutingPolicy } from "../../src/service-routing/model";
import {
  RouterRoutingInventory,
  useRoutingInventory,
  routeAvailable,
  policyBlockers,
} from "./service-routing-inventory";
import {
  useOperations,
  WorkspaceHeader,
  WorkspaceError,
  WorkspaceSafety,
  EvidenceState,
} from "./operations-ui";

export function ServiceRoutingView() {
  const w = useOperations<{ policies: RoutingPolicy[] }>("/api/service-routing");
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [managingProbes, setManagingProbes] = useState(false);
  const [consent, setConsent] = useState(false);
  const [review, setReview] = useState(false);
  const [arming, setArming] = useState(false);
  const [view, setView] = useState<"router" | "policies">("router");
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const routing = useRoutingInventory(w.device, w.busy || creating || review || arming);
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
  const changeDevice = (next: string) => {
    w.setDevice(next);
    setSelected("");
    setReview(false);
    setArming(false);
    setCreating(false);
    setView("router");
  };
  const { busy, refresh } = w;
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busy && !creating && !review && !arming && document.visibilityState === "visible")
        void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [busy, refresh, creating, review, arming]);
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
  return (
    <section className="ops-workspace">
      <WorkspaceHeader
        eyebrow="Service routing / router configuration"
        title="See where your traffic goes."
        description="Inspect existing routes and routing rules on this router. Use MCP policies separately to plan a service-specific change."
        device={w.device}
        devices={w.devices}
        onDevice={changeDevice}
        busy={w.busy || creating || review || arming}
        onRefresh={() => {
          setInventoryRevision((n) => n + 1);
          void w.refresh();
          void routing.refresh();
        }}
      >
        <Button variant="outline" disabled={w.busy} onClick={() => setManagingProbes(true)}>
          <ShieldCheck size={16} />
          Service probes
        </Button>
        <Button disabled={!w.device || w.busy} onClick={openCreate}>
          <Plus size={16} />
          New MCP policy
        </Button>
      </WorkspaceHeader>
      <WorkspaceError message={w.error} />
      <nav className="routing-mode" aria-label="Service routing workspace">
        <Button
          variant={view === "router" ? "secondary" : "ghost"}
          aria-pressed={view === "router"}
          onClick={() => setView("router")}
        >
          <Network size={16} />
          Router configuration
        </Button>
        <Button
          variant={view === "policies" ? "secondary" : "ghost"}
          aria-pressed={view === "policies"}
          onClick={() => setView("policies")}
        >
          <Route size={16} />
          MCP policies ({policies.length})
        </Button>
      </nav>
      {view === "router" ? (
        <RouterRoutingInventory
          key={`${w.device}-${inventoryRevision}`}
          data={inventory}
          loading={routing.loading}
          error={inventoryError}
          onRetry={() => void routing.refresh()}
        />
      ) : (
        <>
          <WorkspaceSafety>
            Only policies created in MCP appear here. Existing router rules remain in Router
            configuration. Drafts never change a router; apply requires a preview, backup and Safe
            Mode.
          </WorkspaceSafety>
          {w.loading && !w.data ? (
            <div className="ops-empty" role="status">
              Loading saved policies…
            </div>
          ) : !policies.length ? (
            <div className="ops-empty">
              <Network size={38} />
              <h3>No MCP policies saved for this router</h3>
              <p>
                This does not mean your router has no routes. Inspect Router configuration for
                existing rules.
                <br />
                Existing exits are reused; no WAN, VPN or NAT is created.
              </p>
              <Button disabled={!w.device} onClick={openCreate}>
                Create your first policy
              </Button>
              <Button variant="outline" onClick={() => setManagingProbes(true)}>
                Manage service probes
              </Button>
            </div>
          ) : (
            <div className="ops-split">
              <nav aria-label="Service policies" className="ops-list">
                {policies.map((p) => (
                  <button
                    key={p.id}
                    className="ops-list-item"
                    aria-pressed={policy?.id === p.id}
                    onClick={() => {
                      setSelected(p.id);
                      setReview(false);
                      setArming(false);
                    }}
                    disabled={w.busy}
                  >
                    <strong>{p.name}</strong>
                    <small>
                      {p.host} · {p.family.toUpperCase()}
                    </small>
                    <EvidenceState state={p.state} />
                  </button>
                ))}
              </nav>
              {policy && (
                <div className="grid gap-5">
                  <section className="ops-panel">
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <h3>{policy.name}</h3>
                        <p className="ops-meta mt-2">
                          {policy.host} · {policy.family.toUpperCase()} ·{" "}
                          {policy.sources.join(", ")}
                        </p>
                      </div>
                      <EvidenceState state={policy.state} />
                    </div>
                    {blockers.length > 0 && (
                      <div className="routing-warning">
                        <ShieldCheck size={16} />
                        <div>
                          <strong>Review required before applying</strong>
                          {blockers.map((reason) => (
                            <p key={reason}>{reason}</p>
                          ))}
                          <Button variant="link" onClick={() => setView("router")}>
                            Inspect router configuration
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="ops-lanes">
                      {policy.tables.map((table) => {
                        const sample = latest(table);
                        return (
                          <div
                            className="ops-lane"
                            key={table}
                            data-active={policy.activeTable === table}
                          >
                            <div className="ops-lane-name">
                              <span>{w.device}</span>
                              <small className="ops-meta">Client traffic</small>
                            </div>
                            <ArrowRight size={20} />
                            <div className="ops-lane-name">
                              <strong>{table}</strong>
                              <span className="ops-meta">
                                {table === policy.primary ? "Primary exit" : "Approved fallback"}
                                {policy.activeTable === table ? " · Current" : ""}
                              </span>
                            </div>
                            <EvidenceState state={sample?.state ?? "untested"} />
                            <p className="ops-lane-detail">
                              {sample?.detail ??
                                (policy.target
                                  ? "Run path checks to collect evidence. Only a matching VRF can prove an HTTPS exit."
                                  : "Manual domain route. No active health probe configured; the route does not need one.")}
                              {sample && ` Last read ${new Date(sample.at).toLocaleTimeString()}.`}
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="col-span-full justify-self-end"
                              disabled={
                                w.busy || policy.state === "uncertain" || blockers.length > 0
                              }
                              onClick={() => void preview(table)}
                            >
                              <Route size={14} />
                              Preview{" "}
                              {policy.activeTable === table
                                ? "current route"
                                : `route via ${table}`}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                    <div className="ops-actions">
                      <Button
                        variant="outline"
                        disabled={w.busy || !policy.target}
                        onClick={() => void w.action("/probe", { id: policy.id })}
                      >
                        <Play size={15} />
                        Check exits
                      </Button>
                      {(policy.armedUntil ?? 0) > w.observedAt ? (
                        <Button
                          variant="outline"
                          disabled={w.busy}
                          onClick={() =>
                            void w.action("/arm", { id: policy.id, minutes: 0, confirm: true })
                          }
                        >
                          <Pause size={15} />
                          Pause automation
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={w.busy || policy.state !== "active" || !policy.target}
                          onClick={() => {
                            setArming(true);
                            setConsent(false);
                          }}
                        >
                          <ShieldCheck size={15} />
                          Authorize failover
                        </Button>
                      )}
                      {policy.state === "active" && (
                        <Button
                          variant="ghost"
                          disabled={w.busy}
                          onClick={() => void preview(policy.activeTable!, true)}
                        >
                          <Trash2 size={15} />
                          Remove policy…
                        </Button>
                      )}
                    </div>
                    <p className="ops-meta">
                      {(policy.armedUntil ?? 0) > w.observedAt
                        ? `Automatic failover authorized until ${new Date(policy.armedUntil!).toLocaleTimeString()}`
                        : "Automatic failover paused"}{" "}
                      · {policy.failuresBeforeSwitch} consecutive failures ·{" "}
                      {policy.cooldownSeconds}s cooldown
                    </p>
                    {policy.error && <WorkspaceError message={policy.error} />}
                    <p className="ops-meta">
                      DNS lists follow router DNS answers. Shared CDN addresses can route other
                      services too. DoH and client-path differences are not covered by this check.
                    </p>
                  </section>
                  <RoutingTrafficPanel
                    key={`${policy.device}:${policy.id}:${policy.state}:${policy.activeTable}:${policy.lastSwitchAt}`}
                    policy={policy}
                    paused={w.busy || creating || review || arming || managingProbes}
                  />
                  <section className="ops-panel">
                    <h3>Decision history</h3>
                    <ScrollArea className="max-h-64">
                      <ol className="ops-history">
                        {policy.history.map((h, i) => (
                          <li key={`${h.at}-${i}`}>
                            <time>{new Date(h.at).toLocaleString()}</time>
                            {h.message}
                          </li>
                        ))}
                      </ol>
                    </ScrollArea>
                  </section>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <Dialog
        open={creating && !managingProbes}
        onOpenChange={(v) => {
          if (!w.busy) setCreating(v);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Define a service route</DialogTitle>
            <DialogDescription>
              Save a draft first. Choose approved exits and an explicit client scope.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <div className="ops-form">
              <label className="ops-field">
                Policy name
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Google · household IPv4"
                />
              </label>
              <div className="ops-field">
                <span>IP family</span>
                <Select
                  value={family}
                  onValueChange={(next) => {
                    setFamily(next);
                    setTables([]);
                    setPrimary("");
                  }}
                >
                  <SelectTrigger aria-label="IP family">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ipv4">IPv4</SelectItem>
                    <SelectItem value="ipv6">IPv6</SelectItem>
                  </SelectContent>
                </Select>
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
              <label className="ops-field ops-field--wide">
                Client subnets
                <Input
                  value={sources}
                  onChange={(e) => setSources(e.target.value)}
                  placeholder={family === "ipv4" ? "10.10.10.0/24" : "fd00:10::/64"}
                />
                <small>
                  Comma-separated CIDRs. Default routes are not allowed. The other IP family is
                  unchanged.
                </small>
              </label>
              <label className="ops-check ops-field--wide">
                <Checkbox
                  checked={beforeExisting}
                  onCheckedChange={(v) => setBeforeExisting(v === true)}
                />
                <span>
                  Place this scoped route before existing routing rules.
                  <small className="block ops-meta">
                    Choose only after inspecting existing rules. The exact preview requires another
                    confirmation; FastTrack remains blocked.
                  </small>
                </span>
              </label>
              <fieldset className="ops-field ops-field--wide">
                <legend className="mb-3">Allowed exits · up to three</legend>
                {!inventory && (
                  <p>
                    {routing.loading
                      ? "Reading router exits…"
                      : "Router exits are unavailable. Close this dialog and retry the router read."}
                  </p>
                )}
                {inventory?.sections.tables.state === "error" && (
                  <WorkspaceError
                    message={inventory.sections.tables.error ?? "Routing tables could not be read."}
                  />
                )}
                {inventory &&
                  inventory.sections.tables.state === "ready" &&
                  !inventory.tables.length && (
                    <p>No enabled FIB tables were reported by this router.</p>
                  )}
                {inventory?.tables.map((t) => (
                  <label className="ops-check" key={t}>
                    <Checkbox
                      checked={tables.includes(t)}
                      disabled={
                        !routeAvailable(inventory, t, family) ||
                        (!tables.includes(t) && tables.length >= 3)
                      }
                      onCheckedChange={(checked) => {
                        const next = checked ? [...tables, t] : tables.filter((v) => v !== t);
                        setTables(next);
                        if (!next.includes(primary)) setPrimary(next[0] ?? "");
                      }}
                    />
                    {t}
                    <small>
                      {!routeAvailable(inventory, t, family)
                        ? inventory.sections[family === "ipv6" ? "routes6" : "routes4"].state ===
                          "error"
                          ? "Route availability unknown"
                          : `No active ${family.toUpperCase()} default route`
                        : inventory.sections.vrfs.rows.some(
                              (v) => v.name === t && v.disabled !== "yes",
                            )
                          ? "Active default · VRF probe supported"
                          : "Active default · manual routing only; HTTPS probe needs a VRF"}
                    </small>
                  </label>
                ))}
              </fieldset>
              <div className="ops-field ops-field--wide">
                <span>Primary exit</span>
                <Select value={primary} onValueChange={setPrimary}>
                  <SelectTrigger aria-label="Primary exit">
                    <SelectValue placeholder="Choose an allowed exit" />
                  </SelectTrigger>
                  <SelectContent>
                    {tables.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <WorkspaceError message={inventoryError || w.error} />
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" disabled={w.busy} onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
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
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {managingProbes && (
        <ServiceProbesSettings
          onClose={() => {
            setManagingProbes(false);
          }}
          onReload={() => {}}
        />
      )}
      <Dialog
        open={review && !!policy?.plan}
        onOpenChange={(v) => {
          if (!w.busy) setReview(v);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {policy?.plan?.remove ? "Review policy removal" : "Review routing change"}
            </DialogTitle>
            <DialogDescription>
              Only this router and the listed client scope are targeted. Existing connections may be
              interrupted.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[45vh]">
            {policy?.plan?.warnings?.map((warning) => (
              <p key={warning} className="routing-warning">
                {warning}
              </p>
            ))}
            <pre className="ops-code">{policy?.plan?.commands.join("\n")}</pre>
          </ScrollArea>
          <label className="ops-check">
            <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} />I reviewed
            the scope, shared-IP risk and commands. Apply this exact preview with backup and Safe
            Mode.
          </label>
          <WorkspaceError message={w.error} />
          <DialogFooter>
            <Button variant="outline" disabled={w.busy} onClick={() => setReview(false)}>
              Cancel
            </Button>
            <Button
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
              {w.busy ? "Applying & verifying…" : "Apply reviewed change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={arming}
        onOpenChange={(v) => {
          if (!w.busy) setArming(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Authorize failover for 30 minutes?</DialogTitle>
            <DialogDescription>
              Only the saved exits may be selected after repeated confirmed failures. UNKNOWN never
              triggers a switch. Expiry stops automation; it does not remove the current route.
            </DialogDescription>
          </DialogHeader>
          <label className="ops-check">
            <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} />I
            authorize these automatic router changes for this policy.
          </label>
          <WorkspaceError message={w.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setArming(false)} disabled={w.busy}>
              Cancel
            </Button>
            <Button
              disabled={!consent || w.busy}
              onClick={() => {
                if (policy)
                  void w.action("/arm", { id: policy.id, minutes: 30, confirm: true }).then((r) => {
                    if (r) setArming(false);
                  });
              }}
            >
              Authorize for 30 minutes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
