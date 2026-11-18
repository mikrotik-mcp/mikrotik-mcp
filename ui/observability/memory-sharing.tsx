import { useEffect, useState } from "react";
import { Globe2, Layers3, Network, Plus, Router, ShieldCheck, X } from "lucide-react";
import type { Entity } from "../../src/memory/types";
import type { MemoryPage, MemoryScope, MemoryScopeKind } from "../../src/memory/knowledge";
import { api } from "./api";
import { saveMemory } from "./memory-editors";
import { MonitorButton, MonitorNote, MonitorPanel } from "./monitoring-ui";
import "./memory-sharing.css";

const scopes = [
  {
    value: "device",
    title: "Device",
    icon: Router,
    hint: "Only this entity",
    detail: "Local addresses, MTUs and measured router facts stay here.",
  },
  {
    value: "group",
    title: "Group",
    icon: Layers3,
    hint: "Explicit members",
    detail: "Share a policy with a specific set of device entities.",
  },
  {
    value: "shared",
    title: "Shared",
    icon: Globe2,
    hint: "Every device",
    detail: "Fleet-wide safeguards, preferences and reusable lessons.",
  },
] as const;

/** "Device", "Group" or "Shared". */
export function scopeLabel(scope: MemoryScopeKind = "device"): string {
  return scopes.find((s) => s.value === scope)?.title ?? "Device";
}

/**
 * The memory's sharing scope as a pill. `detail` adds who inherits it, in
 * indigo: "Device · only this entity".
 */
export function MemoryScopeBadge({
  scope = "device",
  detail = false,
}: {
  scope?: MemoryScopeKind;
  detail?: boolean;
}) {
  const meta = scopes.find((s) => s.value === scope)!;
  return (
    <span
      className="monitor-badge memory-scope-badge"
      data-tone={detail ? "brand" : undefined}
      data-scope={scope}
    >
      {detail ? `${meta.title} · ${meta.hint.toLowerCase()}` : meta.title}
    </span>
  );
}

