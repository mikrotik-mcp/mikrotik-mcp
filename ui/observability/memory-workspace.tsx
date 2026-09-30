import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Archive,
  ArrowRight,
  BookOpen,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  History,
  Link2,
  Network,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Globe2,
} from "lucide-react";
import type {
  BrowseInput,
  MemoryFact,
  MemoryHealth,
  MemoryPage,
  MemoryRecall,
  MemoryRevision,
} from "../../src/memory/knowledge";
import { memoryKinds, reviewReasons } from "../../src/memory/knowledge";
import type { Entity, Relation } from "../../src/memory/types";
import type { MemoryActivityEntry, MemoryConfig, MemoryStats } from "./types";
import { api, deleteJson } from "./api";
import { CopyButton } from "./atoms";
import { EntityEditor, MemoryEditor, MemorySelect, saveMemory } from "./memory-editors";
import { MemorySharing, MemoryScopeBadge } from "./memory-sharing";
import { toast } from "./toast-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import "./memory-workspace.css";

const date = (value: number | null) => (value ? new Date(value).toLocaleString() : "Not verified");
const message = (e: unknown) => (e instanceof Error ? e.message : "Memory request failed");
function useDelayedText(value: string) {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDelayed(value), 250);
    return () => clearTimeout(timer);
  }, [value]);
  return delayed;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="memory-empty">
      <BookOpen size={28} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function FactCard({
  fact,
  onOpen,
  onRevise,
  busy,
}: {
  fact: MemoryFact;
  onOpen: () => void;
  onRevise: (patch: object) => void;
  busy: boolean;
}) {
  const reasons = reviewReasons(fact);
  return (
    <article className="memory-fact" data-kind={fact.kind}>
      <header>
        <Badge asChild variant="outline">
          <span>{fact.kind}</span>
        </Badge>
        <span className="memory-entity-name">{fact.entityName}</span>
        <MemoryScopeBadge scope={fact.scope} />
        <Button
          variant="ghost"
          size="icon-sm"
          title={fact.pinned ? "Unpin memory" : "Pin memory"}
          aria-label={fact.pinned ? "Unpin memory" : "Pin memory"}
          aria-pressed={fact.pinned}
          disabled={busy}
          onClick={() => onRevise({ pinned: !fact.pinned })}
        >
          <Pin size={14} fill={fact.pinned ? "currentColor" : "none"} />
        </Button>
      </header>
      <button className="memory-fact-content" onClick={onOpen}>
        <span dir="auto">
          {fact.content.length > 360 ? `${fact.content.slice(0, 360)}…` : fact.content}
        </span>
        <span className="sr-only">Open memory {fact.id}</span>
      </button>
      {fact.key && <code className="memory-fact-key">{fact.key}</code>}
      <div className="memory-fact-source">
        <ShieldCheck size={13} />
        <span title={fact.source}>{fact.source}</span>
        <span>{Math.round(fact.confidence * 100)}%</span>
      </div>
      <footer>
        <span className={reasons.length ? "memory-review-label" : "memory-verified-label"}>
          {fact.status === "archived" ? "Archived" : (reasons[0] ?? "Verified")}
        </span>
        <span>v{fact.revision}</span>
        <Button size="xs" variant="ghost" onClick={onOpen}>
          Details <ArrowRight size={12} />
        </Button>
      </footer>
    </article>
  );
}

