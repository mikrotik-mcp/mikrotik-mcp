import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Check, RefreshCw, Search } from "lucide-react";
import type { AddressSetRevision, SetReference } from "../../src/address-sets/model";
import type { RouterRoutingSnapshot } from "../../src/service-routing/inventory";
import { api, postJson } from "./api";
import { MonitorButton, MonitorEmpty, MonitorPanel, StatusBadge } from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { CheckRow, FieldSelect, hhmm } from "./service-routing-ui";

const endpoint = "/api/address-sets";

const STATE: Record<AddressSetRevision["state"], { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "brand" },
  published: { label: "Published", tone: "good" },
  "rolled-back": { label: "Rolled back", tone: "default" },
  uncertain: { label: "Uncertain", tone: "warn" },
};

/** "1,792": a big decimal string, grouped. */
function grouped(value: string): string {
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return value;
  }
}
/** How many addresses one CIDR covers. */
function prefixSize(cidr: string): string {
  const [ip, len] = cidr.split("/");
  const bits = ip.includes(":") ? 128 : 32;
  const n = Number(len ?? bits);
  if (!Number.isInteger(n) || n < 0 || n > bits) return "—";
  return (1n << BigInt(bits - n)).toLocaleString();
}
function short(sum: string): string {
  return sum.length > 14 ? `${sum.slice(0, 8)}…${sum.slice(-4)}` : sum;
}

function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="monitor-fl">
      <span className="monitor-label">{label}</span>
      {children}
      {hint != null && <span className="monitor-hint">{hint}</span>}
    </label>
  );
}

