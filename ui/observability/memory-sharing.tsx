import { useEffect, useState } from "react";
import { Globe2, Layers3, Network, Plus, Router, ShieldCheck, X } from "lucide-react";
import type { Entity } from "../../src/memory/types";
import type { MemoryPage, MemoryScope, MemoryScopeKind } from "../../src/memory/knowledge";
import { api } from "./api";
import { saveMemory } from "./memory-editors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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

export function MemoryScopeBadge({ scope = "device" }: { scope?: MemoryScopeKind }) {
  const meta = scopes.find((s) => s.value === scope)!;
  const Icon = meta.icon;
  return (
    <Badge asChild variant="outline">
      <span className="memory-scope-badge" data-scope={scope}>
        <Icon size={12} />
        {meta.title}
      </span>
    </Badge>
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
  useEffect(() => {
    const abort = new AbortController();
    setRecord(null);
    setError("");
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
    setCount(null);
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
    setChoices(null);
    setMemberError("");
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
        <div className="memory-error" role="alert">
          {error}{" "}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setReload((v) => v + 1)}
          >
            Reload scope
          </Button>
        </div>
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
                  <Button
                    size="icon-xs"
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
                  </Button>
                </span>
              ))}
            </div>
            <Input
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
            <ScrollArea className="memory-members-scroll">
              <div className="memory-member-list">
                {choices?.items.map((item) => (
                  <label key={item.name}>
                    <Checkbox
                      aria-label={`Include ${item.name}`}
                      checked={members.includes(item.name)}
                      disabled={
                        item.name === entity ||
                        (item.memoryScope ?? "device") !== "device" ||
                        (!members.includes(item.name) && members.length >= 100)
                      }
                      onCheckedChange={(checked) => {
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
            </ScrollArea>
            {choices && choices.total > 50 && (
              <div className="memory-page-controls">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!offset}
                  onClick={() => setOffset((v) => v - 50)}
                >
                  Previous members
                </Button>
                <span>
                  {offset + 1}–{Math.min(offset + 50, choices.total)} / {choices.total}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={offset + 50 >= choices.total}
                  onClick={() => setOffset((v) => v + 50)}
                >
                  Next members
                </Button>
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
          <label className="memory-sharing-confirm">
            <Checkbox
              aria-label="Confirm sharing all entity memories"
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
            />
            <span>
              I reviewed this entity’s knowledge and intend to share all of it{" "}
              {scope === "shared" ? "with every device." : "with the selected members."}
            </span>
          </label>
        )}
        <footer className="memory-inline-actions">
          <Button type="submit" disabled={busy || !record || (scope !== "device" && !confirmed)}>
            {busy ? "Saving scope…" : "Save sharing scope"}
          </Button>
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
    <section className="memory-sharing">
      <header className="memory-sharing-intro">
        <div>
          <div className="memory-eyebrow">
            <Globe2 size={14} /> SHARED KNOWLEDGE, CLEAR BOUNDARIES
          </div>
          <h2>One lesson. The right routers.</h2>
          <p>
            Share safeguards across your fleet without mixing one router’s settings with another’s.
          </p>
        </div>
        <Button variant="outline" onClick={onCreate}>
          <Plus size={15} /> New policy entity
        </Button>
      </header>
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
          <Input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Exact entity name, e.g. fleet-policy"
          />
        </label>
        <Button type="submit" variant="outline">
          Inspect scope
        </Button>
      </form>
      <div className="memory-inline-actions">
        {entities.slice(0, 12).map((item) => (
          <Button
            key={item.name}
            size="sm"
            variant={entity === item.name ? "secondary" : "ghost"}
            onClick={() => {
              setName(item.name);
              onSelect(item.name);
            }}
          >
            {item.name}
            <MemoryScopeBadge scope={item.memoryScope} />
          </Button>
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
      <p className="memory-sharing-boundary">
        <ShieldCheck size={15} />
        Local database only. Sharing controls relevance, not permissions or tenant isolation. Memory
        never authorizes router changes.
      </p>
    </section>
  );
}
