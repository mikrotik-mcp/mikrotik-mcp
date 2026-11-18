/**
 * Router migration (the Rec-Migration board): move a config to a replacement
 * router through guarded staging. Inspect both routers, map ports, build an
 * exact preview, then rehearse or stage the new config inactive. Undo opens a
 * confirm dialog (Rec-Migration-Undo). The source router is never changed.
 */
import "./router-migration.css";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Clock,
  Download,
  Play,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { api } from "./api";
import { DiffPre, StepTrail } from "./config-charts";
import { LoadingState } from "./loading-state";
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
} from "./monitoring-ui";
import { Checkbox, Select } from "./kit";
import type { DevicesPayload } from "./types";
import { saveDownload, useWorkspaceClock, workspacePost } from "./workspace-ui";
import { MIGRATION_SECTIONS } from "../../src/migration/sections";
import type { MigrationPlan, MigrationSection, RouterInventory } from "../../src/migration/model";

type Inventory = Omit<RouterInventory, "export">;

const STEPS = ["Inspect & map", "Review exact plan", "Rehearse / stage", "Manual cutover"];

function HardwareCard({ side, r }: { side: string; r: Inventory }): ReactNode {
  return (
    <div className="glass mig-hw">
      <span className="monitor-label">{side}</span>
      <b>{r.model}</b>
      <span className="mono text-muted-foreground">
        RouterOS {r.version} · {r.architecture}
      </span>
      <span className="monitor-hint mt-1">Packages: {r.packages.join(", ")}</span>
    </div>
  );
}

function clockLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function shortFp(fp: string): string {
  return fp.length > 12 ? `${fp.slice(0, 4)}…${fp.slice(-4)}` : fp;
}

export function RouterMigrationView(): ReactNode {
  const [initialLoading, setInitialLoading] = useState(true);
  const [devices, setDevices] = useState<string[]>([]);
  const [defaultDevice, setDefaultDevice] = useState<string | null>(null);
  const [device, setDevice] = useState("");
  const [error, setError] = useState("");

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
    <section className="mig grid content-start gap-[18px]">
      <PageIntro
        eyebrow="Router migration · guarded staging"
        verdict={
          <>
            A new router. <span className="s">A deliberate handover.</span>
          </>
        }
        lead="Map the ports, resolve what won’t carry over and rehearse the transfer before preparing inactive config on the replacement."
        aside={
          <RouterPicker
            value={device}
            onChange={setDevice}
            routers={devices}
            defaultRouter={defaultDevice}
            label="Workspace router"
          />
        }
      />
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {initialLoading ? (
        <LoadingState label="Loading workspace routers" layout="form" />
      ) : device ? (
        <Migration key={device} target={device} devices={devices} />
      ) : (
        <MonitorEmpty title="Select a configured router to start" />
      )}
    </section>
  );
}

