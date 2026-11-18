import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Check, Key, Link2, Lock, Plus, Server } from "lucide-react";
import { memoryKinds } from "../../src/memory/knowledge";
import type { MemoryFact, MemoryScope } from "../../src/memory/knowledge";
import { api, postJson } from "./api";
import {
  MonitorButton,
  MonitorDialog,
  MonitorNote,
  MonitorSelect,
  MonitorSwitch,
} from "./monitoring-ui";

export async function saveMemory<T>(path: string, body: unknown): Promise<T> {
  const result = await postJson<T & { error?: string }>(path, body);
  if (result.error) throw new Error(result.error);
  return result;
}

/** A labelled select in the Signal form style. */
export function MemorySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="monitor-fl memory-fl-select">
      <span className="monitor-label">{label}</span>
      <MonitorSelect label={label} value={value} onChange={onChange} options={options} />
    </div>
  );
}

const KIND_RISK: Record<string, string> = {
  constraint: "destructive",
  lesson: "write",
  fact: "idem",
};

function scopeNote(scope: MemoryScope): ReactNode {
  if (scope.scope === "shared")
    return (
      <>
        <b>Shared scope.</b> Every device will be able to recall this memory.
      </>
    );
  if (scope.scope === "group")
    return (
      <>
        <b>Group scope.</b> Inherited by {scope.members.length} explicit members.
      </>
    );
  return (
    <>
      <b>Device scope.</b> Applies only to this entity, never shared automatically.
    </>
  );
}

