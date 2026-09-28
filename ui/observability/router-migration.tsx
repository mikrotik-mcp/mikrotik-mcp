import { useCallback, useEffect, useState } from "react";
import { ArrowRight, ArrowLeftRight, Download, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import { api } from "./api";
import { Button, Select } from "./geist";
import { Checkbox } from "./components/ui/checkbox";
import { UnifiedDiff } from "./diff-view";
import {
  WorkspaceFrame,
  Notice,
  Steps,
  workspaceCard,
  workspaceNote,
  workspacePost,
  saveDownload,
  ConfirmWorkspaceAction,
  useWorkspaceClock,
} from "./workspace-ui";
import { MIGRATION_SECTIONS } from "../../src/migration/sections";
import type { MigrationPlan, MigrationSection, RouterInventory } from "../../src/migration/model";

type Inventory = Omit<RouterInventory, "export">;
export function RouterMigrationView() {
  return (
    <WorkspaceFrame
      title="A new router. A deliberate handover."
      description="Map the physical ports, resolve compatibility issues and rehearse the transfer before preparing inactive configuration on your replacement router."
      eyebrow="ROUTER MIGRATION / GUARDED STAGING"
    >
      {(target, devices) => <Migration key={target} target={target} devices={devices} />}
    </WorkspaceFrame>
  );
}
function Migration({ target, devices }: { target: string; devices: string[] }) {
  const now = useWorkspaceClock();
  const [source, setSource] = useState(devices.find((d) => d !== target) ?? ""),
    [inventory, setInventory] = useState<{ source: Inventory; target: Inventory } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({}),
    [management, setManagement] = useState("");
  const [sections, setSections] = useState<MigrationSection[]>([
    "/interface/bridge",
    "/interface/bridge/port",
    "/ip/pool",
    "/ip/address",
    "/ip/dhcp-server/network",
    "/ip/dhcp-server",
  ]);
  const [plans, setPlans] = useState<MigrationPlan[]>([]),
    [plan, setPlan] = useState<MigrationPlan | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false),
    [manual, setManual] = useState(false);
  const load = useCallback(async () => {
    setPlans(await api<MigrationPlan[]>(`/api/migrations?device=${encodeURIComponent(target)}`));
  }, [target]);
  useEffect(() => {
    const abort = new AbortController();
    api<MigrationPlan[]>(`/api/migrations?device=${encodeURIComponent(target)}`, abort.signal)
      .then(setPlans)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [target]);
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
  async function inspect() {
    const a = await api<Inventory>(
        `/api/migrations/inventory?device=${encodeURIComponent(source)}`,
      ),
      b = await api<Inventory>(`/api/migrations/inventory?device=${encodeURIComponent(target)}`);
    setInventory({ source: a, target: b });
    setMapping({});
    setManagement("");
    setPlan(null);
    setConfirm(false);
  }
  async function preview() {
    const p = await workspacePost<MigrationPlan>("/api/migrations/preview", target, {
      source,
      target,
      managementInterface: management,
      mapping,
      sections,
    });
    setPlan(p);
    setConfirm(false);
    setManual(false);
    await load();
  }
  async function apply(mode: "rehearse" | "stage") {
    if (!plan) return;
    try {
      setPlan(
        await workspacePost<MigrationPlan>("/api/migrations/apply", target, {
          id: plan.id,
          mode,
          confirm,
          acknowledgeManual: manual,
        }),
      );
    } finally {
      setConfirm(false);
      await load();
    }
  }
  const edit = () => {
    setPlan(null);
    setConfirm(false);
    setManual(false);
  };
  const canApply =
    !!plan &&
    plan.status === "preview" &&
    !plan.blockers.length &&
    plan.expiresAt > now &&
    confirm &&
    (!plan.manual.length || manual) &&
    !busy;
  return (
    <div className="grid gap-5">
      <Steps
        labels={["Inspect & map", "Review exact plan", "Rehearse / stage", "Manual cutover"]}
        active={plan?.status === "staged" ? 3 : plan ? 2 : inventory ? 1 : 0}
      />
      {error && <Notice error>{error}</Notice>}
      <section className={workspaceCard}>
        <div className="grid items-center gap-5 md:grid-cols-[1fr_auto_1fr_auto]">
          <div className="grid gap-2 text-xs">
            <span>Source · read only</span>
            <Select
              aria-label="Source router"
              value={source}
              onValueChange={(v) => {
                setSource(v);
                setInventory(null);
                edit();
              }}
              options={devices.filter((d) => d !== target).map((d) => ({ value: d, label: d }))}
            />
          </div>
          <ArrowRight className="hidden text-brand md:block" />
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Replacement target</p>
            <strong className="font-mono">{target}</strong>
          </div>
          <Button
            disabled={busy || !source}
            icon={<RefreshCw size={14} />}
            onClick={() => void work(inspect)}
          >
            {busy ? "Working…" : "Inspect both routers"}
          </Button>
        </div>
        <p className={`mt-4 ${workspaceNote}`}>
          Inspection reads hardware, interfaces, packages and hidden-secret exports. No router
          changes. Choose the replacement as the workspace router above.
        </p>
      </section>
      {inventory && (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,.8fr)]">
          <section className={`${workspaceCard} grid gap-5`}>
            <div className="flex items-center gap-2">
              <ArrowLeftRight size={18} className="text-brand" />
              <h3 className="font-semibold">Port mapping</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {[inventory.source, inventory.target].map((r, i) => (
                <div key={i} className="rounded-xl border border-border bg-background p-4">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {i ? "Target" : "Source"}
                  </p>
                  <h4 className="mt-2 text-sm font-semibold">{r.model}</h4>
                  <p className={`mt-1 ${workspaceNote}`}>
                    RouterOS {r.version} · {r.architecture}
                  </p>
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Installed packages</summary>
                    <p className="mt-2 break-words font-mono">{r.packages.join(", ")}</p>
                  </details>
                </div>
              ))}
            </div>
            <label className="grid gap-2 text-xs">
              Protected target management port
              <Select
                aria-label="Protected management interface"
                value={management}
                onValueChange={(v) => {
                  setManagement(v);
                  edit();
                }}
                options={[
                  { value: "", label: "Choose a dedicated management interface" },
                  ...inventory.target.interfaces
                    .filter((i) => i.type === "ether")
                    .map((i) => ({ value: i.name, label: i.name })),
                ]}
              />
              <span className={workspaceNote}>
                This interface must stay outside the transfer. Use an independent management
                connection throughout.
              </span>
            </label>
            <div className="grid gap-3">
              {inventory.source.interfaces
                .filter((i) => i.type === "ether")
                .map((i) => (
                  <div
                    key={i.name}
                    className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border bg-background p-3"
                  >
                    <span className="truncate font-mono text-xs">{i.name}</span>
                    <ArrowRight size={14} className="text-brand" />
                    <Select
                      aria-label={`Map ${i.name}`}
                      value={mapping[i.name] ?? ""}
                      onValueChange={(v) => {
                        setMapping((m) => {
                          const n = { ...m };
                          if (v) n[i.name] = v;
                          else delete n[i.name];
                          return n;
                        });
                        edit();
                      }}
                      options={[
                        { value: "", label: "Not transferred" },
                        ...inventory.target.interfaces
                          .filter((t) => t.type === "ether" && t.name !== management)
                          .map((t) => ({ value: t.name, label: t.name })),
                      ]}
                    />
                  </div>
                ))}
            </div>
          </section>
          <section className={`${workspaceCard} grid gap-4`}>
            <h3 className="font-semibold">What to prepare</h3>
            <p className={workspaceNote}>
              Only literal, supported configuration is eligible. Missing dependencies and
              unsupported properties block the selected section.
            </p>
            <div className="grid gap-3">
              {(Object.keys(MIGRATION_SECTIONS) as MigrationSection[]).map((path) => (
                <label key={path} className="flex items-center gap-3 text-xs">
                  <Checkbox
                    checked={sections.includes(path)}
                    onCheckedChange={(v) => {
                      setSections((s) => (v === true ? [...s, path] : s.filter((p) => p !== path)));
                      edit();
                    }}
                  />
                  <span className="break-all font-mono">{path}</span>
                </label>
              ))}
            </div>
            <Button
              disabled={busy || !management || !sections.length}
              onClick={() => void work(preview)}
            >
              Build migration preview
            </Button>
          </section>
        </div>
      )}
      <section className={workspaceCard}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">Saved plans</h3>
          <Button ghost size="sm" onClick={() => void work(load)}>
            Refresh history
          </Button>
        </div>
        <Select
          aria-label="Saved migration"
          value={plan?.id ?? ""}
          onValueChange={(id) => {
            setPlan(plans.find((p) => p.id === id) ?? null);
            setConfirm(false);
            setManual(false);
          }}
          options={[
            { value: "", label: "Choose a saved preview or result" },
            ...plans.map((p) => ({
              value: p.id,
              label: `${p.input.source} → ${p.device} · ${p.status} · ${new Date(p.createdAt).toLocaleString()}`,
            })),
          ]}
        />
      </section>
      {plan && (
        <section className={`${workspaceCard} grid gap-5`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">
              {plan.items.length} objects · {plan.status}
            </h3>
            <span className="font-mono text-[10px] text-muted-foreground">{plan.fingerprint}</span>
          </div>
          {!!plan.blockers.length && (
            <Notice error>
              <strong>Resolve before staging</strong>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {plan.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Notice>
          )}
          <Notice>
            Configuration is added without replacing existing settings. New bridges, ports, IP
            addresses, DHCP, routes and firewall rules stay disabled. Pools and lists are inert
            dependencies. Source router is never changed. Backups are configuration exports, not
            copies of certificates or private keys.
          </Notice>
          <UnifiedDiff
            unified={`--- target (unchanged existing configuration)\n+++ target (inactive additions)\n@@ -0,0 +1,${plan.items.length} @@\n${plan.items.map((i) => `+${i.command}`).join("\n")}`}
            maxHeight={360}
          />
          {!!plan.manual.length && (
            <details open className="rounded-xl border border-border bg-background p-4">
              <summary className="cursor-pointer text-sm font-medium">
                {plan.manual.length} sections require manual handover
              </summary>
              <div className="mt-3 max-h-60 overflow-auto">
                {plan.manual.map((m) => (
                  <p
                    key={m.section}
                    className="flex justify-between gap-3 border-t border-border py-2 font-mono text-xs"
                  >
                    <span>{m.section}</span>
                    <span>{m.records} records</span>
                  </p>
                ))}
              </div>
              <p className={`mt-3 ${workspaceNote}`}>
                Not selected or unsupported; these sections are not copied. VPN keys, certificates,
                Wi-Fi, scripts, users and device-specific settings require separate review.
              </p>
            </details>
          )}
          {plan.snapshots && (
            <p className="break-all font-mono text-xs text-muted-foreground">
              Backups: {plan.snapshots.source} / {plan.snapshots.target}
            </p>
          )}
          {plan.error && <Notice error>{plan.error} — inspect the target before any retry.</Notice>}
          {plan.status === "preview" && (
            <>
              <label className="flex items-start gap-3 text-xs">
                <Checkbox checked={confirm} onCheckedChange={(v) => setConfirm(v === true)} />
                <span>
                  I reviewed the exact target commands and approve the selected rehearsal or staging
                  operation. Other operators must not change either router during this operation.
                </span>
              </label>
              {!!plan.manual.length && (
                <label className="flex items-start gap-3 text-xs">
                  <Checkbox checked={manual} onCheckedChange={(v) => setManual(v === true)} />
                  <span>I understand the listed manual sections will not be transferred.</span>
                </label>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={!canApply}
                  ghost
                  icon={<ShieldCheck size={14} />}
                  onClick={() => void work(() => apply("rehearse"))}
                >
                  Rehearse & roll back
                </Button>
                <Button disabled={!canApply} onClick={() => void work(() => apply("stage"))}>
                  Back up & stage inactive
                </Button>
              </div>
              <p className={workspaceNote}>
                Preview expires after five minutes. Rehearsal consumes it; create a fresh preview
                before staging.
              </p>
            </>
          )}
          {plan.status === "staged" && (
            <>
              <Notice>
                <strong>Prepared, not cut over.</strong> Disconnect the old router’s production
                links before enabling duplicate addresses or DHCP. Complete unsupported sections and
                secrets, review the activation commands with a local console available, then verify
                a real client’s DHCP, DNS, internet and VPN. Reconnect the old router for physical
                rollback if needed.
              </Notice>
              <div className="flex flex-wrap gap-3">
                <Button
                  ghost
                  icon={<Download size={14} />}
                  onClick={() =>
                    saveDownload(
                      `migration-${plan.id}-cutover.txt`,
                      [
                        "MANUAL CUTOVER — review; do not run on a shared production LAN.",
                        "Isolate old router first. Keep the dedicated management link.",
                        ...plan.items.flatMap((i) => (i.activate ? [i.activate] : [])),
                        "Verify DHCP, DNS, internet and VPN from a real client; staging does not prove service health.",
                      ].join("\n"),
                      "text/plain",
                    )
                  }
                >
                  Export cutover checklist
                </Button>
                <ConfirmWorkspaceAction
                  title="Undo staged configuration?"
                  description="This removes only this plan’s unchanged, inactive objects from the target under Safe Mode. A fresh target backup is captured first."
                  action="Undo staged objects"
                  onConfirm={() =>
                    void work(async () => {
                      setPlan(
                        await workspacePost("/api/migrations/undo", target, {
                          id: plan.id,
                          confirm: true,
                        }),
                      );
                      await load();
                    })
                  }
                >
                  <Button ghost icon={<Undo2 size={14} />} disabled={busy}>
                    Undo staged objects
                  </Button>
                </ConfirmWorkspaceAction>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
