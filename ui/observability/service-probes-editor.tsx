import { useId, useState } from "react";
import { LockKeyhole, Plus, Search, ShieldCheck } from "lucide-react";
import {
  asProbeObject,
  newProbeDraft,
  parseProbeDraft,
  probeTargets,
  updateProbeTarget,
} from "./service-probe-draft";
import type { ProbeDraft } from "./service-probe-draft";
import {
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorSearch,
  StatusBadge,
} from "./monitoring-ui";
import { Field, NumberInput, TextArea, TextInput } from "./kit";
import { cn } from "@/lib/utils";

const protocols = {
  https: { title: "HTTPS", detail: "Loads a page. Can check routing exits." },
  tls: { title: "TLS", detail: "Completes a TLS handshake." },
  tcp: { title: "TCP", detail: "Checks that the port opens." },
  dns: { title: "DNS", detail: "Checks that the name resolves." },
};
type Cfg = Record<string, unknown>;
const ranges = (n: number) => `${n} allowed ${n === 1 ? "range" : "ranges"}`;

export function ServiceProbesEditor({ cfg, onChange }: { cfg: Cfg; onChange: (cfg: Cfg) => void }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<{ original?: string; initial: ProbeDraft }>();
  const [removing, setRemoving] = useState<string>();
  const probes = asProbeObject(cfg.serviceProbes),
    targets = probeTargets(cfg);
  const entries = Object.entries(targets),
    httpsCount = entries.filter(([, t]) => t.kind === "https").length;
  const visible = entries.filter(([alias, t]) =>
    [alias, t.host, t.kind, ...t.addresses]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <section className="probe-manager flex flex-col gap-4" aria-label="Service probes">
      <div className="flex flex-wrap gap-1.5">
        <span className="monitor-chip">Shared by all routers</span>
        <span className="monitor-chip">
          {entries.length} {entries.length === 1 ? "service" : "services"}
        </span>
        <span className="monitor-chip">{httpsCount} usable for routing</span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <MonitorSearch
          label="Search service probes"
          placeholder="Search services"
          value={search}
          onChange={setSearch}
          className="flex-[1_1_320px]"
        />
        <Field label="Probe timeout" id={`${id}-timeout`} className="w-[160px]">
          <NumberInput
            min={100}
            max={10000}
            unit="ms"
            allowEmpty
            value={
              typeof probes.timeoutMs === "number"
                ? probes.timeoutMs
                : typeof probes.timeoutMs === "string" && probes.timeoutMs !== ""
                  ? Number(probes.timeoutMs)
                  : probes.timeoutMs === ""
                    ? null
                    : 5000
            }
            onChange={(n) => onChange({ ...cfg, serviceProbes: { ...probes, timeoutMs: n ?? "" } })}
          />
        </Field>
        <MonitorButton
          size="sm"
          icon={<Plus />}
          onClick={() => setEdit({ initial: newProbeDraft() })}
        >
          Add service
        </MonitorButton>
      </div>
      {!entries.length ? (
        <MonitorEmpty
          compact
          icon={<ShieldCheck />}
          title="No services yet"
          action={
            <MonitorButton
              size="sm"
              icon={<Plus />}
              onClick={() => setEdit({ initial: newProbeDraft() })}
            >
              Add your first service
            </MonitorButton>
          }
        >
          Add a host name and the IPs it may use. Pick HTTPS to use it in Service Routing.
        </MonitorEmpty>
      ) : !visible.length ? (
        <MonitorEmpty compact icon={<Search />} title="No services match this search" />
      ) : (
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          role="list"
          aria-label="Approved service targets"
        >
          {visible.map(([alias, t]) => (
            <article
              key={alias}
              role="listitem"
              className={cn(
                "glass flex min-w-0 flex-col gap-1.5 rounded-[14px] px-4 py-3.5",
                edit?.original === alias &&
                  "shadow-[inset_0_0_0_1px_var(--sig),0_0_24px_var(--sig-soft)]",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn("monitor-risk", t.kind === "https" && "text-brand")}>
                  {t.kind.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
                  {alias}
                </span>
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  className="px-1.5"
                  aria-label={`Edit service ${alias}`}
                  onClick={() => setEdit({ original: alias, initial: newProbeDraft(alias, t) })}
                >
                  Edit
                </MonitorButton>
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  className="px-1.5 text-destructive"
                  aria-label={`Remove service ${alias}`}
                  onClick={() => setRemoving(alias)}
                >
                  Remove
                </MonitorButton>
              </div>
              <code dir="ltr" className="truncate font-mono text-[13px] text-fg-secondary">
                {t.host}
                {t.kind !== "dns" && `:${t.port}`}
                {t.kind === "https" && t.path}
              </code>
              <span className="monitor-hint" title={t.addresses.join(", ")}>
                {ranges(t.addresses.length)} ·{" "}
                {t.kind === "https" ? "routing + health" : "health only"}
              </span>
            </article>
          ))}
        </div>
      )}
      {edit && (
        <ProbeTargetEditor
          initial={edit.initial}
          original={edit.original}
          targets={targets}
          onClose={() => setEdit(undefined)}
          onAccept={(alias, target) => {
            onChange(updateProbeTarget(cfg, alias, target));
            setEdit(undefined);
            setSearch("");
          }}
        />
      )}
      <MonitorDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        width={480}
        title="Remove this service?"
        description="Changes go into the draft. Save probes to apply them."
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton size="sm" variant="ghost" onClick={() => setRemoving(undefined)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              size="sm"
              variant="danger"
              onClick={() => {
                if (removing !== undefined) onChange(updateProbeTarget(cfg, removing, null));
                setRemoving(undefined);
              }}
            >
              Remove from draft
            </MonitorButton>
          </>
        }
      >
        <p className="monitor-dialog-body text-[13px] text-fg-secondary">
          Once you save, health checks and exit checks that use{" "}
          <span className="font-mono text-foreground">{removing}</span> stop. Router rules stay as
          they are.
        </p>
      </MonitorDialog>
    </section>
  );
}

export function ProbeTargetEditor({
  initial,
  original,
  targets,
  onClose,
  onAccept,
}: {
  initial: ProbeDraft;
  original?: string;
  targets: ReturnType<typeof probeTargets>;
  onClose: () => void;
  onAccept: (
    alias: string,
    target: NonNullable<ReturnType<typeof parseProbeDraft>["value"]>["target"],
  ) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial),
    [submitted, setSubmitted] = useState(false),
    [discard, setDiscard] = useState(false);
  const parsed = parseProbeDraft(draft, targets, original);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const field = (key: keyof ProbeDraft, value: string) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setDiscard(false);
  };
  const close = () => (dirty ? setDiscard(true) : onClose());
  const error = (key: keyof ProbeDraft) => (submitted ? parsed.errors[key] : undefined);
  const url = `${draft.kind === "https" ? "https://" : ""}${draft.host || "your.host"}${
    draft.kind !== "dns" ? `:${draft.port || "…"}` : ""
  }${draft.kind === "https" ? draft.path : ""}`;
  return (
    <MonitorDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      dismissible={false}
      width={520}
      title={original ? "Edit service" : "Add service"}
      description="Changes go into the draft. Save probes to apply them."
      footer={
        <>
          <span className="flex-1" />
          <MonitorButton size="sm" variant="ghost" onClick={close}>
            Cancel
          </MonitorButton>
          <MonitorButton
            size="sm"
            variant="primary"
            onClick={() => {
              setSubmitted(true);
              if (parsed.value) onAccept(parsed.value.alias, parsed.value.target);
            }}
          >
            {original ? "Update draft" : "Add to draft"}
          </MonitorButton>
        </>
      }
    >
      <div className="monitor-dialog-body grid gap-4">
        <Field
          label="Service ID"
          id={`${id}-alias`}
          error={error("alias")}
          help={
            original
              ? "The ID can't change once a policy uses it."
              : "A unique name that policies and health checks use."
          }
        >
          <TextInput
            mono
            value={draft.alias}
            disabled={original !== undefined}
            autoComplete="off"
            placeholder="my-service"
            onChange={(v) => field("alias", v)}
            end={original !== undefined ? <LockKeyhole aria-hidden="true" /> : undefined}
          />
        </Field>
        <div className="monitor-fl">
          <span className="monitor-label" id={`${id}-kind`}>
            Protocol
          </span>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={`${id}-kind`}>
            {(Object.keys(protocols) as (keyof typeof protocols)[]).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={draft.kind === kind}
                className="monitor-choice"
                onClick={() => field("kind", kind)}
              >
                <span>{protocols[kind].title}</span>
                <small>{protocols[kind].detail}</small>
              </button>
            ))}
          </div>
        </div>
        <div
          className={cn(
            "grid gap-3 max-sm:grid-cols-1",
            draft.kind === "https"
              ? "grid-cols-[minmax(0,1fr)_96px_120px]"
              : draft.kind === "dns"
                ? "grid-cols-1"
                : "grid-cols-[minmax(0,1fr)_96px]",
          )}
        >
          <Field label="Host name" id={`${id}-host`} error={error("host")}>
            <TextInput
              mono
              value={draft.host}
              dir="ltr"
              autoComplete="off"
              placeholder="api.example.com"
              onChange={(v) => field("host", v)}
            />
          </Field>
          {draft.kind !== "dns" && (
            <Field label="Port" id={`${id}-port`} error={error("port")}>
              <NumberInput
                min={1}
                max={65535}
                allowEmpty
                value={
                  draft.port === "" || !Number.isFinite(Number(draft.port))
                    ? null
                    : Number(draft.port)
                }
                onChange={(n) => field("port", n == null ? "" : String(n))}
              />
            </Field>
          )}
          {draft.kind === "https" && (
            <Field label="HTTPS path" id={`${id}-path`} error={error("path")}>
              <TextInput
                mono
                value={draft.path}
                dir="ltr"
                placeholder="/health"
                onChange={(v) => field("path", v)}
              />
            </Field>
          )}
        </div>
        <Field
          label="Allowed IPs and ranges"
          optional={<span className="tabular-nums">{parsed.addresses.length} / 32</span>}
          id={`${id}-addresses`}
          error={error("addresses")}
          help="The probe counts as passed only when the host resolves to one of these."
        >
          <TextArea
            aria-label="Allowed IPs or CIDRs"
            mono
            value={draft.addresses}
            rows={3}
            dir="ltr"
            placeholder={"203.0.113.10/32\n2001:db8::10/128"}
            onChange={(v) => field("addresses", v)}
          />
          {parsed.addresses.some((s) => s.endsWith("/0")) && (
            <span role="alert" className="monitor-err">
              A /0 range allows a whole IP family. Use single addresses or narrow ranges.
            </span>
          )}
        </Field>
        <div className="monitor-note flex-wrap items-center">
          <StatusBadge tone={draft.kind === "https" ? "good" : "default"}>
            {draft.kind === "https" ? "Routing + health" : "Health only"}
          </StatusBadge>
          <span className="min-w-0 font-mono text-[12px] break-all text-fg-secondary">
            {url} · {ranges(parsed.addresses.length)}
          </span>
        </div>
        {discard && (
          <div role="alert" className="monitor-note flex-wrap items-center" data-tone="warn">
            <span className="flex-1 text-fg-secondary">Discard the unsaved service details?</span>
            <MonitorButton size="sm" variant="danger" onClick={onClose}>
              Discard service details
            </MonitorButton>
            <MonitorButton size="sm" variant="ghost" onClick={() => setDiscard(false)}>
              Continue editing
            </MonitorButton>
          </div>
        )}
      </div>
    </MonitorDialog>
  );
}