export function AddressSets({
  device,
  inventory,
  onBusy,
}: {
  device: string;
  inventory?: RouterRoutingSnapshot;
  onBusy: (busy: boolean) => void;
}) {
  const [revisions, setRevisions] = useState<AddressSetRevision[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const [allowLargeChange, setAllowLargeChange] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [refs, setRefs] = useState<SetReference[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({
    name: "",
    family: "ipv4",
    operation: "union",
    left: "",
    right: "",
    source: "",
    parent: "",
  });
  const [composition, setComposition] = useState<{
    prefixes: string[];
    addresses: string;
    checksum: string;
  }>();
  const revision = revisions.find((r) => r.id === selected);
  const refresh = useCallback(async () => {
    try {
      const r = await api<{ revisions: AddressSetRevision[] }>(
        `${endpoint}?device=${encodeURIComponent(device)}`,
      );
      setRevisions(r.revisions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revisions could not be loaded.");
    }
  }, [device]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (device) void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [device, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const payload = () => ({
    ...form,
    parent: form.parent || undefined,
    left: form.left.split(/[\s,]+/).filter(Boolean),
    right: form.right.split(/[\s,]+/).filter(Boolean),
  });
  const update = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setComposition(undefined);
  };
  async function action<T>(suffix: string, body: unknown): Promise<T | undefined> {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const response = await postJson<T & { error?: string }>(
        `${endpoint}${suffix}?device=${encodeURIComponent(device)}`,
        body,
      );
      if (response.error) throw new Error(response.error);
      return response;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed.");
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  async function save() {
    const r = await action<AddressSetRevision>("", payload());
    if (r) {
      setRevisions((old) => [r, ...old]);
      setSelected(r.id);
      setRefs([]);
      setConsent(false);
    }
  }
  async function preview(rollback = false) {
    if (!revision) return;
    const r = await action<AddressSetRevision>("/preview", {
      id: revision.id,
      references: refs,
      rollback,
      allowLargeChange,
    });
    if (r) {
      setRevisions((old) => old.map((v) => (v.id === r.id ? r : v)));
      setConsent(false);
    }
  }
  async function apply() {
    if (!revision?.plan || !consent) return;
    const r = await action<AddressSetRevision>("/apply", {
      id: revision.id,
      planId: revision.plan.id,
      confirm: true,
    });
    if (r) setRevisions((old) => old.map((v) => (v.id === r.id ? r : v)));
    else await refresh();
    setConsent(false);
  }
  const family = revision?.input.family === "ipv6" ? "6" : "4";
  const candidates =
    inventory?.device === device
      ? (["filter", "mangle"] as const).flatMap((table) => {
          const section =
            inventory.sections[
              `${table === "filter" ? "filters" : "mangle"}${family}` as
                | "filters4"
                | "filters6"
                | "mangle4"
                | "mangle6"
            ];
          return section.state === "ready"
            ? section.rows.flatMap((row) =>
                (["src-address-list", "dst-address-list"] as const)
                  .filter((field) => row[field] && /^\*[\dA-Fa-f]+$/.test(row[".id"] ?? ""))
                  .map((field) => ({
                    table,
                    id: row[".id"],
                    field,
                    expected: row[field],
                    chain: row.chain,
                    label: row.comment || `${row.chain} · ${row.action}`,
                  })),
              )
            : [];
        })
      : [];
  const left = Math.max(0, Math.floor(((revision?.plan?.expiresAt ?? 0) - now) / 1000));
  const shownPrefixes = revision?.prefixes.filter((p) => p.includes(search.trim())) ?? [];
  return (
    <div className="sr-stack grid min-w-0 grid-cols-[minmax(0,1fr)]">
      {error && (
        <div className="monitor-note" data-tone="bad" role="alert">
          <AlertTriangle aria-hidden="true" className="text-destructive" />
          <span className="flex-1 text-fg-secondary">{error}</span>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(460px,100%),1fr))] items-start gap-3.5">
        <MonitorPanel
          title="Compose a revision"
          description="Combine two lists of CIDRs into one compact set. Nothing reaches the router until you publish."
          extra={<StatusBadge dot={false}>Local draft</StatusBadge>}
        >
          <fieldset disabled={busy} className="m-0 grid min-w-0 gap-4 border-0 p-0">
            <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3 max-sm:grid-cols-1">
              <Field label="Set name">
                <input
                  className="monitor-input"
                  value={form.name}
                  placeholder="trusted-services"
                  onChange={(e) => update("name", e.target.value)}
                />
              </Field>
              <div className="monitor-fl">
                <span className="monitor-label">IP family</span>
                <FieldSelect
                  secondary
                  label="IP family"
                  value={form.family}
                  onChange={(v) => update("family", v)}
                  options={[
                    { value: "ipv4", label: "IPv4" },
                    { value: "ipv6", label: "IPv6" },
                  ]}
                />
              </div>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3 max-sm:grid-cols-1">
              <Field
                label="Source"
                hint="Where these addresses came from. Saved with the revision."
              >
                <input
                  className="monitor-input"
                  value={form.source}
                  placeholder="Vendor list, Nov 2026"
                  onChange={(e) => update("source", e.target.value)}
                />
              </Field>
              <div className="monitor-fl">
                <span className="monitor-label">Operation</span>
                <FieldSelect
                  secondary
                  label="Operation"
                  value={form.operation}
                  onChange={(v) => update("operation", v)}
                  options={[
                    { value: "union", label: "Union (A + B)" },
                    { value: "difference", label: "Difference (A − B)" },
                    { value: "intersection", label: "Intersection (A ∩ B)" },
                  ]}
                />
                <span className="monitor-hint">Or difference, intersection</span>
              </div>
            </div>
            {(["left", "right"] as const).map((key, index) => (
              <Field
                key={key}
                label={
                  index ? (
                    <>
                      Set B <span className="font-normal text-muted-foreground">· optional</span>
                    </>
                  ) : (
                    "Set A"
                  )
                }
              >
                <textarea
                  className="monitor-input font-mono"
                  rows={4}
                  value={form[key]}
                  onChange={(e) => update(key, e.target.value)}
                  placeholder={index ? "10.0.0.128/25" : "10.0.0.0/24"}
                />
              </Field>
            ))}
            {form.parent && (
              <p className="text-[12px] text-muted-foreground">
                New revision of{" "}
                <span className="font-mono text-fg-secondary">{form.parent.slice(0, 8)}</span>
              </p>
            )}
            {composition && (
              <div className="glass flex flex-col gap-2 rounded-[14px] px-4 py-3.5">
                <span className="text-[13px] text-foreground">
                  <b className="font-semibold text-emphasis">
                    {composition.prefixes.length}{" "}
                    {composition.prefixes.length === 1 ? "prefix" : "prefixes"}
                  </b>{" "}
                  · {grouped(composition.addresses)} addresses
                </span>
                <div
                  className="flex max-h-[120px] flex-wrap gap-1.5 overflow-y-auto"
                  tabIndex={0}
                  aria-label="Composed prefixes"
                >
                  {composition.prefixes.map((p) => (
                    <span key={p} className="monitor-chip">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <MonitorButton
                size="sm"
                disabled={busy || !device}
                onClick={() =>
                  void action<typeof composition>("/compose", payload()).then(
                    (r) => r && setComposition(r),
                  )
                }
              >
                Preview composition
              </MonitorButton>
              <MonitorButton
                size="sm"
                variant="primary"
                icon={<Check />}
                disabled={busy || !device}
                onClick={() => void save()}
              >
                Save revision
              </MonitorButton>
            </div>
          </fieldset>
        </MonitorPanel>

        <MonitorPanel
          title="Revision library"
          description={`Every saved revision for ${device}, newest first.`}
          extra={
            <MonitorButton
              size="sm"
              variant="ghost"
              icon={<RefreshCw />}
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh
            </MonitorButton>
          }
          bodyClassName="flex flex-col gap-4"
        >
          <FieldSelect
            secondary
            label="Saved revision"
            value={selected}
            disabled={busy}
            placeholder={revisions.length ? "Pick a saved revision" : "No saved revisions yet"}
            onChange={(id) => {
              setSelected(id);
              setRefs([]);
              setConsent(false);
              setAllowLargeChange(false);
              setSearch("");
            }}
            options={revisions.map((r) => ({
              value: r.id,
              label: `${r.input.name} · ${r.id.slice(0, 8)} · ${STATE[r.state].label.toLowerCase()}`,
            }))}
          />
          {!revision ? (
            <MonitorEmpty compact title="No revision picked">
              Save a composition or pick a revision to see its prefixes and publish it.
            </MonitorEmpty>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={STATE[revision.state].tone}>
                  {STATE[revision.state].label}
                </StatusBadge>
                <span className="text-[12px] text-muted-foreground">
                  {revision.input.source} · saved {hhmm(revision.createdAt)}
                </span>
                <span className="flex-1" />
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setForm({
                      ...revision.input,
                      left: revision.input.left.join("\n"),
                      right: revision.input.right.join("\n"),
                      parent: revision.id,
                    });
                    setComposition(undefined);
                  }}
                >
                  New revision
                </MonitorButton>
              </div>

              <dl className="monitor-facts">
                <dt>Prefixes</dt>
                <dd className="tabular-nums">{revision.prefixes.length}</dd>
                <dt>Addresses</dt>
                <dd className="tabular-nums">{grouped(revision.addresses)}</dd>
                <dt>SHA-256</dt>
                <dd className="font-mono text-[12px]" title={revision.checksum}>
                  {short(revision.checksum)}
                </dd>
                <dt>Router list</dt>
                <dd className="font-mono text-[12px] break-all">{revision.list}</dd>
              </dl>

              {revision.delta && (
                <div className="flex flex-col gap-2">
                  <span className="monitor-label">
                    Change from{" "}
                    <span className="font-mono">
                      {(revision.input.parent ?? "parent").slice(0, 8)}
                    </span>
                  </span>
                  <div className="flex gap-4 text-[13px] tabular-nums">
                    <span className="text-success">
                      + {grouped(revision.delta.addedAddresses)} addresses
                    </span>
                    <span className="text-destructive">
                      − {grouped(revision.delta.removedAddresses)} addresses
                    </span>
                  </div>
                  <div
                    className="flex max-h-[120px] flex-col gap-1 overflow-y-auto font-mono text-[12px]"
                    tabIndex={0}
                    aria-label="Coverage changes"
                  >
                    {revision.delta.added.map((p) => (
                      <span key={`+${p}`} className="text-success">
                        + {p}
                      </span>
                    ))}
                    {revision.delta.removed.map((p) => (
                      <span key={`-${p}`} className="text-destructive">
                        − {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <label className="monitor-field">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search prefixes"
                    placeholder="Find a prefix"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div
                  className="flex max-h-[216px] flex-col overflow-y-auto rounded-[10px] shadow-[inset_0_0_0_1px_var(--line)]"
                  tabIndex={0}
                  aria-label="Revision prefixes"
                >
                  {shownPrefixes.map((p, i) => (
                    <div
                      key={p}
                      className={
                        i
                          ? "flex justify-between gap-3 border-t border-line px-3 py-1.5 text-[12px]"
                          : "flex justify-between gap-3 px-3 py-1.5 text-[12px]"
                      }
                    >
                      <span className="truncate font-mono text-fg-secondary">{p}</span>
                      <span className="text-muted-foreground tabular-nums">{prefixSize(p)}</span>
                    </div>
                  ))}
                  {!shownPrefixes.length && (
                    <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
                      No prefix matches.
                    </p>
                  )}
                </div>
              </div>

              {revision.error && (
                <div className="monitor-note" data-tone="bad" role="alert">
                  <AlertTriangle aria-hidden="true" className="text-destructive" />
                  <span className="flex-1 text-fg-secondary">
                    {revision.error} Check the router and the backup. Don't repeat an uncertain
                    write.
                  </span>
                </div>
              )}

              {revision.state === "draft" && (
                <fieldset
                  disabled={busy}
                  aria-label="Before you publish"
                  className="m-0 flex min-w-0 flex-col gap-2.5 border-0 border-t border-solid border-line p-0 pt-4"
                >
                  <span className="sr-eyebrow">Before you publish</span>
                  {(revision.delta?.large || revision.prefixes.some((p) => p.endsWith("/0"))) && (
                    <CheckRow
                      checked={allowLargeChange}
                      onChange={(v) => {
                        setAllowLargeChange(v);
                        setConsent(false);
                      }}
                    >
                      This changes more than half of the parent's addresses, or covers every address
                      (/0). I checked the list.
                    </CheckRow>
                  )}
                  <span className="monitor-label mt-1">Replace only these rule references</span>
                  {candidates.map((ref) => {
                    const checked = refs.some(
                      (r) => r.table === ref.table && r.id === ref.id && r.field === ref.field,
                    );
                    return (
                      <CheckRow
                        key={`${ref.table}/${ref.id}/${ref.field}`}
                        checked={checked}
                        disabled={!checked && refs.length >= 8}
                        onChange={(on) => {
                          setRefs((old) =>
                            on
                              ? [
                                  ...old,
                                  {
                                    table: ref.table,
                                    id: ref.id,
                                    field: ref.field,
                                    expected: ref.expected,
                                  },
                                ]
                              : old.filter(
                                  (r) =>
                                    !(
                                      r.table === ref.table &&
                                      r.id === ref.id &&
                                      r.field === ref.field
                                    ),
                                ),
                          );
                          setConsent(false);
                          setRevisions((old) =>
                            old.map((r) => (r.id === selected ? { ...r, plan: undefined } : r)),
                          );
                        }}
                      >
                        <span className="font-mono text-[12px] text-foreground">
                          {ref.table} {ref.id}
                          {ref.chain ? ` · ${ref.chain}` : ""}
                        </span>
                        <span className="text-[12px] text-muted-foreground">
                          {ref.label} · {ref.field}={ref.expected}
                        </span>
                      </CheckRow>
                    );
                  })}
                  {!candidates.length && (
                    <span className="monitor-hint">
                      No rule uses an address list yet, or the router configuration isn't loaded.
                      Read the router again from Router configuration.
                    </span>
                  )}
                  <span className="monitor-hint">
                    The router state is checked again at preview. Up to 64 prefixes and 8 rule
                    references per change.
                  </span>
                  <div>
                    <MonitorButton
                      size="sm"
                      disabled={busy || !refs.length || revision.prefixes.length > 64}
                      onClick={() => void preview()}
                    >
                      Preview publication
                    </MonitorButton>
                  </div>
                </fieldset>
              )}
              {revision.state === "published" && (
                <div>
                  <MonitorButton size="sm" disabled={busy} onClick={() => void preview(true)}>
                    Preview rollback
                  </MonitorButton>
                </div>
              )}
            </>
          )}
        </MonitorPanel>
      </div>

      {revision?.plan && (
        <section className="sr-plan monitor-panel">
          <header className="monitor-panel-head">
            <div className="min-w-0 flex-1">
              <h2 className="monitor-panel-title">
                {revision.plan.rollback ? "Rollback review" : "Publication review"}
              </h2>
              <p className="monitor-panel-desc">
                These commands run on {device} in this order.{" "}
                {left > 0 ? (
                  <>
                    The plan expires in{" "}
                    <span className="text-foreground tabular-nums">
                      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
                    </span>
                    ; preview again after that.
                  </>
                ) : (
                  "The plan expired. Preview again."
                )}
              </p>
            </div>
          </header>
          <div className="monitor-panel-body flex flex-col gap-4">
            <pre className="monitor-pre max-h-[320px] overflow-auto">
              {revision.plan.commands.map((cmd, i) => `${i + 1}  ${cmd}`).join("\n")}
            </pre>
            <CheckRow checked={consent} disabled={busy} onChange={setConsent}>
              <span>
                I reviewed these commands and want to{" "}
                {revision.plan.rollback ? "roll back" : "publish"} revision{" "}
                <span className="font-mono text-[12px]">{revision.id.slice(0, 8)}</span>.
              </span>
            </CheckRow>
            <div className="flex gap-2">
              <MonitorButton
                size="sm"
                variant="primary"
                disabled={busy || !consent || revision.plan.expiresAt < now}
                onClick={() => void apply()}
              >
                {busy
                  ? "Working…"
                  : revision.plan.rollback
                    ? "Restore references"
                    : "Publish revision"}
              </MonitorButton>
            </div>
          </div>
        </section>
      )}

      <p className="monitor-hint">
        A published revision can be rolled back from the library: pick it and choose Preview
        rollback.
      </p>
    </div>
  );
}