function Migration({ target, devices }: { target: string; devices: string[] }): ReactNode {
  const now = useWorkspaceClock();
  const [source, setSource] = useState(devices.find((d) => d !== target) ?? "");
  const [inventory, setInventory] = useState<{ source: Inventory; target: Inventory } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [management, setManagement] = useState("");
  const [sections, setSections] = useState<MigrationSection[]>([
    "/interface/bridge",
    "/interface/bridge/port",
    "/ip/pool",
    "/ip/address",
    "/ip/dhcp-server/network",
    "/ip/dhcp-server",
  ]);
  const [plans, setPlans] = useState<MigrationPlan[]>([]);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [manual, setManual] = useState(false);
  const [undoing, setUndoing] = useState(false);

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

  async function work(fn: () => Promise<void>): Promise<void> {
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

  async function inspect(): Promise<void> {
    const a = await api<Inventory>(
      `/api/migrations/inventory?device=${encodeURIComponent(source)}`,
    );
    const b = await api<Inventory>(
      `/api/migrations/inventory?device=${encodeURIComponent(target)}`,
    );
    setInventory({ source: a, target: b });
    setMapping({});
    setManagement("");
    setPlan(null);
    setConfirm(false);
  }

  async function preview(): Promise<void> {
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

  async function apply(mode: "rehearse" | "stage"): Promise<void> {
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

  async function undo(): Promise<void> {
    if (!plan) return;
    setPlan(await workspacePost("/api/migrations/undo", target, { id: plan.id, confirm: true }));
    await load();
  }

  const edit = (): void => {
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

  const allSections = Object.keys(MIGRATION_SECTIONS) as MigrationSection[];
  const targetEther = inventory?.target.interfaces.filter((i) => i.type === "ether") ?? [];
  const step = plan?.status === "staged" ? 3 : plan ? 2 : inventory ? 1 : 0;

  return (
    <div className="grid content-start gap-[18px]">
      <StepTrail labels={STEPS} active={step} />
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}

      <section className="glass mig-pair">
        <div className="monitor-fl">
          <span className="monitor-label">Source · read only</span>
          <RouterPicker
            label="Source router"
            value={source}
            onChange={(v) => {
              setSource(v);
              setInventory(null);
              edit();
            }}
            routers={devices.filter((d) => d !== target)}
          />
        </div>
        <span className="mig-pair-arrow" aria-hidden="true">
          <ArrowRight />
        </span>
        <div className="monitor-fl">
          <span className="monitor-label">Replacement target · the workspace router</span>
          <b className="mono mig-target">{target}</b>
        </div>
        <MonitorButton
          variant="ghost"
          icon={<RefreshCw aria-hidden="true" />}
          disabled={busy || !source}
          aria-busy={busy || undefined}
          onClick={() => void work(inspect)}
        >
          {busy ? "Working…" : "Inspect both routers"}
        </MonitorButton>
      </section>

      <div className="mig-cols">
        <MonitorPanel
          title="Port mapping"
          description="Map every source Ethernet port you want to carry over."
        >
          {!inventory ? (
            <MonitorEmpty compact title="Nothing inspected yet">
              Inspect both routers to read their hardware, ports and packages. No router changes.
            </MonitorEmpty>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="mig-hw-row flex gap-2.5">
                <HardwareCard side="Source" r={inventory.source} />
                <HardwareCard side="Target" r={inventory.target} />
              </div>
              <div className="monitor-fl">
                <span className="monitor-label">Protected target management port</span>
                <Select
                  label="Protected management interface"
                  placeholder="Choose a dedicated management interface"
                  value={management}
                  onChange={(v) => {
                    setManagement(v);
                    edit();
                  }}
                  options={targetEther.map((i) => ({ value: i.name, label: i.name }))}
                />
                <span className="monitor-hint">
                  This port stays outside the transfer. Keep an independent management connection
                  the whole time.
                </span>
              </div>
              <span className="monitor-label">Source port → target port</span>
              {inventory.source.interfaces
                .filter((i) => i.type === "ether")
                .map((i) => (
                  <div key={i.name} className="mig-port">
                    <span className="monitor-chip trunc" title={i.name}>
                      {i.name}
                    </span>
                    <span className="mig-arrow" aria-hidden="true">
                      <ArrowRight />
                    </span>
                    <Select
                      label={`Map ${i.name}`}
                      size="sm"
                      value={mapping[i.name] ?? ""}
                      onChange={(v) => {
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
                        ...targetEther
                          .filter((t) => t.name !== management)
                          .map((t) => ({ value: t.name, label: t.name })),
                      ]}
                    />
                  </div>
                ))}
            </div>
          )}
        </MonitorPanel>

        <MonitorPanel
          title="What to prepare"
          description={`${sections.length} of ${allSections.length} sections selected.`}
          bodyClassName="flex flex-col gap-3.5"
        >
          <div className="mig-sections">
            {allSections.map((path) => (
              <Checkbox
                key={path}
                className="mig-section"
                label={path}
                checked={sections.includes(path)}
                onCheckedChange={(on) => {
                  setSections((s) => (on ? [...s, path] : s.filter((p) => p !== path)));
                  edit();
                }}
              />
            ))}
          </div>
          <MonitorNote>
            Only literal, supported configuration is eligible. Missing dependencies and unsupported
            properties block the section.
          </MonitorNote>
          <div className="flex flex-wrap items-center gap-2.5">
            <MonitorButton
              variant="primary"
              icon={<Play aria-hidden="true" />}
              disabled={busy || !inventory || !management || !sections.length}
              onClick={() => void work(preview)}
            >
              Build migration preview
            </MonitorButton>
            <span className="flex-1" />
            <Select
              label="Saved migration"
              placeholder="Saved plans"
              leading={<Clock aria-hidden="true" />}
              className="mig-saved"
              value={plan?.id ?? ""}
              onChange={(id) => {
                setPlan(plans.find((p) => p.id === id) ?? null);
                setConfirm(false);
                setManual(false);
              }}
              options={plans.map((p) => ({
                value: p.id,
                label: `${p.input.source} → ${p.device} · ${p.status} · ${new Date(p.createdAt).toLocaleString()}`,
              }))}
            />
          </div>
        </MonitorPanel>
      </div>

      {plan && (
        <MonitorPanel
          title={`${plan.items.length} objects · ${plan.status}`}
          description={
            <>
              {plan.input.source} → {plan.device} ·{" "}
              <span className="mono" title={plan.fingerprint}>
                fp {shortFp(plan.fingerprint)}
              </span>
            </>
          }
          extra={
            plan.status === "staged" ? (
              <StatusBadge tone="good">staged, not cut over</StatusBadge>
            ) : plan.status === "preview" ? (
              <StatusBadge tone={plan.expiresAt > now ? "warn" : "bad"} dot={false}>
                {plan.expiresAt > now ? `expires in ${clockLeft(plan.expiresAt - now)}` : "expired"}
              </StatusBadge>
            ) : (
              <StatusBadge dot={false}>{plan.status}</StatusBadge>
            )
          }
          bodyClassName="flex flex-col gap-3.5"
        >
          {!!plan.blockers.length && (
            <MonitorNote tone="bad" icon={<TriangleAlert aria-hidden="true" />} role="alert">
              <b>Resolve before staging.</b>
              <ul className="mt-1 list-disc pl-4">
                {plan.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </MonitorNote>
          )}
          {plan.status === "staged" ? (
            <>
              <MonitorNote tone="good" icon={<Check aria-hidden="true" />}>
                <b>Prepared, not cut over.</b> Disconnect the old router’s production links before
                you enable duplicate addresses or DHCP. Finish the manual sections and secrets,
                review the activation commands with a local console, then check DHCP, DNS, internet
                and VPN from a real client.
              </MonitorNote>
              {plan.snapshots && (
                <p className="monitor-hint">
                  Backups: {plan.snapshots.source} / {plan.snapshots.target}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <MonitorButton
                  variant="ghost"
                  icon={<Download aria-hidden="true" />}
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
                </MonitorButton>
                <MonitorButton
                  variant="ghost"
                  icon={<RefreshCw aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => setUndoing(true)}
                >
                  Undo staged objects
                </MonitorButton>
              </div>
            </>
          ) : (
            <>
              <MonitorNote>
                New bridges, ports, addresses, DHCP, routes and firewall rules are added{" "}
                <b>disabled</b>. Nothing existing is replaced. The source router is never changed.
                Backups are exports, not copies of certificates or keys.
              </MonitorNote>
              <DiffPre
                className="mig-diff"
                text={[
                  "--- target (unchanged existing configuration)",
                  "+++ target (inactive additions)",
                  `@@ -0,0 +1,${plan.items.length} @@`,
                  ...plan.items.map((i) => `+${i.command}`),
                ].join("\n")}
              />
              {!!plan.manual.length && (
                <div className="monitor-fl">
                  <span className="monitor-label">
                    {plan.manual.length} section{plan.manual.length === 1 ? "" : "s"} need
                    {plan.manual.length === 1 ? "s" : ""} a manual handover
                  </span>
                  {plan.manual.map((m) => (
                    <div key={m.section} className="mig-manual" title={m.reason}>
                      <span className="mono trunc text-fg-secondary">{m.section}</span>
                      <span className="text-right text-muted-foreground">{m.records} records</span>
                    </div>
                  ))}
                  <span className="monitor-hint">
                    Not selected or unsupported. VPN keys, certificates, Wi-Fi, scripts and users
                    need a separate review.
                  </span>
                </div>
              )}
              {plan.snapshots && (
                <p className="monitor-hint">
                  Backups: {plan.snapshots.source} / {plan.snapshots.target}
                </p>
              )}
              {plan.error && (
                <MonitorNote tone="bad" role="alert">
                  {plan.error}. Inspect the target before any retry.
                </MonitorNote>
              )}
              {plan.status === "preview" && (
                <>
                  <Checkbox
                    tone="warn"
                    checked={confirm}
                    onCheckedChange={setConfirm}
                    label="I reviewed the exact target commands and approve this rehearsal or staging. No one else will change either router meanwhile."
                  />
                  {!!plan.manual.length && (
                    <Checkbox
                      tone="warn"
                      checked={manual}
                      onCheckedChange={setManual}
                      label="I understand the listed manual sections will not be transferred."
                    />
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <MonitorButton
                      variant="ghost"
                      icon={<ShieldCheck aria-hidden="true" />}
                      disabled={!canApply}
                      onClick={() => void work(() => apply("rehearse"))}
                    >
                      Rehearse & roll back
                    </MonitorButton>
                    <MonitorButton
                      variant="primary"
                      icon={<Download aria-hidden="true" />}
                      disabled={!canApply}
                      onClick={() => void work(() => apply("stage"))}
                    >
                      Back up & stage inactive
                    </MonitorButton>
                    <span className="monitor-hint">
                      A rehearsal uses up the preview. Build a fresh one before staging.
                    </span>
                  </div>
                </>
              )}
            </>
          )}
          {plan.status === "staged" && plan.error && (
            <MonitorNote tone="bad" role="alert">
              {plan.error}. Inspect the target before any retry.
            </MonitorNote>
          )}
        </MonitorPanel>
      )}

      {plan && undoing && (
        <MonitorDialog
          open
          confirm
          width={540}
          onOpenChange={(open) => !open && setUndoing(false)}
          title="Undo staged configuration?"
          description={`Removes only this plan’s unchanged, inactive objects from ${target} under Safe Mode. A fresh target backup is captured first.`}
          footer={
            <>
              <MonitorButton variant="ghost" onClick={() => setUndoing(false)}>
                Cancel
              </MonitorButton>
              <span className="flex-1" />
              <MonitorButton
                variant="danger"
                icon={<RefreshCw aria-hidden="true" />}
                disabled={busy}
                onClick={() => {
                  setUndoing(false);
                  void work(undo);
                }}
              >
                Undo staged objects
              </MonitorButton>
            </>
          }
        >
          <div className="mig-dialog flex flex-col gap-4">
            <dl className="monitor-facts">
              <dt>Plan</dt>
              <dd className="mono">
                {plan.id} · {plan.items.length} objects
              </dd>
              <dt>Target</dt>
              <dd>
                <span className="flex items-center gap-2.5">
                  <StatusDot tone="warn" />
                  <span className="mono">{target}</span>
                </span>
              </dd>
              <dt>Source</dt>
              <dd>{plan.input.source} is not touched</dd>
            </dl>
            <MonitorNote>Objects you changed after staging are left in place.</MonitorNote>
          </div>
        </MonitorDialog>
      )}
    </div>
  );
}
