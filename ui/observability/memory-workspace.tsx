import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Archive,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  GitBranch,
  History,
  Layers,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Users,
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
import { DetailList, Field, RowDrawer, RowMenu, RowMore, TextInput } from "./kit";
import type { RowDrawerProps, RowMenuProps } from "./kit";
import { EntityEditor, MemoryEditor, MemorySelect, saveMemory } from "./memory-editors";
import { GRAPH_LIMIT, RelationGraph } from "./memory-graph";
import { MemorySharing, MemoryScopeBadge, scopeLabel } from "./memory-sharing";
import {
  Donut,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  MonitorSelect,
  MonitorSwitch,
  MonitorTabs,
  PageIntro,
  Segmented,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import "./monitoring.css";
import "./memory-workspace.css";

const date = (value: number | null) => (value ? new Date(value).toLocaleString() : "Not verified");
const message = (e: unknown) => (e instanceof Error ? e.message : "Memory request failed");
const DAY = 86_400_000;

/** "3 days ago", "1 month ago", "never". */
function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const days = Math.floor((now - ts) / DAY);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years <= 1 ? "1 year ago" : `${years} years ago`;
}

/** "in 78 days", "expired", "never". */
function until(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  if (ts <= now) return "expired";
  const days = Math.ceil((ts - now) / DAY);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

/** Memory kinds reuse the risk pill: constraints pink, lessons amber, facts indigo. */
const KIND_RISK: Record<string, string> = {
  constraint: "destructive",
  lesson: "write",
  fact: "idem",
};

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="monitor-risk" data-risk={KIND_RISK[kind] ?? "read"}>
      {kind.toUpperCase()}
    </span>
  );
}

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
    <MonitorEmpty icon={<BookOpen />} title={title}>
      {children}
    </MonitorEmpty>
  );
}

function FactCard({
  fact,
  selected,
  onOpen,
  onRevise,
  busy,
  menu,
}: {
  fact: MemoryFact;
  selected: boolean;
  onOpen: () => void;
  onRevise: (patch: object) => void;
  busy: boolean;
  /** The card's row menu: cells, copies and actions. */
  menu: Omit<RowMenuProps, "children" | "title" | "onOpen">;
}) {
  const reasons = reviewReasons(fact);
  const pct = Math.round(fact.confidence * 100);
  const confTone = pct >= 70 ? "good" : pct >= 40 ? "warn" : "bad";
  return (
    <RowMenu title={`Memory #${fact.id}`} onOpen={onOpen} {...menu}>
      <article className="memory-fact" data-kind={fact.kind} data-selected={selected || undefined}>
        <header className="flex min-w-0 flex-wrap items-center gap-2">
          <span data-col="kind" className="contents">
            <KindBadge kind={fact.kind} />
          </span>
          <span data-col="scope" className="contents">
            <MemoryScopeBadge scope={fact.scope} />
          </span>
          {fact.key && (
            <span data-col="key" className="monitor-chip">
              {fact.key}
            </span>
          )}
          <span className="flex-1" />
          {fact.status === "archived" ? (
            <StatusBadge dot={false}>Archived</StatusBadge>
          ) : (
            reasons.length > 0 && (
              <StatusBadge tone="warn" dot={false}>
                Needs review · {reasons[0].toLowerCase()}
              </StatusBadge>
            )
          )}
          <button
            type="button"
            className="memory-pin"
            data-pinned={fact.pinned || undefined}
            title={fact.pinned ? "Unpin memory" : "Pin memory"}
            aria-label={fact.pinned ? "Unpin memory" : "Pin memory"}
            aria-pressed={fact.pinned}
            disabled={busy}
            onClick={() => onRevise({ pinned: !fact.pinned })}
          >
            <Pin aria-hidden="true" />
            {fact.pinned && "Pinned"}
          </button>
          <RowMore />
        </header>
        <button type="button" className="memory-fact-content" onClick={onOpen}>
          <span dir="auto">
            {fact.content.length > 360 ? `${fact.content.slice(0, 360)}…` : fact.content}
          </span>
          <span className="sr-only">Open memory {fact.id}</span>
        </button>
        <div className="memory-fact-meta">
          <span data-col="source" className="truncate" title={fact.source}>
            Source <span className="font-mono text-fg-secondary">{fact.source}</span>
          </span>
          <span className="monitor-meter">
            Confidence
            <span className="monitor-bar" aria-hidden="true">
              <span data-tone={confTone} style={{ width: `${pct}%` }} />
            </span>
            <span>{pct}%</span>
          </span>
          <span>
            Verified <span className="text-fg-secondary">{ago(fact.verifiedAt)}</span>
          </span>
          <span>
            Expires <span className="text-fg-secondary">{until(fact.expiresAt)}</span>
          </span>
        </div>
      </article>
    </RowMenu>
  );
}