function ScopeForm({
  entity,
  refreshVersion,
  onSaved,
}: {
  entity: string;
  refreshVersion: number;
  onSaved: () => void;
}) {
  const [record, setRecord] = useState<MemoryScope | null>(null);
  const [scope, setScope] = useState<MemoryScopeKind>("device");
  const [members, setMembers] = useState<string[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [choices, setChoices] = useState<{ items: Entity[]; total: number } | null>(null);
  const [memberError, setMemberError] = useState("");
  const recordKey = JSON.stringify([entity, reload]);
  const [loadedRecord, setLoadedRecord] = useState(recordKey);
  if (loadedRecord !== recordKey) {
    setLoadedRecord(recordKey);
    setRecord(null);
    setError("");
  }
  const countKey = JSON.stringify([entity, reload, refreshVersion]);
  const [loadedCount, setLoadedCount] = useState(countKey);
  if (loadedCount !== countKey) {
    setLoadedCount(countKey);
    setCount(null);
  }
  const choicesKey = JSON.stringify([scope, query, offset, refreshVersion]);
  const [loadedChoices, setLoadedChoices] = useState(choicesKey);
  if (loadedChoices !== choicesKey) {
    setLoadedChoices(choicesKey);
    setChoices(null);
    setMemberError("");
  }
  useEffect(() => {
    const abort = new AbortController();
    void api<MemoryScope>(
      `/api/memory/scope?entityName=${encodeURIComponent(entity)}`,
      abort.signal,
    )
      .then((next) => {
        if (abort.signal.aborted) return;
        setRecord(next);
        setScope(next.scope);
        setMembers(next.members);
        setConfirmed(false);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [entity, reload]);
  useEffect(() => {
    const abort = new AbortController();
    void api<MemoryPage>(
      `/api/memory/facts?entityName=${encodeURIComponent(entity)}&state=all&limit=1`,
      abort.signal,
    )
      .then((facts) => {
        if (!abort.signal.aborted) setCount(facts.total);
      })
      .catch(() => {
        if (!abort.signal.aborted) setCount(null);
      });
    return () => abort.abort();
  }, [entity, reload, refreshVersion]);
  useEffect(() => {
    if (scope !== "group") return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void api<{ items: Entity[]; total: number }>(
        `/api/memory/entities?q=${encodeURIComponent(query)}&limit=50&offset=${offset}`,
        abort.signal,
      )
        .then((next) => {
          if (!abort.signal.aborted) setChoices(next);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setMemberError(e.message);
        });
    }, 200);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [scope, query, offset, refreshVersion]);
  return (
    <form
      className="memory-sharing-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!record || busy || (scope !== "device" && !confirmed)) return;
        setBusy(true);
        setError("");
        setSaved(false);
        try {
          const next = await saveMemory<MemoryScope>("/api/memory/scope", {
            entityName: entity,
            scope,
            members: scope === "group" ? members : [],
            expectedRevision: record.revision,
            confirmSharing: confirmed,
          });
          setRecord(next);
          setMembers(next.members);
          setConfirmed(false);
          setSaved(true);
          onSaved();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not save sharing scope");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="memory-section-header">
        <div>
          <h3>{entity}</h3>
          <p>
            {count === null
              ? "Scope includes all current and future memories; count unavailable."
              : `${count} existing memories · scope also applies to future memories`}
          </p>
        </div>
        {record && <MemoryScopeBadge scope={record.scope} />}
      </div>
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}{" "}
          <MonitorButton
            type="button"
            size="sm"
            variant="glass"
            disabled={busy}
            onClick={() => setReload((v) => v + 1)}
          >
            Reload scope
          </MonitorButton>
        </MonitorNote>
      )}
      <fieldset disabled={!record || busy} className="memory-sharing-fields">
        <div className="memory-scope-options" role="group" aria-label="Memory sharing scope">
          {scopes.map(({ value, title, icon: Icon, hint, detail }) => (
            <button
              type="button"
              key={value}
              data-scope={value}
              aria-pressed={scope === value}
              onClick={() => {
                setScope(value);
                setConfirmed(false);
                setSaved(false);
              }}
            >
              <Icon size={22} />
              <strong>{title}</strong>
              <span>{hint}</span>
              <small>{detail}</small>
            </button>
          ))}
        </div>
        {scope === "group" && (
          <section className="memory-member-picker" aria-label="Group members">
            <header>
              <h4>
                Members <span>{members.length}/100</span>
              </h4>
              <p>
                No inferred membership. Only these exact entities inherit the group’s knowledge.
              </p>
            </header>
            <div className="memory-member-chips">
              {members.map((member) => (
                <span key={member}>
                  <Router size={13} />
                  {member}
                  <MonitorButton
                    size="sm"
                    type="button"
                    variant="ghost"
                    aria-label={`Remove member ${member}`}
                    onClick={() => {
                      setMembers((old) => old.filter((m) => m !== member));
                      setConfirmed(false);
                      setSaved(false);
                    }}
                  >
                    <X size={12} />
                  </MonitorButton>
                </span>
              ))}
            </div>
            <input
              className="monitor-input"
              aria-label="Search group members"
              value={query}
              maxLength={500}
              placeholder="Find a device entity…"
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
            {memberError && (
              <p role="alert" className="memory-error">
                {memberError}
              </p>
            )}
            <div className="memory-members-scroll">
              <div className="memory-member-list">
                {choices?.items.map((item) => (
                  <label key={item.name} className="monitor-check">
                    <input
                      type="checkbox"
                      aria-label={`Include ${item.name}`}
                      checked={members.includes(item.name)}
                      disabled={
                        item.name === entity ||
                        (item.memoryScope ?? "device") !== "device" ||
                        (!members.includes(item.name) && members.length >= 100)
                      }
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setMembers((old) =>
                          checked ? [...old, item.name] : old.filter((m) => m !== item.name),
                        );
                        setConfirmed(false);
                        setSaved(false);
                      }}
                    />
                    <span>
                      {item.name}
                      <small>{item.entityType}</small>
                    </span>
                    <MemoryScopeBadge scope={item.memoryScope} />
                  </label>
                ))}
                {!choices && !memberError && <p role="status">Loading entities…</p>}
                {choices?.total === 0 && (
                  <p>No matching entities. Create the device entity first.</p>
                )}
              </div>
            </div>
            {choices && choices.total > 50 && (
              <div className="memory-page-controls">
                <MonitorButton
                  type="button"
                  size="sm"
                  variant="glass"
                  disabled={!offset}
                  onClick={() => setOffset((v) => v - 50)}
                >
                  Previous members
                </MonitorButton>
                <span>
                  {offset + 1}–{Math.min(offset + 50, choices.total)} / {choices.total}
                </span>
                <MonitorButton
                  type="button"
                  size="sm"
                  variant="glass"
                  disabled={offset + 50 >= choices.total}
                  onClick={() => setOffset((v) => v + 50)}
                >
                  Next members
                </MonitorButton>
              </div>
            )}
          </section>
        )}
        <div className="memory-sharing-impact" data-scope={scope}>
          <Network size={20} />
          <div>
            <strong>
              {scope === "shared"
                ? "Included in every device’s recall"
                : scope === "group"
                  ? `Included for ${members.length} explicit members`
                  : "No automatic sharing with other devices"}
            </strong>
            <p>
              {scope === "device"
                ? "Removes global/group inheritance for this entity. Other knowledge stays unchanged."
                : "All current and future memories of this entity become applicable in the selected scope. Review local facts before broadening access."}
            </p>
          </div>
        </div>
        {scope !== "device" && (
          <label className="memory-sharing-confirm monitor-check">
            <input
              type="checkbox"
              aria-label="Confirm sharing all entity memories"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I reviewed this entity’s knowledge and intend to share all of it{" "}
              {scope === "shared" ? "with every device." : "with the selected members."}
            </span>
          </label>
        )}
        <footer className="memory-inline-actions">
          <MonitorButton
            variant="primary"
            type="submit"
            disabled={busy || !record || (scope !== "device" && !confirmed)}
          >
            {busy ? "Saving scope…" : "Save sharing scope"}
          </MonitorButton>
          {saved && (
            <span className="memory-verified-label" role="status">
              <ShieldCheck size={14} /> Sharing scope saved
            </span>
          )}
        </footer>
      </fieldset>
    </form>
  );
}

