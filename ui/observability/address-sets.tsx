import { useCallback, useEffect, useState } from "react";
import type { AddressSetRevision, SetReference } from "../../src/address-sets/model";
import type { RouterRoutingSnapshot } from "../../src/service-routing/inventory";
import { api, postJson } from "./api";
import { Badge, Button, Input, Select } from "./geist";
import { Panel } from "./atoms";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";

const endpoint = "/api/address-sets";

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
                    label: row.comment || `${row.chain} · ${row.action}`,
                  })),
              )
            : [];
        })
      : [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Compose exact IPv4 or IPv6 sets. Save immutable revisions, then review a state-bound
        publication. Nothing changes on the router until you confirm.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel title="Compose a revision" extra={<Badge type="secondary">Local draft</Badge>}>
          <fieldset disabled={busy} className="min-w-0 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                Set name
                <Input
                  value={form.name}
                  placeholder="trusted-services"
                  onChange={(e) => update("name", e.target.value)}
                />
              </label>
              <label className="space-y-1 text-xs">
                IP family
                <Select
                  value={form.family}
                  onValueChange={(v) => update("family", v)}
                  options={[
                    { value: "ipv4", label: "IPv4" },
                    { value: "ipv6", label: "IPv6" },
                  ]}
                />
              </label>
            </div>
            <label className="block space-y-1 text-xs">
              Provenance
              <Input
                value={form.source}
                placeholder="Source, retrieval date or approval reference"
                onChange={(e) => update("source", e.target.value)}
              />
            </label>
            <label className="block space-y-1 text-xs">
              Operation
              <Select
                value={form.operation}
                onValueChange={(v) => update("operation", v)}
                options={[
                  { value: "union", label: "A ∪ B · combine" },
                  { value: "difference", label: "A − B · exclude" },
                  { value: "intersection", label: "A ∩ B · overlap only" },
                ]}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["left", "right"] as const).map((key, index) => (
                <label key={key} className="space-y-1 text-xs">
                  {index ? "Set B (optional)" : "Set A"}
                  <Textarea
                    className="min-h-36 font-mono text-xs"
                    value={form[key]}
                    onChange={(e) => update(key, e.target.value)}
                    placeholder={index ? "10.0.0.128/25" : "10.0.0.0/24"}
                  />
                </label>
              ))}
            </div>
            {form.parent && (
              <p className="text-xs text-muted-foreground">
                New revision of {form.parent.slice(0, 8)}; the parent is preserved.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="secondary"
                disabled={busy || !device}
                onClick={() =>
                  void action<typeof composition>("/compose", payload()).then(
                    (r) => r && setComposition(r),
                  )
                }
              >
                Preview composition
              </Button>
              <Button disabled={busy || !device} onClick={() => void save()}>
                Save revision
              </Button>
            </div>
            {composition && (
              <div className="rounded-md border border-border p-3">
                <p className="text-sm">
                  {composition.prefixes.length} compact prefixes · {composition.addresses} addresses
                </p>
                <ScrollArea
                  className="mt-2 h-32"
                  viewportProps={{ tabIndex: 0, "aria-label": "Composed prefixes" }}
                >
                  <div className="space-y-1 font-mono text-xs">
                    {composition.prefixes.map((p) => (
                      <div key={p}>{p}</div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </fieldset>
        </Panel>
        <Panel
          title="Revision library"
          extra={
            <Button size="sm" type="secondary" disabled={busy} onClick={() => void refresh()}>
              Refresh
            </Button>
          }
        >
          <Select
            aria-label="Saved revision"
            value={selected}
            onValueChange={(id) => {
              setSelected(id);
              setRefs([]);
              setConsent(false);
              setAllowLargeChange(false);
              setSearch("");
            }}
            disabled={busy}
            placeholder="Select a saved revision"
            options={revisions.map((r) => ({
              value: r.id,
              label: `${r.input.name} · ${r.id.slice(0, 8)} · ${r.state}`,
            }))}
          />
          {!revision ? (
            <p className="py-8 text-sm text-muted-foreground">
              Save a composition or select a revision to inspect its contents and publish it.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Badge
                    type={
                      revision.state === "published"
                        ? "success"
                        : revision.state === "uncertain"
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {revision.state}
                  </Badge>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {revision.input.source} · {new Date(revision.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  type="secondary"
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
                </Button>
              </div>
              <dl className="grid grid-cols-2 gap-3 border-y border-border py-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Canonical prefixes</dt>
                  <dd className="mt-1 font-mono text-lg">{revision.prefixes.length}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Address coverage</dt>
                  <dd className="mt-1 break-all font-mono">{revision.addresses}</dd>
                </div>
              </dl>
              <p
                className="break-all font-mono text-xs text-muted-foreground"
                title={revision.checksum}
              >
                SHA-256 · {revision.checksum.slice(0, 20)}…
              </p>
              <Input
                aria-label="Search prefixes"
                placeholder="Find a prefix…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <ScrollArea
                className="h-36 rounded-md border border-border p-3"
                viewportProps={{ tabIndex: 0, "aria-label": "Revision prefixes" }}
              >
                <div className="grid gap-1 font-mono text-xs sm:grid-cols-2">
                  {revision.prefixes
                    .filter((p) => p.includes(search.trim()))
                    .map((p) => (
                      <span key={p}>{p}</span>
                    ))}
                </div>
              </ScrollArea>
              {revision.error && (
                <p role="alert" className="text-sm text-destructive">
                  {revision.error} Inspect the router and backup; do not replay an uncertain write.
                </p>
              )}
              {revision.delta && (
                <div className="rounded-md border border-border p-3 text-xs">
                  <p>
                    Compared with parent: +{revision.delta.addedAddresses} / −
                    {revision.delta.removedAddresses} addresses
                  </p>
                  <ScrollArea
                    className="mt-2 h-24"
                    viewportProps={{ tabIndex: 0, "aria-label": "Coverage changes" }}
                  >
                    <div className="space-y-1 font-mono">
                      {revision.delta.added.map((p) => (
                        <div key={`+${p}`} className="text-emerald-500">
                          + {p}
                        </div>
                      ))}
                      {revision.delta.removed.map((p) => (
                        <div key={`-${p}`} className="text-amber-500">
                          − {p}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}
              {revision.state === "draft" && (
                <fieldset disabled={busy} className="space-y-2">
                  {(revision.delta?.large || revision.prefixes.some((p) => p.endsWith("/0"))) && (
                    <label className="flex gap-2 rounded-md border border-amber-500/30 p-3 text-xs">
                      <input
                        type="checkbox"
                        checked={allowLargeChange}
                        onChange={(e) => {
                          setAllowLargeChange(e.target.checked);
                          setConsent(false);
                        }}
                      />
                      I acknowledge this changes more than 50% of parent coverage or includes all
                      addresses (/0).
                    </label>
                  )}
                  <legend className="mb-2 text-sm font-medium">
                    Replace only selected rule references
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    Live state is checked again during preview. Up to 64 compacted prefixes and 8
                    references per Safe Mode transaction.
                  </p>
                  <ScrollArea
                    className="h-40"
                    viewportProps={{ tabIndex: 0, "aria-label": "Rule references" }}
                  >
                    <div className="space-y-2">
                      {candidates.map((ref) => {
                        const checked = refs.some(
                          (r) => r.table === ref.table && r.id === ref.id && r.field === ref.field,
                        );
                        return (
                          <label
                            key={`${ref.table}/${ref.id}/${ref.field}`}
                            className="flex items-start gap-2 rounded-md border border-border p-2 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && refs.length >= 8}
                              onChange={(e) => {
                                setRefs((old) =>
                                  e.target.checked
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
                                  old.map((r) =>
                                    r.id === selected ? { ...r, plan: undefined } : r,
                                  ),
                                );
                              }}
                            />
                            <span>
                              <span className="block">{ref.label}</span>
                              <span className="font-mono text-muted-foreground">
                                {ref.table} {ref.id} · {ref.field} = {ref.expected}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      {!candidates.length && (
                        <p className="text-xs text-muted-foreground">
                          No eligible references loaded. Refresh router configuration; rules must
                          already reference an address list.
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                  <Button
                    disabled={busy || !refs.length || revision.prefixes.length > 64}
                    onClick={() => void preview()}
                  >
                    Preview publication
                  </Button>
                </fieldset>
              )}
              {revision.state === "published" && (
                <Button type="secondary" disabled={busy} onClick={() => void preview(true)}>
                  Preview rollback
                </Button>
              )}
              {revision.plan && (
                <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <h4 className="text-sm font-medium">
                    {revision.plan.rollback ? "Rollback" : "Publication"} review · {device}
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(revision.plan.expiresAt).toLocaleTimeString()}. A backup is
                    required automatically. Old lists are never removed.
                  </p>
                  <ScrollArea
                    className="h-40"
                    viewportProps={{ tabIndex: 0, "aria-label": "Planned commands" }}
                  >
                    <ol className="space-y-2 font-mono text-xs">
                      {revision.plan.commands.map((cmd, i) => (
                        <li key={i} className="break-all">
                          {cmd}
                        </li>
                      ))}
                    </ol>
                  </ScrollArea>
                  <label className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={busy}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    I reviewed these exact commands and authorize this change on {device}.
                  </label>
                  <Button
                    disabled={busy || !consent || revision.plan.expiresAt < now}
                    onClick={() => void apply()}
                  >
                    {busy
                      ? "Working…"
                      : revision.plan.rollback
                        ? "Restore references"
                        : "Publish revision"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