export function MemoryEditor({
  fact,
  entityName,
  onClose,
  onSaved,
}: {
  fact?: MemoryFact;
  entityName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [entity, setEntity] = useState(fact?.entityName ?? entityName);
  const [content, setContent] = useState(fact?.content ?? "");
  const [key, setKey] = useState(fact?.key ?? "");
  const [kind, setKind] = useState<MemoryFact["kind"]>(fact?.kind ?? "fact");
  const [source, setSource] = useState(fact?.source ?? "dashboard");
  const [confidence, setConfidence] = useState(String(Math.round((fact?.confidence ?? 0.5) * 100)));
  const [expiry, setExpiry] = useState(fact?.expiresAt ? "keep" : "never");
  const [pinned, setPinned] = useState(fact?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const [scopeError, setScopeError] = useState("");
  const [scopeEntity, setScopeEntity] = useState(entity);
  if (scopeEntity !== entity) {
    setScopeEntity(entity);
    setScope(null);
    setScopeError("");
  }
  useEffect(() => {
    const abort = new AbortController();
    if (!entity.trim()) return () => abort.abort();
    const timer = setTimeout(() => {
      void api<MemoryScope>(
        `/api/memory/scope?entityName=${encodeURIComponent(entity.trim())}`,
        abort.signal,
      )
        .then((next) => {
          if (!abort.signal.aborted) setScope(next);
        })
        .catch(() => {
          if (!abort.signal.aborted)
            setScopeError(
              "Cannot confirm this entity’s sharing scope. Check its name or reopen the form to retry.",
            );
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [entity]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!scope || scope.entityName !== entity.trim()) return;
    setBusy(true);
    setError("");
    const expiresAt =
      expiry === "keep"
        ? fact?.expiresAt
        : expiry === "never"
          ? null
          : Date.now() + Number(expiry) * 86400000;
    const fields = {
      content,
      kind,
      source,
      confidence: Number(confidence) / 100,
      pinned,
      expiresAt,
    };
    try {
      await saveMemory(
        fact ? "/api/memory/facts/revise" : "/api/memory/facts",
        fact
          ? { ...fields, id: fact.id, expectedRevision: fact.revision }
          : { ...fields, entityName: entity, key: key.trim() || null },
      );
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save memory");
    } finally {
      setBusy(false);
    }
  };
  return (
    <MonitorDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      width={620}
      dismissible={false}
      closeDisabled={busy}
      eyebrow={fact ? `Revision ${fact.revision}` : "Build your knowledge"}
      title={fact ? "Refine a memory" : "Remember something useful"}
      description="One idea, its source, and how long to trust it."
      footer={
        <>
          <span className="monitor-hint">History preserved on every edit</span>
          <span className="flex-1" />
          <MonitorButton variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </MonitorButton>
          <MonitorButton
            variant="primary"
            type="submit"
            form="memory-editor-form"
            disabled={busy || !scope || scope.entityName !== entity.trim()}
            icon={<Check aria-hidden="true" />}
          >
            {busy ? "Saving…" : "Save memory"}
          </MonitorButton>
        </>
      }
    >
      <form id="memory-editor-form" className="monitor-dialog-body" onSubmit={submit}>
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
          <label className="monitor-fl">
            <span className="monitor-label">Entity</span>
            <span className="monitor-input">
              <Server aria-hidden="true" className="size-[15px] flex-none text-muted-foreground" />
              <input
                className="memory-bare font-mono text-xs"
                required
                maxLength={200}
                value={entity}
                disabled={Boolean(fact)}
                onChange={(e) => setEntity(e.target.value)}
                placeholder="Exact existing entity name"
              />
            </span>
          </label>
          <MonitorNote
            tone={scopeError ? "bad" : undefined}
            icon={<Lock aria-hidden="true" />}
            role="status"
          >
            {scopeError ||
              (scope
                ? scopeNote(scope)
                : entity.trim()
                  ? "Checking memory scope…"
                  : "Choose an existing entity to see who inherits this memory.")}
          </MonitorNote>
          <div className="monitor-fl">
            <span className="monitor-label" id="memory-kind-label">
              Knowledge kind
            </span>
            <div
              role="radiogroup"
              aria-labelledby="memory-kind-label"
              className="grid grid-cols-2 gap-1.5 sm:grid-cols-5"
            >
              {memoryKinds.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  className="monitor-choice px-2.5 py-[9px]"
                  onClick={() => setKind(value)}
                >
                  <span className="monitor-risk self-start" data-risk={KIND_RISK[value] ?? "read"}>
                    {value.toUpperCase()}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <label className="monitor-fl">
            <span className="monitor-label">What should the MCP remember?</span>
            <textarea
              className="monitor-input memory-textarea"
              dir="auto"
              required
              maxLength={8000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              placeholder="Example: Before changing the WAN route, preserve the management path."
            />
            <span className="monitor-hint">
              One reusable idea. Never include passwords or private keys.
            </span>
          </label>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <label className="monitor-fl">
              <span className="monitor-label">Source / evidence</span>
              <input
                className="monitor-input font-mono text-xs"
                required
                maxLength={500}
                dir="auto"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="snap-2026-03-14"
              />
              <span className="monitor-hint">
                Operator confirmation, snapshot ID or diagnostic reference.
              </span>
            </label>
            <label className="monitor-fl">
              <span className="monitor-label">Stable key · optional</span>
              <span className="monitor-input">
                <Key aria-hidden="true" className="size-[15px] flex-none text-muted-foreground" />
                <input
                  className="memory-bare font-mono text-xs"
                  maxLength={120}
                  value={key}
                  disabled={Boolean(fact)}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="wan.provider"
                />
              </span>
              <span className="monitor-hint">
                Same entity + key updates one fact and keeps its history.
              </span>
            </label>
            <label className="monitor-fl">
              <span className="monitor-label">Confidence · 0–100%</span>
              <input
                className="monitor-input"
                type="number"
                min={0}
                max={100}
                required
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
              />
              <span className="monitor-hint">Your assessment, not an automatic score.</span>
            </label>
            <MemorySelect
              label="Expires after"
              value={expiry}
              options={[
                ...(fact?.expiresAt ? [{ value: "keep", label: "Keep current expiry" }] : []),
                { value: "never", label: "No expiry" },
                { value: "1", label: "1 day" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
              ]}
              onChange={setExpiry}
            />
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-0.5">
              <MonitorSwitch checked={pinned} onChange={setPinned} label="Pin this memory" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <b className="text-[13px] font-semibold text-foreground">Pin this memory</b>
              <span className="monitor-hint">Rank it first in relevant recall.</span>
            </span>
          </div>
          {error && (
            <MonitorNote tone="bad" role="alert">
              {error}
            </MonitorNote>
          )}
        </fieldset>
      </form>
    </MonitorDialog>
  );
}

export function EntityEditor({
  from,
  initialType,
  onClose,
  onSaved,
}: {
  from?: string;
  initialType?: string;
  onClose: () => void;
  onSaved: (name?: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState(from ? "depends_on" : (initialType ?? "device"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await saveMemory<{ count: number }>(
        from ? "/api/memory/relations" : "/api/memory/entities",
        from
          ? { relations: [{ from, to: name.trim(), relationType: type.trim() }] }
          : { entities: [{ name: name.trim(), entityType: type.trim() }] },
      );
      if (!result.count)
        throw new Error(
          from
            ? "Relation exists, or the target entity does not exist."
            : "This entity already exists.",
        );
      onSaved(from ? undefined : name.trim());
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };
  return (
    <MonitorDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      closeDisabled={busy}
      title={from ? "Connect this knowledge" : "Create an entity"}
      description={
        from
          ? `Link ${from} to another existing entity. Relations let recall include adjacent context.`
          : "A router, network, person or reusable procedure. Creating an entity does not configure a router."
      }
      footer={
        <>
          <span className="flex-1" />
          <MonitorButton variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </MonitorButton>
          <MonitorButton
            variant="primary"
            disabled={busy}
            type="submit"
            form="memory-entity-form"
            icon={from ? <Link2 aria-hidden="true" /> : <Plus aria-hidden="true" />}
          >
            {busy ? "Saving…" : from ? "Create relation" : "Create entity"}
          </MonitorButton>
        </>
      }
    >
      <form
        id="memory-entity-form"
        onSubmit={submit}
        className="monitor-dialog-body flex flex-col gap-3.5"
      >
        <label className="monitor-fl">
          <span className="monitor-label">{from ? "Target entity" : "Name"}</span>
          <input
            className="monitor-input font-mono text-xs"
            autoFocus
            required
            maxLength={200}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="monitor-fl">
          <span className="monitor-label">{from ? "Relation" : "Type"}</span>
          <input
            className="monitor-input"
            required
            maxLength={200}
            value={type}
            disabled={busy}
            onChange={(e) => setType(e.target.value)}
          />
        </label>
        {error && (
          <MonitorNote tone="bad" role="alert">
            {error}
          </MonitorNote>
        )}
      </form>
    </MonitorDialog>
  );
}