export function MemorySharing({
  entity,
  entities,
  onSelect,
  onCreate,
  onSaved,
  refreshVersion = 0,
}: {
  entity: string;
  entities: Entity[];
  onSelect: (name: string) => void;
  onCreate: () => void;
  onSaved: () => void;
  refreshVersion?: number;
}) {
  const [name, setName] = useState(entity);
  return (
    <MonitorPanel
      title="One lesson. The right routers."
      description="Share safeguards across your fleet without mixing one router’s settings with another’s."
      extra={
        <MonitorButton size="sm" onClick={onCreate} icon={<Plus aria-hidden="true" />}>
          New policy entity
        </MonitorButton>
      }
      className="memory-sharing"
      bodyClassName="flex flex-col gap-4"
    >
      <div
        className="memory-inheritance-strip"
        aria-label="Device recall includes shared, group and device memory"
      >
        <span>
          <Globe2 />
          Shared safeguards
        </span>
        <b>+</b>
        <span>
          <Layers3 />
          Explicit groups
        </span>
        <b>+</b>
        <span>
          <Router />
          Selected device
        </span>
        <small>Conflicts are reported, never silently overridden.</small>
      </div>
      <form
        className="memory-sharing-lookup"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSelect(name.trim());
        }}
      >
        <label className="memory-field">
          <span>Policy or device entity</span>
          <input
            className="monitor-input font-mono text-xs"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Exact entity name, e.g. fleet-policy"
          />
        </label>
        <MonitorButton type="submit" variant="glass">
          Inspect scope
        </MonitorButton>
      </form>
      <div className="memory-inline-actions">
        {entities.slice(0, 12).map((item) => (
          <MonitorButton
            key={item.name}
            size="sm"
            variant={entity === item.name ? "glass" : "ghost"}
            onClick={() => {
              setName(item.name);
              onSelect(item.name);
            }}
          >
            {item.name}
            <MemoryScopeBadge scope={item.memoryScope} />
          </MonitorButton>
        ))}
      </div>
      {entity ? (
        <ScopeForm key={entity} entity={entity} refreshVersion={refreshVersion} onSaved={onSaved} />
      ) : (
        <p className="memory-sharing-empty">
          Choose an entity above. For a fleet-wide rule, create a dedicated policy entity; leave
          each router’s local facts scoped to that router.
        </p>
      )}
      <MonitorNote icon={<ShieldCheck aria-hidden="true" />}>
        Local database only. Sharing controls relevance, not permissions or tenant isolation. Memory
        never authorizes router changes.
      </MonitorNote>
    </MonitorPanel>
  );
}