function FactDetail({
  fact,
  onClose,
  onEdit,
  onRevise,
  onNextReview,
  busy,
  nav,
}: {
  fact: MemoryFact;
  /** Previous and next memory on this page. */
  nav?: RowDrawerProps["nav"];
  onClose: () => void;
  onEdit: () => void;
  onRevise: (patch: object) => Promise<MemoryFact | undefined>;
  onNextReview?: (reviewedIds: number[]) => Promise<void>;
  busy: boolean;
}) {
  const [history, setHistory] = useState<MemoryRevision[] | null>(null);
  const [error, setError] = useState("");
  const [reviewedIds, setReviewedIds] = useState<number[]>([]);
  const [pendingNext, setPendingNext] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [nextError, setNextError] = useState("");
  const contentRef = useRef<HTMLParagraphElement>(null);
  const working = busy || advancing;
  useEffect(() => {
    const id = requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
    contentRef.current?.focus({ preventScroll: true });
    return () => cancelAnimationFrame(id);
  }, [fact.id]);
  const verify = async () => {
    if (working) return;
    setAdvancing(true);
    try {
      let reviewed = reviewedIds;
      if (!pendingNext) {
        const saved = await onRevise({ verified: true });
        if (!saved || !onNextReview) return;
        reviewed = [...reviewedIds, saved.id];
        setReviewedIds(reviewed);
        setPendingNext(true);
      }
      await onNextReview?.(reviewed);
      setPendingNext(false);
      setNextError("");
    } catch (e) {
      setNextError(message(e));
    } finally {
      setAdvancing(false);
    }
  };
  const verifyAction = (
    <MonitorButton
      variant={onNextReview ? "primary" : "glass"}
      disabled={working || fact.status === "archived"}
      onClick={() => void verify()}
      icon={
        working ? (
          <RefreshCw aria-hidden="true" className="animate-spin" />
        ) : (
          <Check aria-hidden="true" />
        )
      }
    >
      {pendingNext ? "Retry next memory" : onNextReview ? "Verify & next" : "I verified this"}
    </MonitorButton>
  );
  const historyKey = `${fact.id}:${fact.revision}`;
  const [loadedHistory, setLoadedHistory] = useState(historyKey);
  if (loadedHistory !== historyKey) {
    setLoadedHistory(historyKey);
    setHistory(null);
    setError("");
  }
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
    <RowDrawer
      open
      onClose={() => {
        if (!working) onClose();
      }}
      label={`Memory details: #${fact.id}`}
      status={
        fact.status === "archived"
          ? { tone: "off", label: "Archived" }
          : reviewReasons(fact).length
            ? { tone: "warn", label: "Needs review" }
            : { tone: "ok", label: "Ready for recall" }
      }
      title="Memory & evidence"
      meta={`${fact.entityName} / ${fact.kind}`}
      nav={working ? undefined : nav}
      rowKey={fact.id}
      storageKey="memory-facts"
      actions={<CopyButton text={fact.content} />}
      primary={
        <>
          <MonitorButton variant="ghost" disabled={working} onClick={onClose}>
            Close
          </MonitorButton>
          <MonitorButton
            variant={onNextReview ? "glass" : "primary"}
            disabled={working}
            onClick={onEdit}
          >
            Edit memory
          </MonitorButton>
          {onNextReview && verifyAction}
        </>
      }
    >
      <div key={fact.id} className="memory-detail">
        <p className="monitor-hint">
          Review the source before relying on this knowledge. Verification is an explicit human or
          agent assessment.
        </p>
        {onNextReview && (
          <p className="monitor-hint" role="status">
            {reviewedIds.length} verified this round · Next memory opens automatically.
          </p>
        )}
        <p ref={contentRef} tabIndex={-1} className="memory-detail-content" dir="auto">
          {fact.content}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={fact.kind} />
          <MemoryScopeBadge scope={fact.scope} />
          {reviewReasons(fact).map((reason) => (
            <StatusBadge key={reason} tone="warn" dot={false}>
              {reason}
            </StatusBadge>
          ))}
        </div>
        <dl className="monitor-facts">
          <dt>Source</dt>
          <dd dir="auto" className="font-mono">
            {fact.source}
          </dd>
          <dt>Confidence</dt>
          <dd>{Math.round(fact.confidence * 100)}% · author-assessed</dd>
          <dt>Last verified</dt>
          <dd>{date(fact.verifiedAt)}</dd>
          <dt>Expires</dt>
          <dd>{fact.expiresAt ? date(fact.expiresAt) : "No expiry"}</dd>
          <dt>Stable key</dt>
          <dd className={fact.key ? "font-mono" : undefined}>{fact.key ?? "Unkeyed note"}</dd>
          <dt>Updated</dt>
          <dd>{date(fact.updatedAt)}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          {!onNextReview && verifyAction}
          <MonitorButton
            disabled={working || pendingNext}
            icon={<Archive aria-hidden="true" />}
            onClick={() => onRevise({ status: fact.status === "archived" ? "active" : "archived" })}
          >
            {fact.status === "archived" ? "Restore memory" : "Archive memory"}
          </MonitorButton>
        </div>
        {nextError && (
          <MonitorNote tone="bad" role="alert">
            Verification saved. Could not load the next memory: {nextError} Retry does not verify
            this memory again.
          </MonitorNote>
        )}
        <p className="monitor-hint">
          Verifying does not extend expiry or test a router. Archiving removes a memory from recall
          without deleting its history.
        </p>
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <History aria-hidden="true" className="size-3.5" />
          Revision history
        </h3>
        {error && (
          <MonitorNote tone="bad" role="alert">
            {error}
          </MonitorNote>
        )}
        {history === null ? (
          <p className="monitor-hint">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="monitor-hint">
            This is the first version. Future edits preserve the previous value here.
          </p>
        ) : (
          <ol className="memory-timeline">
            {history.map((entry) => (
              <li key={entry.id}>
                <header>
                  <span className="monitor-chip">
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
    </RowDrawer>
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
    <div className="grid min-w-0 items-start gap-3.5 lg:grid-cols-[340px_minmax(0,1fr)]">
      <MonitorPanel
        title="What does your MCP know?"
        description="Preview the exact context available for a task. No model request. No router commands."
      >
        <form
          className="flex flex-col gap-3.5"
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
          <Field label="Task or search terms">
            <TextInput
              label="Task or search terms"
              value={query}
              onChange={(v) => {
                setQuery(v);
                setResult(null);
              }}
              maxLength={500}
              placeholder="WireGuard MTU, WAN, backup policy…"
            />
          </Field>
          <MonitorNote icon={<Server aria-hidden="true" />}>
            <b>{entity || "All knowledge"}.</b>{" "}
            {entity
              ? "Includes Shared + explicit Groups + this Device."
              : "Select a device in the library to preview inherited policy."}
          </MonitorNote>
          <SwitchRow
            title="Include related entities"
            sub="Reference only. Shared/group policy is always included."
            checked={related}
            onChange={(value) => {
              setRelated(value);
              setResult(null);
            }}
          />
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
          <MonitorButton
            variant="primary"
            disabled={busy}
            type="submit"
            icon={<Search aria-hidden="true" />}
          >
            {busy ? "Recalling…" : "Preview context"}
          </MonitorButton>
          {error && (
            <MonitorNote tone="bad" role="alert">
              {error}
            </MonitorNote>
          )}
        </form>
      </MonitorPanel>
      <div aria-live="polite" className="min-w-0">
        {result ? (
          <MonitorPanel
            title={`${result.items.length} memories selected`}
            description="Relevant context, not the entire database."
            extra={<CopyButton text={result.context} />}
          >
            <div className="flex flex-col gap-3">
              {result.warnings.map((warning) => (
                <MonitorNote tone="warn" key={warning}>
                  {warning}
                </MonitorNote>
              ))}
              {!!result.applicableScopes?.length && (
                <div className="flex flex-wrap gap-2" aria-label="Applicable memory scopes">
                  {result.applicableScopes.map((scope) => (
                    <span key={scope.entityName} className="inline-flex items-center gap-1.5">
                      <MemoryScopeBadge scope={scope.scope} />
                      <span className="font-mono text-xs text-fg-secondary">
                        {scope.entityName}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              {!!result.conflicts?.length && (
                <MonitorNote tone="bad">
                  <section aria-label="Conflicting memories" className="flex flex-col gap-1">
                    <b>Resolve before applying · {result.conflicts.length} conflicting keys</b>
                    {result.conflicts.map((conflict) => (
                      <span key={conflict.key}>
                        <code className="font-mono">{conflict.key}</code> —{" "}
                        {conflict.memories
                          .map((m) => `#${m.id} ${m.entityName} (${m.scope})`)
                          .join(" ↔ ")}
                      </span>
                    ))}
                    <span>
                      No scope wins automatically. Open these records in the library and verify the
                      source.
                    </span>
                  </section>
                </MonitorNote>
              )}
              <div className="flex flex-col gap-2.5">
                {result.items.map((fact) => (
                  <article key={fact.id} className="memory-fact">
                    <header className="flex flex-wrap items-center gap-2">
                      <KindBadge kind={fact.kind} />
                      <MemoryScopeBadge scope={fact.scope} />
                      <span className="font-mono text-xs text-fg-secondary">
                        #{fact.id} {fact.entityName}
                      </span>
                    </header>
                    <p dir="auto" className="text-sm text-foreground">
                      {fact.content}
                    </p>
                    {fact.reasons.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {fact.reasons.map((reason) => (
                          <span key={reason} className="monitor-chip">
                            {reason}
                          </span>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
                {!result.items.length && (
                  <Empty title="No matching knowledge">
                    Try a different term, select another entity, or add a memory.
                  </Empty>
                )}
              </div>
              <details className="memory-raw-context">
                <summary>
                  Exact LLM context · {result.context.length.toLocaleString()} characters
                </summary>
                <pre className="monitor-pre mt-2 max-h-[420px] overflow-auto">{result.context}</pre>
              </details>
            </div>
          </MonitorPanel>
        ) : (
          <MonitorPanel title="Recall preview">
            <Empty title="Relevant context, not the entire database">
              Full-text matching prioritizes pinned constraints and explains each result. Archived
              and expired memories stay out.
            </Empty>
          </MonitorPanel>
        )}
      </div>
    </div>
  );
}

function SwitchRow({
  title,
  sub,
  checked,
  onChange,
  disabled,
  label,
}: {
  title: string;
  sub: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5">
        <MonitorSwitch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          label={label ?? title}
        />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="text-[13px] font-semibold text-foreground">{title}</b>
        <span className="monitor-hint">{sub}</span>
      </span>
    </div>
  );
}

function MemorySettings({ config, onSaved }: { config: MemoryConfig; onSaved: () => void }) {
  const [path, setPath] = useState(config.dbPath);
  const [enabled, setEnabled] = useState(config.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <MonitorPanel
      title="Private by design."
      description="Knowledge stays in SQLite on this MCP host. No embeddings API, cloud sync or external model is required."
      className="max-w-[680px]"
    >
      <form
        className="flex flex-col gap-3.5"
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
        <SwitchRow
          title="Enable knowledge memory"
          sub="Disabling keeps stored data but stops memory access."
          checked={enabled}
          onChange={setEnabled}
          disabled={busy}
        />
        <Field label="Database path">
          <TextInput
            label="Database path"
            mono
            required
            value={path}
            disabled={busy}
            onChange={setPath}
          />
        </Field>
        <MonitorNote tone="warn">
          Changing the path opens a different database; it does not move your existing knowledge.
          Reconnect MCP clients after changing enablement so their instructions refresh.
        </MonitorNote>
        {error && (
          <MonitorNote tone="bad" role="alert">
            {error}
          </MonitorNote>
        )}
        <div>
          <MonitorButton
            variant="primary"
            type="submit"
            disabled={busy || (path === config.dbPath && enabled === config.enabled)}
            icon={<Check aria-hidden="true" />}
          >
            {busy ? "Saving…" : "Save settings"}
          </MonitorButton>
        </div>
      </form>
    </MonitorPanel>
  );
}

const ENTITY_ICON: Record<string, typeof Server> = {
  router: Server,
  device: Server,
  policy: ShieldCheck,
};

type StateFilter = BrowseInput["state"];

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "review", label: "Needs review" },
  { value: "pinned", label: "Pinned" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

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
  const [state, setState] = useState<StateFilter>("active");
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
  const [activityOpen, setActivityOpen] = useState<number>();
  const search = useDelayedText(query);
  const subjectSearch = useDelayedText(entitySearch);
  const requestKey = JSON.stringify([
    search,
    state,
    kind,
    scopeFilter,
    offset,
    entity,
    subjectSearch,
    entityOffset,
    version,
  ]);
  const [loadedKey, setLoadedKey] = useState(requestKey);
  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey);
    setLoading(true);
    setError("");
  }
  const refresh = () => setVersion((v) => v + 1);
  const selectEntity = (name: string) => {
    setEntity(name);
    setOffset(0);
    setDetail(null);
  };
  const showState = (next: StateFilter) => {
    setState(next);
    setOffset(0);
    setTab("library");
  };
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setVersion((v) => v + 1);
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
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
      return next;
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const nextReview = async (reviewedIds: number[]) => {
    const reviewed = new Set(reviewedIds);
    const items = page?.items ?? [];
    const currentIndex = items.findIndex((fact) => fact.id === detail?.id);
    // Keep the visible card order, wrapping to earlier cards before leaving this page.
    const remaining = (
      currentIndex < 0 ? items : [...items.slice(currentIndex + 1), ...items.slice(0, currentIndex)]
    ).find(
      (fact) => !reviewed.has(fact.id) && fact.status === "active" && reviewReasons(fact).length,
    );
    if (remaining) {
      setDetail(remaining);
      return;
    }
    const params = new URLSearchParams({ query: search, state: "review", limit: "100" });
    if (entity) params.set("entityName", entity);
    if (kind !== "all") params.set("kind", kind);
    if (scopeFilter !== "all") params.set("scope", scopeFilter);
    // Verification shrinks/reorders the review list. Re-read from the start at page boundaries
    // and skip this round's verified IDs (expired/low-confidence records can remain in review).
    for (let cursor = 0; ; cursor += 100) {
      params.set("offset", String(cursor));
      const candidates = await api<MemoryPage>(`/api/memory/facts?${params}`);
      const next = candidates.items.find((fact) => !reviewed.has(fact.id));
      if (next) {
        setDetail(next);
        return;
      }
      if (!candidates.items.length || cursor + 100 >= candidates.total) break;
    }
    setDetail(null);
    setOffset(0);
    toast.success(
      `Review round complete: ${reviewed.size} verified. Expired or low-confidence memories may still need editing.`,
    );
  };

  const enabled = config?.enabled === true;
  const health = summary?.health;
  const selectedEntity = entities.items.find((e) => e.name === entity);
  const kpis: { key: StateFilter; label: string; value?: number; hint: string; tone: Tone }[] = [
    {
      key: "active",
      label: "Ready for recall",
      value: health?.active,
      hint: "Active and in date",
      tone: "good",
    },
    {
      key: "review",
      label: "Need your review",
      value: health?.review,
      hint: "Unverified, expired, low confidence or 90+ days old",
      tone: health?.review ? "warn" : "default",
    },
    {
      key: "pinned",
      label: "Pinned memories",
      value: health?.pinned,
      hint: "Always ranked first in recall",
      tone: "default",
    },
    {
      key: "archived",
      label: "Safely archived",
      value: health?.archived,
      hint: "Out of recall, history kept",
      tone: "default",
    },
  ];
  const total = health ? health.active + health.review + health.archived : 0;
  const factItems = page?.items ?? [];
  const factIndex = detail ? factItems.findIndex((f) => f.id === detail.id) : -1;
  const factNav =
    factIndex >= 0
      ? {
          index: factIndex,
          total: factItems.length,
          onPrev: factIndex > 0 ? () => setDetail(factItems[factIndex - 1]) : undefined,
          onNext:
            factIndex < factItems.length - 1
              ? () => setDetail(factItems[factIndex + 1])
              : undefined,
        }
      : undefined;
  const activityRow = activityOpen === undefined ? undefined : activity[activityOpen];
  const changeTab = (next: string) => {
    if (!enabled && next !== "library" && next !== "settings") return;
    setTab(next);
  };

  const entitiesPanel = (
    <MonitorPanel title="Entities" description="Routers, policies and procedures." flush>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <MonitorSearch
          label="Find entities"
          placeholder="Find an entity…"
          value={entitySearch}
          onChange={(value) => {
            setEntitySearch(value);
            setEntityOffset(0);
          }}
        />
        <button
          type="button"
          className="memory-subject"
          data-selected={!entity}
          onClick={() => selectEntity("")}
        >
          <Layers aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">All knowledge</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {summary?.stats.entities ?? "—"}
          </span>
        </button>
        <div className="memory-index-scroll">
          {entities.items.map((item) => {
            const Icon = ENTITY_ICON[item.entityType.toLowerCase()] ?? FileText;
            return (
              <button
                type="button"
                className="memory-subject"
                data-selected={entity === item.name}
                key={item.name}
                onClick={() => selectEntity(item.name)}
              >
                <Icon aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-xs text-foreground">{item.name}</span>
                  <small className="monitor-hint truncate">
                    {item.entityType} · {scopeLabel(item.memoryScope)}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 pt-1">
          <MonitorButton
            size="sm"
            disabled={!enabled}
            onClick={() => setEntityEditor("new")}
            icon={<Plus aria-hidden="true" />}
          >
            Create entity
          </MonitorButton>
          <span className="flex-1" />
          {entities.total > 50 && (
            <>
              <span className="text-xs text-muted-foreground tabular-nums">
                {entityOffset + 1}–{Math.min(entityOffset + 50, entities.total)} / {entities.total}
              </span>
              <MonitorButton
                aria-label="Previous entities"
                size="sm"
                variant="ghost"
                disabled={entityOffset === 0}
                onClick={() => setEntityOffset((v) => Math.max(0, v - 50))}
                icon={<ChevronLeft aria-hidden="true" />}
              />
              <MonitorButton
                aria-label="Next entities"
                size="sm"
                variant="ghost"
                disabled={entityOffset + 50 >= entities.total}
                onClick={() => setEntityOffset((v) => v + 50)}
                icon={<ChevronRight aria-hidden="true" />}
              />
            </>
          )}
        </div>
      </div>
    </MonitorPanel>
  );

  const connectionsPanel = (
    <MonitorPanel title="Connections" description="What this entity inherits and links to.">
      {entity ? (
        <div className="flex flex-col gap-3">
          {relations.length > 0 ? (
            <RelationGraph entity={entity} relations={relations} onSelect={selectEntity} />
          ) : (
            <p className="monitor-hint">
              No relationships yet. Link this entity to enrich scoped recall.
            </p>
          )}
          <dl className="monitor-facts grid-cols-[96px_minmax(0,1fr)]">
            <dt>Type</dt>
            <dd>{selectedEntity?.entityType ?? "—"}</dd>
            <dt>Sharing</dt>
            <dd>
              <MemoryScopeBadge scope={selectedEntity?.memoryScope} detail />
            </dd>
            {relations.length > 0 && (
              <>
                <dt>Relations</dt>
                <dd className="flex flex-col">
                  {relations.slice(0, 12).map((relation) => {
                    const out = relation.from === entity;
                    const other = out ? relation.to : relation.from;
                    return (
                      <button
                        type="button"
                        key={`${relation.from}:${relation.relationType}:${relation.to}`}
                        className="memory-relation"
                        onClick={() => selectEntity(other)}
                      >
                        {relation.relationType} {out ? "→" : "←"} {other}
                      </button>
                    );
                  })}
                  {relations.length > 12 && (
                    <span className="monitor-hint">+{relations.length - 12} more relations</span>
                  )}
                  {relations.length > GRAPH_LIMIT && relations.length <= 12 && (
                    <span className="monitor-hint">The graph shows the first {GRAPH_LIMIT}.</span>
                  )}
                </dd>
              </>
            )}
          </dl>
          <MonitorNote icon={<ShieldCheck aria-hidden="true" />}>
            Memory is context, never permission to change a router.
          </MonitorNote>
          <div className="flex flex-wrap gap-1.5">
            <MonitorButton
              size="sm"
              icon={<GitBranch aria-hidden="true" />}
              onClick={() => setEntityEditor("relation")}
            >
              Link
            </MonitorButton>
            <MonitorButton
              size="sm"
              icon={<Users aria-hidden="true" />}
              onClick={() => setTab("sharing")}
            >
              Sharing scope
            </MonitorButton>
            <span className="flex-1" />
            <MonitorButton
              size="sm"
              variant="danger"
              aria-label="Delete selected entity"
              onClick={() => setDeleting(true)}
              icon={<Trash2 aria-hidden="true" />}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <MonitorEmpty compact icon={<Layers />} title="Pick an entity">
            Its relations, sharing scope and actions show here.
          </MonitorEmpty>
          <MonitorNote icon={<ShieldCheck aria-hidden="true" />}>
            Memory is context, never permission to change a router.
          </MonitorNote>
        </div>
      )}
    </MonitorPanel>
  );

  const libraryPanel = (
    <MonitorPanel
      title={entity || "All knowledge"}
      description={
        state === "review"
          ? "Unverified, expired, low-confidence or not reviewed in 90 days."
          : "One useful idea per memory, with evidence you can inspect."
      }
      extra={
        <MonitorButton
          size="sm"
          disabled={!enabled}
          onClick={() => setEditor("new")}
          icon={<Plus aria-hidden="true" />}
        >
          Add memory
        </MonitorButton>
      }
      flush
      aria-label="Knowledge library"
    >
      <div className="flex flex-wrap items-center gap-2 px-[18px] pb-3">
        <MonitorSearch
          className="min-w-[220px] flex-1"
          label="Search knowledge"
          placeholder="Find facts, lessons or constraints…"
          value={query}
          onChange={(value) => {
            setQuery(value.slice(0, 500));
            setOffset(0);
          }}
        />
        <MonitorSelect
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
        <MonitorSelect
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
        <Segmented
          label="Status"
          value={state}
          onChange={(v) => {
            setState(v);
            setOffset(0);
          }}
          options={STATE_OPTIONS}
        />
      </div>
      {loading && !page && (
        <div className="px-[18px] pb-3.5">
          <LoadingState label="Loading knowledge library" layout="cards" />
        </div>
      )}
      <div className="flex flex-col gap-2.5 px-[18px] pb-3.5" aria-busy={loading}>
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
              selected={detail?.id === fact.id}
              busy={busy || loading}
              onOpen={() => setDetail(fact)}
              onRevise={(patch) => void revise(fact, patch)}
              menu={{
                sub: `${fact.entityName} · ${fact.kind}`,
                cells: {
                  kind: {
                    value: fact.kind,
                    filter: () => {
                      setKind(fact.kind);
                      setOffset(0);
                    },
                    clearFilter:
                      kind !== "all"
                        ? () => {
                            setKind("all");
                            setOffset(0);
                          }
                        : undefined,
                  },
                  scope: fact.scope
                    ? {
                        value: fact.scope,
                        filter: () => {
                          setScopeFilter(fact.scope);
                          setOffset(0);
                        },
                        clearFilter:
                          scopeFilter !== "all"
                            ? () => {
                                setScopeFilter("all");
                                setOffset(0);
                              }
                            : undefined,
                      }
                    : { value: "" },
                  key: { value: fact.key ?? "" },
                  source: { value: fact.source },
                },
                copies: [
                  { label: "Memory ID", value: String(fact.id) },
                  { label: "Content", value: fact.content, hint: "" },
                ],
                row: fact,
                actions: [
                  {
                    label: fact.pinned ? "Unpin memory" : "Pin memory",
                    icon: <Pin aria-hidden="true" />,
                    disabled: busy || loading,
                    onSelect: () => void revise(fact, { pinned: !fact.pinned }),
                  },
                  {
                    label: "Edit memory",
                    onSelect: () => {
                      setEditor(fact);
                      setDetail(null);
                    },
                  },
                  {
                    label: fact.status === "archived" ? "Restore memory" : "Archive memory",
                    icon: <Archive aria-hidden="true" />,
                    disabled: busy || loading,
                    onSelect: () =>
                      void revise(fact, {
                        status: fact.status === "archived" ? "active" : "archived",
                      }),
                  },
                ],
              }}
            />
          ))
        )}
      </div>
      <div className="monitor-foot" aria-live="polite">
        <StatusDot tone="good" pulse={!loading} />
        <span>
          {loading ? "Refreshing knowledge…" : "30s refresh · local only"}
          {!page && !loading && " · Knowledge unavailable"}
        </span>
        <span className="flex-1" />
        {page && (
          <span className="tabular-nums">
            {page.total
              ? `${offset + 1}–${Math.min(offset + 24, page.total)} of ${page.total}`
              : "0 of 0"}
          </span>
        )}
        {page && page.total > 24 && (
          <>
            <MonitorButton
              variant="ghost"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset((v) => Math.max(0, v - 24))}
              icon={<ChevronLeft aria-hidden="true" />}
            >
              Previous
            </MonitorButton>
            <MonitorButton
              variant="ghost"
              size="sm"
              disabled={offset + 24 >= page.total || loading}
              onClick={() => setOffset((v) => v + 24)}
              icon={<ChevronRight aria-hidden="true" />}
            >
              Next
            </MonitorButton>
          </>
        )}
      </div>
    </MonitorPanel>
  );

  return (
    <div className="memory-workspace flex min-w-0 flex-col gap-[18px]">
      <PageIntro
        eyebrow="Network knowledge"
        verdict={
          health ? (
            <>
              {health.active} memories ready for recall.
              {health.review > 0 && (
                <>
                  {" "}
                  <span className="w">{health.review} need review.</span>
                </>
              )}
            </>
          ) : (
            "A memory worth building on."
          )
        }
        lead="Facts, constraints and lessons your MCP can recall. Kept in SQLite on this host, with sources, revisions and freshness you can check."
        actions={
          <>
            <MonitorButton
              variant="primary"
              disabled={!enabled}
              onClick={() => setEditor("new")}
              icon={<Plus aria-hidden="true" />}
            >
              Add memory
            </MonitorButton>
            {!!health?.review && (
              <MonitorButton icon={<Eye aria-hidden="true" />} onClick={() => showState("review")}>
                Show {health.review} to review
              </MonitorButton>
            )}
            <MonitorButton
              variant="ghost"
              disabled={loading}
              onClick={refresh}
              icon={<RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />}
            >
              Refresh
            </MonitorButton>
          </>
        }
        aside={
          health ? (
            <div className="glass memory-aside">
              <Donut
                size={120}
                stroke={12}
                center={total}
                sub="memories"
                label="Memory status"
                noun="memories"
                partAction={(p) => {
                  const next: StateFilter | undefined =
                    p.label === "Ready"
                      ? "active"
                      : p.label === "Review"
                        ? "review"
                        : p.label === "Archived"
                          ? "archived"
                          : undefined;
                  return next
                    ? {
                        label: `Show ${p.label.toLowerCase()} memories`,
                        onClick: () => showState(next),
                      }
                    : undefined;
                }}
                parts={[
                  { value: health.active, tone: "good", label: "Ready" },
                  { value: health.review, tone: "warn", label: "Review" },
                  { value: health.archived, tone: "muted", label: "Archived" },
                ]}
              />
              <div className="flex flex-1 flex-col gap-2 text-xs">
                {(
                  [
                    ["good", "Ready", health.active],
                    ["warn", "Review", health.review],
                    ["default", "Archived", health.archived],
                  ] as const
                ).map(([tone, label, n]) => (
                  <span key={label} className="flex items-center gap-2">
                    <StatusDot tone={tone} />
                    <span className="flex-1 text-fg-secondary">{label}</span>
                    <span className="tabular-nums">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : undefined
        }
      />
      <section aria-label="Memory quality" className="monitor-strip memory-health">
        {kpis.map((k) => (
          <button
            key={k.key}
            type="button"
            className="monitor-metric memory-kpi"
            data-tone={k.tone}
            data-state={k.key}
            aria-pressed={tab === "library" && state === k.key}
            onClick={() => showState(k.key)}
          >
            <span className="monitor-metric-label">{k.label}</span>
            <span className="monitor-metric-value">{k.value ?? "—"}</span>
            <span className="monitor-metric-hint">{k.hint}</span>
          </button>
        ))}
      </section>
      {error && (
        <MonitorNote tone="bad" role="alert">
          <span className="flex flex-wrap items-center gap-2">
            {error}
            <MonitorButton size="sm" onClick={refresh}>
              Retry
            </MonitorButton>
          </span>
        </MonitorNote>
      )}
      {config && !config.enabled && (
        <MonitorNote tone="warn">
          Knowledge memory is disabled. Your stored data is preserved; enable it in Settings to
          continue.
        </MonitorNote>
      )}
      <MonitorTabs
        label="Memory sections"
        value={tab}
        onChange={changeTab}
        tabs={[
          {
            value: "library",
            label: "Knowledge library",
            count: health?.active,
          },
          { value: "recall", label: "Recall lab" },
          { value: "activity", label: "Activity" },
          { value: "sharing", label: "Shared memory" },
          { value: "settings", label: "Settings" },
        ]}
      />
      {tab === "library" && (
        <section className="memory-library">
          {entitiesPanel}
          {libraryPanel}
          {connectionsPanel}
        </section>
      )}
      {tab === "recall" && <RecallLab key={entity} entity={entity} />}
      {tab === "sharing" && (
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
      )}
      {tab === "activity" && (
        <MonitorPanel
          title="A trace of what changed."
          description="Recent knowledge changes. Routine tool calls stay out of this timeline."
          flush
        >
          {activity.length ? (
            <div className="max-h-[640px] overflow-y-auto">
              {activity.map((entry, i) => (
                <RowMenu
                  key={entry.id}
                  title={entry.subject}
                  sub={`${entry.action.replaceAll("_", " ")} · ${date(entry.ts)}`}
                  onOpen={() => setActivityOpen(i)}
                  cells={{
                    time: { value: date(entry.ts), kind: "time" },
                    action: { value: entry.action.replaceAll("_", " ") },
                    subject: { value: entry.subject },
                  }}
                  copies={[{ label: "Subject", value: entry.subject }]}
                  row={entry}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${entry.action.replaceAll("_", " ")}: ${entry.subject}`}
                    className="monitor-row memory-activity-row cursor-pointer"
                    data-selected={activityOpen === i || undefined}
                    onClick={() => setActivityOpen(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActivityOpen(i);
                      }
                    }}
                  >
                    <span data-col="time" className="font-mono text-xs text-muted-foreground">
                      {date(entry.ts)}
                    </span>
                    <span data-col="action" className="monitor-chip w-fit">
                      {entry.action.replaceAll("_", " ")}
                    </span>
                    <span data-col="subject" className="p min-w-0 truncate">
                      {entry.subject}
                    </span>
                    <RowMore />
                  </div>
                </RowMenu>
              ))}
            </div>
          ) : (
            <Empty title="No activity yet">Memory changes will appear here.</Empty>
          )}
        </MonitorPanel>
      )}
      <RowDrawer
        open={tab === "activity" && Boolean(activityRow)}
        onClose={() => setActivityOpen(undefined)}
        label={`Change details: ${activityRow?.subject ?? ""}`}
        title={activityRow?.subject ?? ""}
        meta={
          activityRow
            ? `${activityRow.action.replaceAll("_", " ")} · ${date(activityRow.ts)}`
            : undefined
        }
        nav={
          activityOpen !== undefined && activityRow
            ? {
                index: activityOpen,
                total: activity.length,
                onPrev: activityOpen > 0 ? () => setActivityOpen(activityOpen - 1) : undefined,
                onNext:
                  activityOpen < activity.length - 1
                    ? () => setActivityOpen(activityOpen + 1)
                    : undefined,
              }
            : undefined
        }
        rowKey={activityRow?.id}
        storageKey="memory-activity"
      >
        {activityRow && (
          <DetailList
            items={[
              { label: "Time", value: date(activityRow.ts), mono: true },
              { label: "Action", value: activityRow.action.replaceAll("_", " ") },
              { label: "Subject", value: activityRow.subject },
              ...(activityRow.detail ? [{ label: "Detail", value: activityRow.detail }] : []),
            ]}
          />
        )}
      </RowDrawer>
      {tab === "settings" &&
        (config ? (
          <MemorySettings
            key={`${config.dbPath}:${config.enabled}`}
            config={config}
            onSaved={refresh}
          />
        ) : (
          <MonitorPanel title="Settings">
            <Empty title="Settings unavailable">
              Retry loading to inspect memory configuration.
            </Empty>
          </MonitorPanel>
        ))}
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
          onRevise={(patch) => revise(detail, patch)}
          onNextReview={state === "review" ? nextReview : undefined}
          busy={busy}
          nav={factNav}
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
      <MonitorDialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
        confirm
        title={`Delete ${entity}?`}
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton disabled={busy} onClick={() => setDeleting(false)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="danger"
              disabled={busy}
              icon={<Trash2 aria-hidden="true" />}
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
            </MonitorButton>
          </>
        }
      >
        <div className="monitor-dialog-body">
          <MonitorNote tone="bad">
            This permanently removes the entity, all its memories and revision history, and its
            relations. No router configuration is changed. Archive individual memories instead if
            you may need them again.
          </MonitorNote>
        </div>
      </MonitorDialog>
    </div>
  );
}