function FactDetail({
  fact,
  onClose,
  onEdit,
  onRevise,
  busy,
}: {
  fact: MemoryFact;
  onClose: () => void;
  onEdit: () => void;
  onRevise: (patch: object) => void;
  busy: boolean;
}) {
  const [history, setHistory] = useState<MemoryRevision[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void api<MemoryRevision[]>(`/api/memory/facts/${fact.id}/history`, abort.signal)
      .then((rows) => {
        if (!abort.signal.aborted) {
          setHistory(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => abort.abort();
  }, [fact.id, fact.revision]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="memory-editor sm:max-w-2xl">
        <header>
          <div className="memory-eyebrow">
            {fact.entityName} / {fact.kind}
          </div>
          <DialogTitle>Memory & evidence</DialogTitle>
          <DialogDescription>
            Review the source before relying on this knowledge. Verification is an explicit human or
            agent assessment.
          </DialogDescription>
        </header>
        <ScrollArea className="memory-editor-scroll">
          <div className="memory-detail">
            <p className="memory-detail-content" dir="auto">
              {fact.content}
            </p>
            <div className="memory-status-tags">
              <MemoryScopeBadge scope={fact.scope} />
              {reviewReasons(fact).map((reason) => (
                <Badge asChild variant="outline" key={reason}>
                  <span>{reason}</span>
                </Badge>
              ))}
            </div>
            <dl className="memory-evidence">
              <div>
                <dt>Source</dt>
                <dd dir="auto">{fact.source}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{Math.round(fact.confidence * 100)}% · author-assessed</dd>
              </div>
              <div>
                <dt>Last verified</dt>
                <dd>{date(fact.verifiedAt)}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{fact.expiresAt ? date(fact.expiresAt) : "No expiry"}</dd>
              </div>
              <div>
                <dt>Stable key</dt>
                <dd>{fact.key ?? "Unkeyed note"}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{date(fact.updatedAt)}</dd>
              </div>
            </dl>
            <div className="memory-inline-actions">
              <Button
                variant="outline"
                disabled={busy || fact.status === "archived"}
                onClick={() => onRevise({ verified: true })}
              >
                <Check size={14} />I verified this
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  onRevise({ status: fact.status === "archived" ? "active" : "archived" })
                }
              >
                <Archive size={14} />
                {fact.status === "archived" ? "Restore memory" : "Archive memory"}
              </Button>
            </div>
            <p className="memory-help">
              Verifying does not extend expiry or test a router. Archiving removes a memory from
              recall without deleting its history.
            </p>
            <h3 className="memory-subheading">
              <History size={16} />
              Revision history
            </h3>
            {error && (
              <p role="alert" className="memory-error">
                {error}
              </p>
            )}
            {history === null ? (
              <p>Loading history…</p>
            ) : history.length === 0 ? (
              <p className="memory-help">
                This is the first version. Future edits preserve the previous value here.
              </p>
            ) : (
              <ol className="memory-timeline">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <header>
                      <span>
                        v{entry.fact.revision} · {entry.action}
                      </span>
                      <time>{date(entry.changedAt)}</time>
                    </header>
                    <p dir="auto">{entry.fact.content}</p>
                    <small>
                      {entry.fact.source} · {Math.round(entry.fact.confidence * 100)}%
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </ScrollArea>
        <footer className="memory-dialog-actions">
          <CopyButton text={fact.content} />
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={busy} onClick={onEdit}>
            Edit memory
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function RecallLab({ entity }: { entity: string }) {
  const [query, setQuery] = useState("");
  const [related, setRelated] = useState(true);
  const [budget, setBudget] = useState("6000");
  const [result, setResult] = useState<MemoryRecall | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="memory-recall-layout">
      <form
        className="memory-recall-controls"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setResult(null);
          try {
            setResult(
              await saveMemory<MemoryRecall>("/api/memory/recall", {
                query,
                ...(entity ? { entityName: entity } : {}),
                includeRelated: related,
                maxChars: Number(budget),
              }),
            );
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="memory-eyebrow">
          <Sparkles size={14} /> RECALL LENS
        </div>
        <h2>What does your MCP know?</h2>
        <p>Preview the exact context available for a task. No model request. No router commands.</p>
        <label className="memory-field">
          <span>Task or search terms</span>
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setResult(null);
            }}
            maxLength={500}
            placeholder="WireGuard MTU, WAN, backup policy…"
          />
        </label>
        <div className="memory-scope">
          <Network size={15} />
          <span>{entity || "All knowledge"}</span>
          <small>
            {entity
              ? "Includes Shared + explicit Groups + this Device."
              : "Select a device in the library to preview inherited policy."}
          </small>
        </div>
        <label className="memory-pin-field">
          <Switch
            checked={related}
            onCheckedChange={(value) => {
              setRelated(value);
              setResult(null);
            }}
            aria-label="Include related entities"
          />
          <span>
            Include related entities
            <small>Reference only. Shared/group policy is always included.</small>
          </span>
        </label>
        <MemorySelect
          label="Context budget"
          value={budget}
          onChange={(v) => {
            setBudget(v);
            setResult(null);
          }}
          options={[
            { value: "3000", label: "Compact · 3,000 characters" },
            { value: "6000", label: "Balanced · 6,000 characters" },
            { value: "16000", label: "Detailed · 16,000 characters" },
          ]}
        />
        <Button disabled={busy} type="submit">
          <Search size={15} />
          {busy ? "Recalling…" : "Preview context"}
        </Button>
        {error && (
          <p role="alert" className="memory-error">
            {error}
          </p>
        )}
      </form>
      <div className="memory-recall-result" aria-live="polite">
        {result ? (
          <>
            <header>
              <h3>{result.items.length} memories selected</h3>
              <CopyButton text={result.context} />
            </header>
            {result.warnings.map((warning) => (
              <p className="memory-warning" key={warning}>
                {warning}
              </p>
            ))}
            <ScrollArea className="memory-context-scroll">
              <div className="memory-status-tags" aria-label="Applicable memory scopes">
                {result.applicableScopes?.map((scope) => (
                  <span key={scope.entityName}>
                    <MemoryScopeBadge scope={scope.scope} /> {scope.entityName}
                  </span>
                ))}
              </div>
              {!!result.conflicts?.length && (
                <section className="memory-conflicts" aria-label="Conflicting memories">
                  <h4>Resolve before applying · {result.conflicts.length} conflicting keys</h4>
                  {result.conflicts.map((conflict) => (
                    <p key={conflict.key}>
                      <code>{conflict.key}</code> —{" "}
                      {conflict.memories
                        .map((m) => `#${m.id} ${m.entityName} (${m.scope})`)
                        .join(" ↔ ")}
                    </p>
                  ))}
                  <p>
                    No scope wins automatically. Open these records in the library and verify the
                    source.
                  </p>
                </section>
              )}
              <div className="memory-context-results">
                {result.items.map((fact) => (
                  <article key={fact.id}>
                    <header>
                      <code>#{fact.id}</code>
                      <strong>{fact.entityName}</strong>
                      <MemoryScopeBadge scope={fact.scope} />
                      <Badge asChild variant="outline">
                        <span>{fact.kind}</span>
                      </Badge>
                    </header>
                    <p dir="auto">{fact.content}</p>
                    <div className="memory-status-tags">
                      {fact.reasons.map((reason) => (
                        <span key={reason}>{reason}</span>
                      ))}
                    </div>
                  </article>
                ))}
                {!result.items.length && (
                  <Empty title="No matching knowledge">
                    Try a different term, select another entity, or add a memory.
                  </Empty>
                )}
              </div>
            </ScrollArea>
            <details className="memory-raw-context">
              <summary>
                Exact LLM context · {result.context.length.toLocaleString()} characters
              </summary>
              <ScrollArea className="memory-context-scroll">
                <pre>{result.context}</pre>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </details>
          </>
        ) : (
          <Empty title="Relevant context, not the entire database">
            Full-text matching prioritizes pinned constraints and explains each result. Archived and
            expired memories stay out.
          </Empty>
        )}
      </div>
    </div>
  );
}

function MemorySettings({ config, onSaved }: { config: MemoryConfig; onSaved: () => void }) {
  const [path, setPath] = useState(config.dbPath);
  const [enabled, setEnabled] = useState(config.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="memory-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await saveMemory("/api/memory/config", { dbPath: path, enabled });
          onSaved();
          toast.success("Memory settings saved");
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Database size={26} />
      <h2>Private by design.</h2>
      <p>
        Knowledge stays in SQLite on this MCP host. No embeddings API, cloud sync or external model
        is required.
      </p>
      <label className="memory-pin-field">
        <Switch
          disabled={busy}
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Enable knowledge memory"
        />
        <span>
          Enable knowledge memory<small>Disabling keeps stored data but stops memory access.</small>
        </span>
      </label>
      <label className="memory-field">
        <span>Database path</span>
        <Input required value={path} disabled={busy} onChange={(e) => setPath(e.target.value)} />
      </label>
      <p className="memory-warning">
        Changing the path opens a different database; it does not move your existing knowledge.
        Reconnect MCP clients after changing enablement so their instructions refresh.
      </p>
      {error && (
        <p className="memory-error" role="alert">
          {error}
        </p>
      )}
      <Button disabled={busy || (path === config.dbPath && enabled === config.enabled)}>
        {busy ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}

export function MemoryView() {
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [summary, setSummary] = useState<{ stats: MemoryStats; health: MemoryHealth } | null>(null);
  const [entities, setEntities] = useState<{ items: Entity[]; total: number }>({
    items: [],
    total: 0,
  });
  const [entity, setEntity] = useState("");
  const [entitySearch, setEntitySearch] = useState("");
  const [entityOffset, setEntityOffset] = useState(0);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [state, setState] = useState<BrowseInput["state"]>("active");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [activity, setActivity] = useState<MemoryActivityEntry[]>([]);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState("library");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<MemoryFact | "new" | null>(null);
  const [detail, setDetail] = useState<MemoryFact | null>(null);
  const [entityEditor, setEntityEditor] = useState<"new" | "relation" | null>(null);
  const [creatingPolicy, setCreatingPolicy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const search = useDelayedText(query);
  const subjectSearch = useDelayedText(entitySearch);
  const refresh = () => setVersion((v) => v + 1);
  const selectEntity = (name: string) => {
    setEntity(name);
    setOffset(0);
    setDetail(null);
  };
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setVersion((v) => v + 1);
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const load = async () => {
      try {
        const cfg = await api<MemoryConfig>("/api/memory/config", abort.signal);
        if (abort.signal.aborted) return;
        setConfig(cfg);
        if (!cfg.enabled) {
          setSummary(null);
          setPage(null);
          return;
        }
        const params = new URLSearchParams({
          query: search,
          state,
          limit: "24",
          offset: String(offset),
        });
        if (entity) params.set("entityName", entity);
        if (kind !== "all") params.set("kind", kind);
        if (scopeFilter !== "all") params.set("scope", scopeFilter);
        const [nextSummary, nextPage, nextEntities, nextActivity, selected] = await Promise.all([
          api<{ stats: MemoryStats; health: MemoryHealth }>("/api/memory/summary", abort.signal),
          api<MemoryPage>(`/api/memory/facts?${params}`, abort.signal),
          api<{ items: Entity[]; total: number }>(
            `/api/memory/entities?q=${encodeURIComponent(subjectSearch)}&limit=50&offset=${entityOffset}`,
            abort.signal,
          ),
          api<MemoryActivityEntry[]>(
            "/api/memory/activity?limit=50&changesOnly=true",
            abort.signal,
          ),
          entity
            ? api<{ relations: Relation[] }>(
                `/api/memory/entity/${encodeURIComponent(entity)}`,
                abort.signal,
              )
            : Promise.resolve({ relations: [] }),
        ]);
        if (abort.signal.aborted) return;
        setSummary(nextSummary);
        setPage(nextPage);
        setEntities(nextEntities);
        setActivity(nextActivity);
        setRelations(selected.relations);
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(message(e));
          setPage(null);
        }
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => abort.abort();
  }, [search, state, kind, scopeFilter, offset, entity, subjectSearch, entityOffset, version]);
  const revise = async (fact: MemoryFact, patch: object) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await saveMemory<MemoryFact>("/api/memory/facts/revise", {
        id: fact.id,
        expectedRevision: fact.revision,
        ...patch,
      });
      setDetail((current) => (current?.id === next.id ? next : current));
      refresh();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="memory-workspace">
      <header className="memory-brief">
        <div>
          <div className="memory-eyebrow">
            <Brain size={15} /> NETWORK KNOWLEDGE
          </div>
          <h2>
            A memory worth
            <br />
            <span>building on.</span>
          </h2>
          <p>
            Keep the facts. Preserve the lessons.
            <br />
            Give every next decision a better starting point.
          </p>
        </div>
        <div className="memory-brief-right">
          <div className="memory-local">
            <ShieldCheck size={16} />
            <span>On your host. In your control.</span>
          </div>
          <p>Sources, revisions and freshness — visible by design.</p>
          <div className="memory-inline-actions">
            <Button disabled={!config?.enabled} onClick={() => setEditor("new")}>
              <Plus size={15} />
              Add memory
            </Button>
            <Button variant="outline" disabled={loading} onClick={refresh}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
        </div>
      </header>
      <div className="memory-health" aria-label="Memory quality">
        {[
          {
            key: "active",
            label: "Ready for recall",
            value: summary?.health.active,
            icon: BookOpen,
            target: "active",
          },
          {
            key: "review",
            label: "Need your review",
            value: summary?.health.review,
            icon: CircleHelp,
            target: "review",
          },
          {
            key: "pinned",
            label: "Pinned memories",
            value: summary?.health.pinned,
            icon: Pin,
            target: "pinned",
          },
          {
            key: "archived",
            label: "Safely archived",
            value: summary?.health.archived,
            icon: Archive,
            target: "archived",
          },
        ].map(({ key, label, value, icon: Icon, target }) => (
          <button
            key={key}
            data-tone={key}
            onClick={() => {
              setState(target as BrowseInput["state"]);
              setOffset(0);
              setTab("library");
            }}
          >
            <Icon size={18} />
            <span>{label}</span>
            <strong>{value ?? "—"}</strong>
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="memory-error">
          {error}{" "}
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      {config && !config.enabled && (
        <p className="memory-warning">
          Knowledge memory is disabled. Your stored data is preserved; enable it in Settings to
          continue.
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <ScrollArea className="memory-tabs-scroll">
          <TabsList>
            <TabsTrigger value="library">
              <BookOpen size={15} />
              Knowledge library
            </TabsTrigger>
            <TabsTrigger value="recall" disabled={!config?.enabled}>
              <Sparkles size={15} />
              Recall lab
            </TabsTrigger>
            <TabsTrigger value="activity" disabled={!config?.enabled}>
              <History size={15} />
              Activity
            </TabsTrigger>
            <TabsTrigger value="sharing" disabled={!config?.enabled}>
              <Globe2 size={15} />
              Shared memory
            </TabsTrigger>
            <TabsTrigger value="settings">
              <SlidersHorizontal size={15} />
              Settings
            </TabsTrigger>
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        <TabsContent value="library">
          <div className="memory-library">
            <aside className="memory-index">
              <header>
                <span>ENTITIES</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!config?.enabled}
                  aria-label="Create entity"
                  onClick={() => setEntityEditor("new")}
                >
                  <Plus size={15} />
                </Button>
              </header>
              <Input
                aria-label="Find entities"
                value={entitySearch}
                onChange={(e) => {
                  setEntitySearch(e.target.value);
                  setEntityOffset(0);
                }}
                placeholder="Find an entity…"
              />
              <button
                className="memory-subject"
                data-selected={!entity}
                onClick={() => selectEntity("")}
              >
                <Network size={16} />
                <span>
                  All knowledge<small>{summary?.stats.entities ?? "—"} entities</small>
                </span>
              </button>
              <ScrollArea className="memory-index-scroll">
                <div>
                  {entities.items.map((item) => (
                    <button
                      className="memory-subject"
                      data-selected={entity === item.name}
                      key={item.name}
                      onClick={() => selectEntity(item.name)}
                    >
                      <span className="memory-node-dot" />
                      <span>
                        {item.name}
                        <small>{item.entityType}</small>
                        <MemoryScopeBadge scope={item.memoryScope} />
                      </span>
                      <ChevronRight size={12} />
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {entities.total > 50 && (
                <div className="memory-page-controls">
                  <Button
                    aria-label="Previous entities"
                    size="icon-sm"
                    variant="ghost"
                    disabled={entityOffset === 0}
                    onClick={() => setEntityOffset((v) => Math.max(0, v - 50))}
                  >
                    <ChevronLeft />
                  </Button>
                  <small>
                    {entityOffset + 1}–{Math.min(entityOffset + 50, entities.total)} /{" "}
                    {entities.total}
                  </small>
                  <Button
                    aria-label="Next entities"
                    size="icon-sm"
                    variant="ghost"
                    disabled={entityOffset + 50 >= entities.total}
                    onClick={() => setEntityOffset((v) => v + 50)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              )}
              <p className="memory-index-note">
                <ShieldCheck size={16} />
                Memory is context, never permission to change a router.
              </p>
            </aside>
            <section className="memory-library-main" aria-label="Knowledge library">
              <header className="memory-section-header">
                <div>
                  <h3>{entity || "All knowledge"}</h3>
                  <p>
                    {state === "review"
                      ? "Unverified, expired, low-confidence or not reviewed in 90 days."
                      : "One useful idea per memory, with evidence you can inspect."}
                  </p>
                </div>
                {entity && (
                  <div className="memory-inline-actions">
                    <Button size="sm" variant="outline" onClick={() => setTab("sharing")}>
                      <Globe2 size={14} />
                      Sharing scope
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEntityEditor("relation")}>
                      <Link2 size={14} />
                      Link
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete selected entity"
                      onClick={() => setDeleting(true)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </header>
              {entity && (
                <div className="memory-neighborhood">
                  <div className="memory-neighborhood-anchor">
                    <Network size={15} />
                    <strong>{entity}</strong>
                  </div>
                  {relations.length ? (
                    relations.slice(0, 12).map((relation) => (
                      <button
                        key={`${relation.from}:${relation.relationType}:${relation.to}`}
                        onClick={() =>
                          selectEntity(relation.from === entity ? relation.to : relation.from)
                        }
                      >
                        <small>
                          {relation.from === entity ? "→" : "←"} {relation.relationType}
                        </small>
                        <span>{relation.from === entity ? relation.to : relation.from}</span>
                      </button>
                    ))
                  ) : (
                    <p>No relationships yet. Link this entity to enrich scoped recall.</p>
                  )}
                  {relations.length > 12 && <small>+{relations.length - 12} more relations</small>}
                </div>
              )}
              <div className="memory-filters">
                <MemorySelect
                  label="Scope"
                  value={scopeFilter}
                  onChange={(value) => {
                    setScopeFilter(value);
                    setOffset(0);
                  }}
                  options={[
                    { value: "all", label: "All scopes" },
                    { value: "device", label: "Device" },
                    { value: "group", label: "Group" },
                    { value: "shared", label: "Shared" },
                  ]}
                />
                <label className="memory-field">
                  <span>Search knowledge</span>
                  <Input
                    aria-label="Search knowledge"
                    value={query}
                    maxLength={500}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOffset(0);
                    }}
                    placeholder="Find facts, lessons or constraints…"
                  />
                </label>
                <MemorySelect
                  label="Kind"
                  value={kind}
                  onChange={(v) => {
                    setKind(v);
                    setOffset(0);
                  }}
                  options={[
                    { value: "all", label: "All kinds" },
                    ...memoryKinds.map((value) => ({ value, label: value })),
                  ]}
                />
                <MemorySelect
                  label="Status"
                  value={state}
                  onChange={(v) => {
                    setState(v as BrowseInput["state"]);
                    setOffset(0);
                  }}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "review", label: "Needs review" },
                    { value: "pinned", label: "Pinned" },
                    { value: "archived", label: "Archived" },
                    { value: "all", label: "All records" },
                  ]}
                />
              </div>
              <div className="memory-results-meta" aria-live="polite">
                <span>
                  {loading
                    ? "Refreshing knowledge…"
                    : page
                      ? `${page.total} matching memories`
                      : "Knowledge unavailable"}
                </span>
                <span>30s refresh · local only</span>
              </div>
              <div className="memory-fact-grid" aria-busy={loading}>
                {!loading && page?.items.length === 0 ? (
                  <Empty title="Room for useful knowledge">
                    {query
                      ? "No matches. Try another search or clear your filters."
                      : "Create an entity, then add facts, constraints and lessons you want the MCP to remember."}
                  </Empty>
                ) : (
                  page?.items.map((fact) => (
                    <FactCard
                      fact={fact}
                      key={fact.id}
                      busy={busy || loading}
                      onOpen={() => setDetail(fact)}
                      onRevise={(patch) => void revise(fact, patch)}
                    />
                  ))
                )}
              </div>
              {page && page.total > 24 && (
                <div className="memory-page-controls">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0 || loading}
                    onClick={() => setOffset((v) => Math.max(0, v - 24))}
                  >
                    <ChevronLeft size={14} />
                    Previous
                  </Button>
                  <span>
                    {offset + 1}–{Math.min(offset + 24, page.total)} of {page.total}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + 24 >= page.total || loading}
                    onClick={() => setOffset((v) => v + 24)}
                  >
                    Next
                    <ChevronRight size={14} />
                  </Button>
                </div>
              )}
            </section>
          </div>
        </TabsContent>
        <TabsContent value="recall">
          <RecallLab key={entity} entity={entity} />
        </TabsContent>
        <TabsContent value="sharing">
          <MemorySharing
            key={entity}
            entity={entity}
            refreshVersion={version}
            entities={entities.items}
            onSelect={selectEntity}
            onCreate={() => {
              setCreatingPolicy(true);
              setEntityEditor("new");
            }}
            onSaved={refresh}
          />
        </TabsContent>
        <TabsContent value="activity">
          <section className="memory-activity">
            <header className="memory-section-header">
              <div>
                <h3>A trace of what changed.</h3>
                <p>Recent knowledge changes. Routine tool calls stay out of this timeline.</p>
              </div>
              <Clock3 size={20} />
            </header>
            <ScrollArea className="memory-activity-scroll">
              <ol className="memory-timeline">
                {activity.map((entry) => (
                  <li key={entry.id}>
                    <header>
                      <Badge asChild variant="outline">
                        <span>{entry.action.replaceAll("_", " ")}</span>
                      </Badge>
                      <time>{date(entry.ts)}</time>
                    </header>
                    <p>{entry.subject}</p>
                  </li>
                ))}
              </ol>
            </ScrollArea>
            {!activity.length && (
              <Empty title="No activity yet">Memory changes will appear here.</Empty>
            )}
          </section>
        </TabsContent>
        <TabsContent value="settings">
          {config ? (
            <MemorySettings
              key={`${config.dbPath}:${config.enabled}`}
              config={config}
              onSaved={refresh}
            />
          ) : (
            <Empty title="Settings unavailable">
              Retry loading to inspect memory configuration.
            </Empty>
          )}
        </TabsContent>
      </Tabs>
      {editor && (
        <MemoryEditor
          fact={editor === "new" ? undefined : editor}
          entityName={entity}
          onClose={() => setEditor(null)}
          onSaved={refresh}
        />
      )}
      {detail && !editor && (
        <FactDetail
          fact={detail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditor(detail);
            setDetail(null);
          }}
          onRevise={(patch) => void revise(detail, patch)}
          busy={busy}
        />
      )}
      {entityEditor && (
        <EntityEditor
          from={entityEditor === "relation" ? entity : undefined}
          initialType={creatingPolicy ? "policy" : undefined}
          onClose={() => {
            setEntityEditor(null);
            setCreatingPolicy(false);
          }}
          onSaved={(name) => {
            if (creatingPolicy && name) {
              selectEntity(name);
              setTab("sharing");
            }
            refresh();
          }}
        />
      )}
      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete {entity}?</DialogTitle>
          <DialogDescription>
            This permanently removes the entity, all its memories and revision history, and its
            relations. No router configuration is changed. Archive individual memories instead if
            you may need them again.
          </DialogDescription>
          <div className="memory-inline-actions">
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await deleteJson<{ removed?: number; error?: string }>(
                    "/api/memory/entities",
                    { names: [entity] },
                  );
                  if (result.error || result.removed === undefined)
                    throw new Error(result.error ?? "Deletion not confirmed");
                  setDeleting(false);
                  selectEntity("");
                  refresh();
                } catch (e) {
                  toast.error(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
