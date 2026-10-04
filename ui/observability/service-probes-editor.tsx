import { useId, useState } from "react";
import {
  ArrowRight,
  Check,
  Globe2,
  LockKeyhole,
  Network,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  asProbeObject,
  newProbeDraft,
  parseProbeDraft,
  probeTargets,
  updateProbeTarget,
} from "./service-probe-draft";
import type { ProbeDraft } from "./service-probe-draft";
import "./service-probes-editor.css";

const protocols = {
  https: { title: "HTTPS", detail: "HTTP status over TLS · Service Routing + Service Health" },
  tls: { title: "TLS", detail: "Certificate and handshake · Service Health" },
  tcp: { title: "TCP", detail: "Port reachability · Service Health" },
  dns: { title: "DNS", detail: "Name resolution · Service Health" },
};
type Cfg = Record<string, unknown>;

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
    <section className="probe-manager" aria-label="Service Probes">
      <header className="probe-manager__header">
        <div className="probe-manager__intro">
          <span className="probe-manager__icon">
            <ShieldCheck size={22} aria-hidden />
          </span>
          <div>
            <h3>Service Probes</h3>
            <p>Choose exactly what MCP may check.</p>
          </div>
        </div>
        <Button onClick={() => setEdit({ initial: newProbeDraft() })}>
          <Plus size={16} />
          Add service
        </Button>
      </header>
      <div className="probe-manager__scope">
        <span>
          <Globe2 size={15} aria-hidden /> Shared across routers
        </span>
        <span>
          {entries.length} {entries.length === 1 ? "service" : "services"}
        </span>
        <span>{httpsCount} available for Service Routing</span>
      </div>
      <p className="probe-manager__hint">
        Draft only. Adding a service does not run a test or change a router. Review and save these
        settings to approve it.
      </p>
      <div className="probe-manager__toolbar">
        <div className="probe-manager__search">
          <Search size={15} aria-hidden />
          <Input
            aria-label="Search service probes"
            placeholder="Find by service, hostname or IP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label htmlFor={`${id}-timeout`} className="probe-manager__timeout">
          Probe timeout{" "}
          <span>
            <Input
              id={`${id}-timeout`}
              type="number"
              min={100}
              max={10000}
              value={
                typeof probes.timeoutMs === "number" || typeof probes.timeoutMs === "string"
                  ? probes.timeoutMs
                  : 5000
              }
              onChange={(e) =>
                onChange({
                  ...cfg,
                  serviceProbes: {
                    ...probes,
                    timeoutMs: e.target.value === "" ? "" : Number(e.target.value),
                  },
                })
              }
            />
            <small>ms</small>
          </span>
        </label>
      </div>
      {!entries.length ? (
        <div className="probe-manager__empty">
          <div className="probe-manager__journey" aria-hidden>
            <Globe2 />
            <ArrowRight />
            <ShieldCheck />
            <ArrowRight />
            <Check />
          </div>
          <h4>Start with one trusted destination</h4>
          <p>
            Add its hostname and allowed IPs. Choose HTTPS to make it available in Service Routing.
          </p>
          <Button variant="outline" onClick={() => setEdit({ initial: newProbeDraft() })}>
            <Plus size={16} />
            Add your first service
          </Button>
        </div>
      ) : !visible.length ? (
        <p role="status" className="probe-manager__empty">
          No services match this search.
        </p>
      ) : (
        <ScrollArea
          className="probe-manager__list"
          style={{ height: Math.min(360, visible.length * 112) }}
          viewportProps={{ "aria-label": "Approved service targets" }}
        >
          {visible.map(([alias, t]) => (
            <article key={alias} className="probe-target">
              <span className="probe-target__protocol">{t.kind.toUpperCase()}</span>
              <div className="probe-target__content">
                <strong>{alias}</strong>
                <code dir="ltr">
                  {t.host}
                  {t.kind !== "dns" && `:${t.port}`}
                  {t.kind === "https" && t.path}
                </code>
                <details>
                  <summary>
                    {t.addresses.length} allowed IP
                    {t.addresses.length === 1 ? " / range" : "s / ranges"}
                  </summary>
                  <div className="probe-target__addresses">
                    {t.addresses.map((address) => (
                      <code dir="ltr" key={address}>
                        {address}
                      </code>
                    ))}
                  </div>
                </details>
              </div>
              <div className="probe-target__actions">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit service ${alias}`}
                  onClick={() => setEdit({ original: alias, initial: newProbeDraft(alias, t) })}
                >
                  <Pencil size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove service ${alias}`}
                  onClick={() => setRemoving(alias)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </article>
          ))}
        </ScrollArea>
      )}
      <p className="probe-manager__footnote">
        <LockKeyhole size={14} aria-hidden />
        Only listed IPs are approved. DNS changes may require updating this list; nothing is
        auto-approved.
      </p>
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
      <Dialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this approval?</DialogTitle>
            <DialogDescription>
              Remove “{removing}” from this draft. After saving, health checks and route probes
              using this ID can no longer run. Existing router rules are not removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== undefined) onChange(updateProbeTarget(cfg, removing, null));
                setRemoving(undefined);
              }}
            >
              Remove from draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const error = (key: keyof ProbeDraft) =>
    submitted && parsed.errors[key] ? (
      <small id={`${id}-${key}-error`} role="alert" className="probe-field__error">
        {parsed.errors[key]}
      </small>
    ) : null;
  const a11y = (key: keyof ProbeDraft) => ({
    id: `${id}-${key}`,
    "aria-label": {
      alias: "Service ID",
      kind: "Probe protocol",
      host: "Hostname",
      port: "Port",
      path: "HTTPS path",
      addresses: "Allowed IPs or CIDRs",
    }[key],
    "aria-invalid": submitted && !!parsed.errors[key],
    "aria-describedby": submitted && parsed.errors[key] ? `${id}-${key}-error` : undefined,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="probe-editor" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{original ? "Edit service approval" : "Add a service probe"}</DialogTitle>
          <DialogDescription>
            Define the destination and its allowed network boundary. This is not a routing rule.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="probe-editor__scroll">
          <div className="probe-editor__body">
            <div className="probe-editor__fields">
              <label htmlFor={`${id}-alias`} className="probe-field">
                Service ID
                <Input
                  {...a11y("alias")}
                  value={draft.alias}
                  disabled={original !== undefined}
                  autoComplete="off"
                  placeholder="my_service"
                  onChange={(e) => field("alias", e.target.value)}
                />
                {error("alias")}
                <small>
                  {original
                    ? "Stable ID: existing policies keep this reference."
                    : "A unique name used by policies and health checks."}
                </small>
              </label>
              <div className="probe-field">
                <label htmlFor={`${id}-kind`}>Protocol</label>
                <Select value={draft.kind} onValueChange={(v) => field("kind", v)}>
                  <SelectTrigger id={`${id}-kind`} aria-label="Probe protocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(protocols).map(([value, p]) => (
                      <SelectItem key={value} value={value}>
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <small>{protocols[draft.kind].detail}</small>
              </div>
              <label htmlFor={`${id}-host`} className="probe-field probe-field--wide">
                Hostname
                <Input
                  {...a11y("host")}
                  value={draft.host}
                  dir="ltr"
                  autoComplete="off"
                  placeholder="api.example.com"
                  onChange={(e) => field("host", e.target.value)}
                />
                {error("host")}
                <small>
                  Hostname or IPv4 literal, without scheme, port or path. IPv6 is supported in the
                  allowed addresses below.
                </small>
              </label>
              {draft.kind !== "dns" && (
                <label htmlFor={`${id}-port`} className="probe-field">
                  Port
                  <Input
                    {...a11y("port")}
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(e) => field("port", e.target.value)}
                  />
                  {error("port")}
                </label>
              )}
              {draft.kind === "https" && (
                <label htmlFor={`${id}-path`} className="probe-field">
                  HTTPS path
                  <Input
                    {...a11y("path")}
                    value={draft.path}
                    dir="ltr"
                    placeholder="/health"
                    onChange={(e) => field("path", e.target.value)}
                  />
                  {error("path")}
                  <small>No query strings, fragments or credentials.</small>
                </label>
              )}
            </div>
            <section className="probe-boundary" aria-label="Allowed network boundary">
              <div className="probe-boundary__heading">
                <ShieldCheck size={18} aria-hidden />
                <div>
                  <h4>Allowed destination IPs</h4>
                  <p>DNS answers must stay inside this boundary.</p>
                </div>
                <span>{parsed.addresses.length} / 32</span>
              </div>
              <label htmlFor={`${id}-addresses`} className="sr-only">
                Allowed IPs or CIDRs
              </label>
              <Textarea
                {...a11y("addresses")}
                value={draft.addresses}
                rows={3}
                dir="ltr"
                placeholder={"203.0.113.10/32\n2001:db8::10/128"}
                onChange={(e) => field("addresses", e.target.value)}
                className="probe-boundary__input"
              />
              {error("addresses")}
              <p className="probe-manager__hint">
                Enter real IPs or CIDRs, one per line or comma-separated. Private networks need
                explicit approval too. Example addresses are placeholders, not defaults.
              </p>
              {parsed.addresses.some((s) => s.endsWith("/0")) && (
                <p role="alert" className="probe-field__warning">
                  A /0 range approves an entire IP family. Prefer individual addresses or narrow
                  provider ranges.
                </p>
              )}
            </section>
            <div className="probe-editor__preview">
              <Network size={17} aria-hidden />
              <span>
                <b>{draft.kind.toUpperCase()}</b>
                <code dir="ltr">
                  {draft.host || "Your destination"}
                  {draft.kind !== "dns" ? `:${draft.port || "…"}` : ""}
                  {draft.kind === "https" ? draft.path : ""}
                </code>
              </span>
              <span>{draft.kind === "https" ? "Routing + Health" : "Health only"}</span>
            </div>
            {original && (
              <p className="probe-field__warning">
                Changing this approval affects future checks that use this ID. It does not update
                existing routing rules.
              </p>
            )}
            {discard && (
              <div role="alert" className="probe-discard">
                <p>Discard the unsaved service details?</p>
                <Button variant="destructive" size="sm" onClick={onClose}>
                  Discard service details
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDiscard(false)}>
                  Continue editing
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setSubmitted(true);
              if (parsed.value) onAccept(parsed.value.alias, parsed.value.target);
            }}
          >
            {original ? "Update draft" : "Add to draft"}
            <ArrowRight size={16} />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
