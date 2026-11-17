/**
 * One terminal pane: a command-block console bound to one router.
 *
 * Each command is a block (command, live output, status, actions). The pane
 * also owns its connection state: it probes the router on a timer, shows the
 * latency, and reconnects with a growing delay when the probe fails.
 */
import type { IDockviewPanelProps } from "dockview-react";
import {
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  GitCompareArrows,
  History,
  CornerDownLeft,
  Eraser,
  FileCode2,
  Eye,
  EyeOff,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Square,
  Table2,
  Star,
  TriangleAlert,
  X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Span } from "./terminal-highlight";
import { deviceSpans, hasSyntaxError, loadHighlighter, staticSpans } from "./terminal-highlight";
import type { BroadcastResult, Completion, ExportFormat, RunEnd, SyntaxHelp } from "./terminal-lib";
import { RecordTable } from "./terminal-table";
import {
  changesStore,
  cleanOutput,
  compareStore,
  destructiveWord,
  downloadText,
  evalAlert,
  exportSession,
  fillSnippet,
  favoritesStore,
  notify,
  paneRegistry,
  paneStorage,
  runCommand,
  scriptStore,
  snippetFields,
  terminalApi,
  workspace,
} from "./terminal-lib";

type BlockStatus = "running" | "ok" | "error" | "stopped";
interface Block {
  id: number;
  ts: number;
  command: string;
  output: string;
  status: BlockStatus;
  ms?: number;
  error?: string;
  /** Shown while waiting to retry: "retry 2/3 in 4s". */
  note?: string;
  collapsed?: boolean;
  /** A config snapshot was stored just before this command ran. */
  snapshot?: boolean;
  /** Why the watch alert fired on the last run; undefined when it did not. */
  alert?: string;
  /** Show the output as a table of records. */
  table?: boolean;
  /** Line numbers that differ from the previous run (watch mode). */
  changed?: Set<number>;
  runs: number;
}
type Link = "connecting" | "online" | "reconnecting";
interface Connection {
  link: Link;
  latency: number[];
  identity?: string;
  transport?: string;
  error?: string;
  /** A Safe Mode session is open on this router. */
  safeMode?: boolean;
  /** Epoch ms of the next reconnect attempt. */
  retryAt?: number;
  attempt: number;
}

const PROBE_EVERY_MS = 15_000;
const MAX_RETRIES = 3;
const MAX_BLOCK_CHARS = 400_000;
const WATCH_CHOICES = [2000, 5000, 15_000, 60_000];
/** Longest a command may run before it is stopped. */
const LIMIT_CHOICES = [30_000, 120_000, 600_000];
const seconds = (ms: number): string => (ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000}m`);
let nextBlockId = 1;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function Spans({ lines }: { lines: Span[][] }): ReactNode {
  return lines.map((line, row) => (
    // eslint-disable-next-line react/no-array-index-key -- lines have no identity
    <span key={row}>
      {row > 0 && "\n"}
      {line.map((span, i) => (
        <span
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className={span.bad ? "term-bad" : undefined}
          style={span.color ? { color: span.color } : undefined}
        >
          {span.text}
        </span>
      ))}
    </span>
  ));
}

function Sparkline({ values }: { values: number[] }): ReactNode {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = 56 / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(15 - (v / max) * 13).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="term-spark" viewBox="0 0 56 16" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

const latencyTone = (ms: number | undefined): string =>
  ms === undefined ? "idle" : ms < 80 ? "good" : ms < 300 ? "fair" : "slow";

function BlockViewBase({
  block,
  device,
  starred,
  watching,
  comparing,
  onAction,
}: {
  block: Block;
  device: string;
  starred: boolean;
  watching: boolean;
  /** This block is the first side of a comparison. */
  comparing: boolean;
  onAction: (action: string, block: Block) => void;
}) {
  const [copied, setCopied] = useState("");
  const copy = (what: "output" | "command"): void => {
    void navigator.clipboard
      .writeText(what === "output" ? block.output : block.command)
      .then(() => {
        setCopied(what);
        setTimeout(() => setCopied(""), 1200);
      });
  };
  const isScript = /(?:^|\s)export(?:\s|$)/.test(block.command);
  const body = useMemo(() => {
    if (!block.output) return null;
    const changed = block.changed;
    if (changed?.size) {
      return block.output.split("\n").map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} className={changed.has(i) ? "term-line-changed" : undefined}>
          {line}
          {"\n"}
        </span>
      ));
    }
    return isScript && block.output.length < 60_000 ? (
      <Spans lines={staticSpans(block.output)} />
    ) : (
      block.output
    );
  }, [block.output, block.changed, isScript]);

  return (
    <article className="term-block" data-status={block.status}>
      <header className="term-block-head">
        <button
          type="button"
          className="term-fold"
          onClick={() => onAction("fold", block)}
          aria-label={block.collapsed ? "Show output" : "Hide output"}
        >
          {block.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <span className="term-prompt">
          <span className="term-prompt-device">{device}</span>
          <span className="term-prompt-mark">&gt;</span>
        </span>
        <code className="term-block-command">
          <Spans lines={staticSpans(block.command)} />
        </code>
        <span className="term-block-meta">
          {block.status === "running" && (
            <span className="term-chip" data-tone="run">
              <span className="term-pulse" /> {block.note ?? "running"}
            </span>
          )}
          {block.status === "ok" && (
            <span className="term-chip" data-tone="ok">
              {block.ms} ms
            </span>
          )}
          {block.status === "stopped" && (
            <span className="term-chip" data-tone="stop">
              stopped · {block.ms} ms
            </span>
          )}
          {block.status === "error" && (
            <span className="term-chip" data-tone="err">
              failed · {block.ms} ms
            </span>
          )}
          {block.runs > 1 && <span className="term-chip">×{block.runs}</span>}
          {block.snapshot && (
            <button
              type="button"
              className="term-chip term-chip-button"
              onClick={() => onAction("changes", block)}
              title="A snapshot was stored before this command. Show what differs from it now."
            >
              <History size={11} /> what changed?
            </button>
          )}
          {block.alert && (
            <span className="term-chip" data-tone="alert" title={block.alert}>
              <BellRing size={11} /> {block.alert}
            </span>
          )}
          <time className="term-time">{new Date(block.ts).toLocaleTimeString()}</time>
        </span>
        <span className="term-actions">
          {/* Stop and Run again never share a place: a late click on Stop
              must not run a finished command a second time. */}
          {block.status === "running" && (
            <button
              type="button"
              className="term-stop"
              onClick={() => onAction("stop", block)}
              title="Stop (Ctrl+C)"
            >
              <Square size={13} /> Stop
            </button>
          )}
          <button
            type="button"
            disabled={block.status === "running"}
            onClick={() => onAction("rerun", block)}
            title="Run again"
          >
            <RotateCw size={13} />
          </button>
          <button
            type="button"
            onClick={() => onAction("watch", block)}
            title={watching ? "Stop watching" : "Watch: run again on a timer and mark what changed"}
            data-on={watching}
          >
            {watching ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          {/\bprint\b/.test(block.command) && block.status === "ok" && (
            <button
              type="button"
              onClick={() => onAction("table", block)}
              title={block.table ? "Show as text" : "Show as a table"}
              data-on={Boolean(block.table)}
            >
              <Table2 size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onAction("compare", block)}
            title={
              comparing
                ? "Picked for comparison. Pick another block, in any pane, to see the differences."
                : "Compare this output with another block"
            }
            data-on={comparing}
          >
            <GitCompareArrows size={13} />
          </button>
          <button type="button" onClick={() => copy("output")} title="Copy output">
            {copied === "output" ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button type="button" onClick={() => copy("command")} title="Copy command">
            {copied === "command" ? <Check size={13} /> : <CornerDownLeft size={13} />}
          </button>
          <button
            type="button"
            onClick={() => onAction("star", block)}
            title={starred ? "Remove from favourites" : "Add to favourites"}
            data-on={starred}
          >
            <Star size={13} fill={starred ? "currentColor" : "none"} />
          </button>
          <button type="button" onClick={() => onAction("save", block)} title="Save as a text file">
            <Download size={13} />
          </button>
          <button type="button" onClick={() => onAction("remove", block)} title="Remove block">
            <X size={13} />
          </button>
        </span>
      </header>
      {!block.collapsed && (
        <>
          {block.table && block.output ? (
            <RecordTable output={block.output} />
          ) : (
            body !== null && <pre className="term-output">{body}</pre>
          )}
          {block.status !== "running" && !block.output && !block.error && (
            <div className="term-empty">no output</div>
          )}
          {block.error && (
            <div className="term-error">
              <TriangleAlert size={13} /> {block.error}
            </div>
          )}
        </>
      )}
    </article>
  );
}
const BlockView = memo(BlockViewBase);

export function TerminalPane(
  props: IDockviewPanelProps<{ device: string; color?: string }>,
): ReactNode {
  const device = props.params.device;
  const paneId = props.api.id;
  // Blocks survive a reload. A block that was running then has an unknown end.
  const [blocks, setBlocks] = useState<Block[]>(() =>
    paneStorage.load<Block>(props.api.id).map((block) => ({
      ...block,
      changed: undefined,
      note: undefined,
      status: block.status === "running" ? "stopped" : block.status,
      id: nextBlockId++,
    })),
  );
  const [input, setInput] = useState("");
  const [tokens, setTokens] = useState<{ for: string; classes: string[] }>({
    for: "",
    classes: [],
  });
  // While the list is open the arrows move in it and Tab accepts the marked
  // word. Enter accepts only after an arrow moved the mark (`moved`); otherwise
  // it runs the command, as a terminal must.
  const [completions, setCompletions] = useState<{
    items: Completion[];
    index: number;
    moved?: boolean;
  } | null>(null);
  const completeList = useRef<HTMLUListElement>(null);
  const [limit, setLimit] = useState(LIMIT_CHOICES[0] ?? 30_000);
  const [watchEvery, setWatchEvery] = useState(5000);
  /** The router's explanations for what can follow the input. */
  const [help, setHelp] = useState<{ for: string; items: SyntaxHelp[] }>({ for: "", items: [] });
  const [showHelp, setShowHelp] = useState(true);
  /** Alert rule for the watched block (see evalAlert). */
  const [alertRule, setAlertRule] = useState("");
  const alertRuleRef = useRef(alertRule);
  alertRuleRef.current = alertRule;
  const limitRef = useRef(limit);
  limitRef.current = limit;
  /** Input for which the user closed the list with Escape. */
  const dismissed = useRef("");
  const [confirm, setConfirm] = useState<{ command: string; word: string } | null>(null);
  /** A snippet waiting for the values of its {{placeholders}}. */
  const [fill, setFill] = useState<{ command: string; values: Record<string, string> } | null>(
    null,
  );
  const [safeBusy, setSafeBusy] = useState(false);
  const [autoRetry, setAutoRetry] = useState(true);
  /** Store a config snapshot before every command that is not a read. */
  const [guard, setGuard] = useState(false);
  const guardRef = useRef(guard);
  guardRef.current = guard;
  const [watch, setWatch] = useState<number | null>(null);
  const [conn, setConn] = useState<Connection>({ link: "connecting", latency: [], attempt: 0 });
  const [, setGrammarReady] = useState(false);
  const [now, setNow] = useState(Date.now());
  const favorites = useSyncExternalStore(favoritesStore.subscribe, favoritesStore.get);
  const comparePick = useSyncExternalStore(
    compareStore.subscribe,
    () => compareStore.get().first?.key ?? "",
  );
  const starred = useMemo(() => new Set(favorites.map((f) => f.command)), [favorites]);

  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const autoRetryRef = useRef(autoRetry);
  autoRetryRef.current = autoRetry;
  const running = useRef(new Map<number, AbortController>());
  const recall = useRef<{ list: string[]; index: number; draft: string }>({
    list: [],
    index: -1,
    draft: "",
  });
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const probeNow = useRef<() => void>(() => {});

  const patch = useCallback(
    (id: number, change: Partial<Block> | ((b: Block) => Partial<Block>)) => {
      setBlocks((list) =>
        list.map((b) =>
          b.id === id ? { ...b, ...(typeof change === "function" ? change(b) : change) } : b,
        ),
      );
    },
    [],
  );

  // ── grammar + recall history ────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    void loadHighlighter().then(() => alive && setGrammarReady(true));
    void terminalApi
      .history({ device, limit: 200 })
      .then((entries) => {
        if (!alive) return;
        const seen = new Set<string>();
        recall.current.list = entries
          .map((e) => e.command)
          .filter((c) => !seen.has(c) && seen.add(c))
          .reverse();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [device]);

  // ── connection: probe, latency, reconnect with a growing delay ──────────
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let warm = false;
    const abort = new AbortController();
    const probe = async (): Promise<void> => {
      clearTimeout(timer);
      if (!alive) return;
      if (document.hidden) {
        timer = setTimeout(probe, PROBE_EVERY_MS);
        return;
      }
      let result;
      try {
        result = await terminalApi.probe(device, abort.signal);
      } catch (e) {
        result = { ok: false, ms: 0, error: e instanceof Error ? e.message : String(e) };
      }
      if (!alive) return;
      if (result.ok) {
        attempt = 0;
        // The first probe on a new connection includes the SSH handshake, so
        // it is not a round-trip time: measure again straight away.
        const handshake = !warm;
        warm = true;
        setConn((c) => ({
          link: "online",
          latency: handshake ? c.latency : [...c.latency, result.ms].slice(-30),
          identity: result.identity,
          transport: result.transport,
          safeMode: result.safeMode,
          attempt: 0,
        }));
        timer = setTimeout(probe, handshake ? 400 : PROBE_EVERY_MS);
      } else {
        warm = false;
        attempt++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        setConn((c) => ({
          ...c,
          link: "reconnecting",
          error: result.error,
          attempt,
          retryAt: Date.now() + delay,
        }));
        timer = setTimeout(probe, delay);
      }
    };
    probeNow.current = () => void probe();
    void probe();
    return () => {
      alive = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [device]);

  // Countdown text while reconnecting.
  useEffect(() => {
    if (conn.link !== "reconnecting") return;
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, [conn.link]);

  // ── run a command (with auto-retry when a retry cannot repeat a change) ──
  const runBlock = useCallback(
    async (
      command: string,
      options: { blockId?: number; quiet?: boolean } = {},
    ): Promise<RunEnd> => {
      const id = options.blockId ?? nextBlockId++;
      const previous = blocksRef.current.find((b) => b.id === id);
      if (previous?.status === "running") return { ok: false, ms: 0, error: "Already running." };
      if (previous)
        patch(id, (b) => ({
          status: "running",
          error: undefined,
          note: undefined,
          runs: b.runs + 1,
        }));
      else
        setBlocks((list) => [
          ...list,
          { id, ts: Date.now(), command, output: "", status: "running", runs: 1 },
        ]);
      const abort = new AbortController();
      running.current.set(id, abort);
      stick.current = true;

      let end: RunEnd = { ok: false, ms: 0 };
      let buffer = "";
      for (let attempt = 1; ; attempt++) {
        buffer = "";
        // A watched block keeps its old output until the new run is complete.
        if (!options.quiet) patch(id, { output: "", changed: undefined });
        end = await runCommand(device, command, {
          maxMs: limitRef.current,
          snapshot: guardRef.current,
          signal: abort.signal,
          onOutput: (text) => {
            buffer = (buffer + cleanOutput(text)).slice(-MAX_BLOCK_CHARS);
            if (!options.quiet) patch(id, { output: buffer });
          },
        });
        if (end.ok || end.stopped || !end.retryable) break;
        if (!autoRetryRef.current || attempt > MAX_RETRIES || abort.signal.aborted) break;
        const wait = 1000 * 2 ** (attempt - 1);
        patch(id, { note: `retry ${attempt}/${MAX_RETRIES} in ${wait / 1000}s`, error: end.error });
        probeNow.current();
        await sleep(wait, abort.signal);
        if (abort.signal.aborted) break;
        patch(id, { note: `retry ${attempt}/${MAX_RETRIES}` });
      }
      running.current.delete(id);
      const output = buffer.replace(/\n+$/, "");
      const result = end;
      // A watched run may raise an alert; it notifies once, when it starts to hold.
      const earlier = blocksRef.current.find((b) => b.id === id);
      const alert =
        options.quiet && result.ok
          ? (evalAlert(alertRuleRef.current, output, earlier?.output ?? "") ?? undefined)
          : undefined;
      if (alert && !earlier?.alert) notify(`${device}: ${command}`, alert);
      patch(id, (b) => {
        let changed: Set<number> | undefined;
        if (options.quiet && b.output && b.output !== output) {
          const before = b.output.split("\n");
          const differing = new Set<number>();
          output.split("\n").forEach((line, i) => {
            if (line !== before[i]) differing.add(i);
          });
          changed = differing;
        }
        return {
          output,
          changed,
          alert,
          snapshot: result.snapshot,
          ts: Date.now(),
          ms: result.ms,
          note: undefined,
          error: result.ok ? undefined : result.error,
          status: result.stopped ? "stopped" : result.ok ? "ok" : "error",
        };
      });
      if (!result.ok && !result.stopped) probeNow.current();
      workspace.onCommandDone();
      return result;
    },
    [device, patch],
  );

  const submit = useCallback(
    (
      raw: string,
      options: { confirmed?: boolean; fromBroadcast?: boolean } = {},
    ): Promise<BroadcastResult | null> => {
      const command = raw.trim();
      if (!command) return Promise.resolve(null);
      const fields = snippetFields(command);
      if (fields.length) {
        // Ask for the values first; the filled command comes back through here.
        setFill({
          command,
          values: Object.fromEntries(fields.map((field) => [field.name, field.fallback])),
        });
        return Promise.resolve(null);
      }
      const word = destructiveWord(command);
      if (word && !options.confirmed && !options.fromBroadcast) {
        setConfirm({ command, word });
        return Promise.resolve(null);
      }
      setConfirm(null);
      const list = recall.current.list;
      if (list.at(-1) !== command) list.push(command);
      recall.current.index = -1;
      const own = runBlock(command).then((end) => ({ ...end, device }));
      const target = workspace.broadcast;
      if (target && !options.fromBroadcast) {
        const others = paneRegistry
          .all()
          .filter((pane) => pane.id !== paneId)
          .filter((pane) => !target.devices || target.devices.includes(pane.device))
          .map((pane) => pane.run(command, { fromBroadcast: true }));
        void Promise.all([own, ...others]).then((results) =>
          workspace.onBroadcastDone(
            command,
            results.filter((result): result is BroadcastResult => result !== null),
          ),
        );
      }
      return own;
    },
    [runBlock, paneId],
  );

  // ── registry: the drawer and broadcast reach this pane through it ────────
  useEffect(
    () =>
      paneRegistry.add({
        id: paneId,
        device,
        run: (command, options) => submit(command, options),
        insert: (command) => {
          setInput(command);
          field.current?.focus();
        },
        focus: () => field.current?.focus(),
      }),
    [paneId, device, submit],
  );
  useEffect(() => {
    const active = props.api.onDidActiveChange((event) => {
      if (event.isActive) workspace.activePane = paneId;
    });
    if (props.api.isActive) workspace.activePane = paneId;
    return () => active.dispose();
  }, [props.api, paneId]);

  // Stop everything this pane started when it closes.
  useEffect(() => {
    const controllers = running.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
    };
  }, []);

  // ── watch: run one block again on a timer ───────────────────────────────
  useEffect(() => {
    if (watch === null) return;
    const timer = setInterval(() => {
      const block = blocksRef.current.find((b) => b.id === watch);
      if (!block) {
        setWatch(null);
        return;
      }
      if (block.status !== "running" && !document.hidden)
        void runBlock(block.command, { blockId: block.id, quiet: true });
    }, watchEvery);
    return () => clearInterval(timer);
  }, [watch, watchEvery, runBlock]);

  // ── keep the blocks for the next visit ──────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => paneStorage.save(paneId, blocks), 400);
    return () => clearTimeout(timer);
  }, [blocks, paneId]);

  // ── the router's help for the word being typed ──────────────────────────
  useEffect(() => {
    if (!showHelp || !input.trim() || input.includes("\n") || conn.link !== "online") return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      terminalApi
        .syntax(device, input, abort.signal)
        .then((items) => setHelp({ for: input, items }))
        .catch(() => {});
    }, 320);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [input, device, conn.link, showHelp]);

  // Scroll the list so the marked word stays in view.
  const marked = completions?.index;
  useEffect(() => {
    completeList.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [marked]);

  // ── completion while typing, a moment after the last key ────────────────
  useEffect(() => {
    if (!input.trim() || input.includes("\n") || conn.link !== "online") return;
    if (dismissed.current === input) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const area = field.current;
      if (!area || document.activeElement !== area || area.selectionStart !== input.length) return;
      terminalApi
        .complete(device, input, abort.signal)
        .then((items) => {
          const words = items
            .filter((item) => /\w/.test(item.completion))
            // Nothing to offer when the word is already typed in full.
            .filter((item) => input.slice(item.offset) !== item.completion);
          setCompletions(words.length ? { items: words.slice(0, 40), index: 0 } : null);
        })
        .catch(() => {});
    }, 220);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [input, device, conn.link]);

  // ── syntax check by the router, a moment after typing stops ─────────────
  useEffect(() => {
    if (input.trim().length < 2 || conn.link !== "online") return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      terminalApi
        .highlight(device, input, abort.signal)
        .then((classes) => setTokens({ for: input, classes }))
        .catch(() => {});
    }, 280);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [input, device, conn.link]);

  // Keep the newest output in view unless the user scrolled up.
  useEffect(() => {
    const box = scroller.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [blocks]);

  const onAction = useCallback(
    (action: string, block: Block): void => {
      if (action === "stop") running.current.get(block.id)?.abort();
      else if (action === "rerun") void submit(block.command);
      else if (action === "fold") patch(block.id, { collapsed: !block.collapsed });
      else if (action === "table") patch(block.id, { table: !block.table });
      else if (action === "changes")
        void terminalApi
          .changes(device)
          .then((text) => changesStore.show(`Changed on ${device} since the snapshot`, text));
      else if (action === "compare")
        compareStore.pick({
          key: `${paneId}:${block.id}`,
          label: `${device} > ${block.command}`,
          text: block.output,
        });
      else if (action === "star") void favoritesStore.toggle(block.command);
      else if (action === "save")
        downloadText(`${device}-${block.id}.txt`, exportSession(device, [block], "txt"));
      else if (action === "watch") setWatch((current) => (current === block.id ? null : block.id));
      else if (action === "remove") {
        running.current.get(block.id)?.abort();
        setWatch((current) => (current === block.id ? null : current));
        setBlocks((list) => list.filter((b) => b.id !== block.id));
      }
    },
    [patch, submit, device, paneId],
  );

  /** The newest earlier command that starts with what is typed (accepted with →). */
  const ghost = useMemo(() => {
    if (!input || input.includes("\n")) return "";
    const list = recall.current.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const earlier = list[i];
      if (earlier && earlier.length > input.length && earlier.startsWith(input)) return earlier;
    }
    return "";
    // `blocks` changes when a command is added to the recall list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, blocks]);

  const applyCompletion = (item: Completion): void => {
    const caret = field.current?.selectionStart ?? input.length;
    const tail = item.style === "arg" ? "=" : item.completion === "/" ? "" : " ";
    const head = input.slice(0, Math.min(item.offset, caret)) + item.completion + tail;
    setInput(head + input.slice(caret));
    setCompletions(null);
    requestAnimationFrame(() => field.current?.setSelectionRange(head.length, head.length));
  };

  const complete = async (): Promise<void> => {
    const caret = field.current?.selectionStart ?? input.length;
    const items = await terminalApi.complete(device, input.slice(0, caret)).catch(() => []);
    const words = items.filter((item) => /\w/.test(item.completion));
    if (words.length === 1 && words[0]) applyCompletion(words[0]);
    else setCompletions(words.length ? { items: words.slice(0, 40), index: 0 } : null);
  };

  /** Put an earlier command in the field. No list opens, so ↑ and ↓ keep recalling. */
  const recallInto = (command: string): void => {
    dismissed.current = command;
    setCompletions(null);
    setInput(command);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const area = event.currentTarget;
    if (completions) {
      const chosen = completions.items[completions.index];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const size = completions.items.length;
        const step = event.key === "ArrowUp" ? -1 : 1;
        setCompletions({
          ...completions,
          index: (completions.index + step + size) % size,
          moved: true,
        });
        return;
      }
      if (chosen && (event.key === "Tab" || (event.key === "Enter" && completions.moved))) {
        event.preventDefault();
        applyCompletion(chosen);
        return;
      }
      setCompletions(null);
      if (event.key === "Escape") {
        dismissed.current = input;
        return;
      }
    }
    if (
      event.key === "ArrowRight" &&
      ghost &&
      area.selectionStart === input.length &&
      area.selectionEnd === input.length
    ) {
      // Accept the suggestion from the history.
      event.preventDefault();
      setInput(ghost);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      void complete();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit(input);
      setInput("");
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setBlocks((list) => list.filter((b) => b.status === "running"));
    } else if (event.key === "c" && event.ctrlKey && area.selectionStart === area.selectionEnd) {
      const last = Array.from(running.current.values()).at(-1);
      if (last) {
        event.preventDefault();
        last.abort();
      }
    } else if (event.key === "ArrowUp" && !input.slice(0, area.selectionStart).includes("\n")) {
      const state = recall.current;
      if (!state.list.length) return;
      event.preventDefault();
      if (state.index === -1) state.draft = input;
      state.index = state.index === -1 ? state.list.length - 1 : Math.max(0, state.index - 1);
      recallInto(state.list[state.index] ?? "");
    } else if (event.key === "ArrowDown" && !input.slice(area.selectionEnd).includes("\n")) {
      const state = recall.current;
      if (state.index === -1) return;
      event.preventDefault();
      state.index = state.index >= state.list.length - 1 ? -1 : state.index + 1;
      recallInto(state.index === -1 ? state.draft : (state.list[state.index] ?? ""));
    }
  };

  // Help for the word at the end of the input: the choices that start with it.
  const typedWord = input.match(/[\w.-]*$/)?.[0] ?? "";
  const helpItems = useMemo(
    () =>
      help.for === input
        ? help.items.filter(
            (item) =>
              item.text && (!item.symbol || !typedWord || item.symbol.startsWith(typedWord)),
          )
        : [],
    [help, input, typedWord],
  );
  const helpText = useMemo(
    () => new Map(help.items.filter((item) => item.symbol).map((item) => [item.symbol, item.text])),
    [help.items],
  );
  const fromRouter =
    input.trim() && tokens.for === input ? deviceSpans(input, tokens.classes) : null;
  const syntaxError = fromRouter !== null && hasSyntaxError(tokens.classes);
  const inputSpans = fromRouter ?? staticSpans(input);
  const last = conn.latency.at(-1);
  const stats = useMemo(
    () => ({
      total: blocks.length,
      failed: blocks.filter((b) => b.status === "error").length,
      active: blocks.filter((b) => b.status === "running").length,
    }),
    [blocks],
  );
  const retryIn = conn.retryAt ? Math.max(0, Math.ceil((conn.retryAt - now) / 1000)) : 0;
  /** Enable, commit or roll back Safe Mode; the answer is shown as a block. */
  const safeMode = async (action: "enable" | "commit" | "rollback"): Promise<void> => {
    setSafeBusy(true);
    const started = performance.now();
    const answer = await terminalApi
      .safeMode(device, action)
      .catch((e: unknown): Awaited<ReturnType<typeof terminalApi.safeMode>> => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    setSafeBusy(false);
    const failed = answer.ok === false || Boolean(answer.error);
    const text = answer.message ?? answer.error ?? "";
    setBlocks((list) => [
      ...list,
      {
        id: nextBlockId++,
        ts: Date.now(),
        command: `# safe mode: ${action}`,
        output: failed ? "" : text,
        error: failed ? text : undefined,
        status: failed ? "error" : "ok",
        ms: Math.round(performance.now() - started),
        runs: 1,
      },
    ]);
    if ("active" in answer) setConn((c) => ({ ...c, safeMode: answer.active }));
    probeNow.current();
  };
  const clear = (): void => setBlocks((list) => list.filter((b) => b.status === "running"));
  const exportAs = (format: ExportFormat): void => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadText(`${device}-${stamp}.${format}`, exportSession(device, blocks, format));
  };

  return (
    <section
      className="term-pane"
      data-pane-id={paneId}
      data-pane-color={props.params.color || undefined}
      data-safe={Boolean(conn.safeMode)}
      data-link={conn.link}
      onMouseDown={() => {
        workspace.activePane = paneId;
      }}
    >
      <header className="term-status">
        <span className="term-link" data-link={conn.link}>
          <span className="term-dot" />
          {conn.link === "online" && "connected"}
          {conn.link === "connecting" && "connecting…"}
          {conn.link === "reconnecting" && `reconnecting in ${retryIn}s · try ${conn.attempt}`}
        </span>
        {conn.identity && <span className="term-stat term-identity">{conn.identity}</span>}
        {conn.transport && <span className="term-stat">{conn.transport}</span>}
        <span
          className="term-stat"
          data-tone={latencyTone(last)}
          title="Round trip of the last probe"
        >
          {last === undefined ? "— ms" : `${last} ms`}
          <Sparkline values={conn.latency} />
        </span>
        <span className="term-stat" title="Commands in this pane">
          {stats.total} cmd
          {stats.failed > 0 && <b className="term-failed"> · {stats.failed} failed</b>}
          {stats.active > 0 && ` · ${stats.active} running`}
        </span>
        {conn.safeMode ? (
          <span className="term-safe" role="group" aria-label="Safe Mode">
            <ShieldCheck size={12} /> SAFE MODE
            <button
              type="button"
              disabled={safeBusy}
              onClick={() => void safeMode("commit")}
              title="Keep the changes made in Safe Mode"
            >
              Commit
            </button>
            <button
              type="button"
              disabled={safeBusy}
              onClick={() => void safeMode("rollback")}
              title="Undo every change made since Safe Mode started"
            >
              Roll back
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="term-safe-start"
            disabled={safeBusy || conn.link !== "online"}
            onClick={() => void safeMode("enable")}
            title="Safe Mode: the router undoes your uncommitted changes if this session is lost. Changes run through one Safe Mode session until you commit or roll back."
          >
            <ShieldCheck size={12} /> safe mode
          </button>
        )}
        <span className="term-status-actions">
          <button
            type="button"
            data-on={autoRetry}
            onClick={() => setAutoRetry((on) => !on)}
            title="Auto-retry: send a command again when the router was not reached, or when the command only reads. A change that may already have run is never sent twice."
          >
            <RefreshCw size={12} /> auto-retry {autoRetry ? "on" : "off"}
          </button>
          <button
            type="button"
            data-on={guard}
            onClick={() => setGuard((on) => !on)}
            title="Snapshot: store the router's configuration before every command that changes it. The snapshot is kept on this computer (Snapshots page), not on the router."
          >
            <History size={12} /> snapshot {guard ? "on" : "off"}
          </button>
          <label title="Stop a command after this long">
            limit
            <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {LIMIT_CHOICES.map((ms) => (
                <option key={ms} value={ms}>
                  {seconds(ms)}
                </option>
              ))}
            </select>
          </label>
          {watch !== null && (
            <label
              className="term-alert-rule"
              title={
                "Alert for the watched block. Examples: changed · cpu-load > 80 · /down|error/ · ether1"
              }
            >
              <BellRing size={12} />
              <input
                value={alertRule}
                placeholder="alert when… (changed, cpu-load > 80)"
                spellCheck={false}
                aria-label="Alert rule for the watched command"
                onChange={(event) => setAlertRule(event.target.value)}
              />
            </label>
          )}
          <label title="How often a watched command runs again">
            watch
            <select
              value={watchEvery}
              onChange={(event) => setWatchEvery(Number(event.target.value))}
            >
              {WATCH_CHOICES.map((ms) => (
                <option key={ms} value={ms}>
                  {seconds(ms)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => probeNow.current()} title="Check the connection now">
            <RotateCw size={12} />
          </button>
          <button
            type="button"
            onClick={() => scriptStore.open(paneId)}
            title="Run a script: several commands, one per line"
          >
            <FileCode2 size={12} />
          </button>
          <details className="term-menu">
            <summary title="Save this pane as a file">
              <Download size={12} />
            </summary>
            <div>
              <button type="button" onClick={() => exportAs("txt")}>
                Transcript (.txt)
              </button>
              <button type="button" onClick={() => exportAs("md")}>
                Report (.md)
              </button>
              <button type="button" onClick={() => exportAs("rsc")}>
                Commands that ran (.rsc)
              </button>
            </div>
          </details>
          <button type="button" onClick={clear} title="Clear this pane (Ctrl+L)">
            <Eraser size={12} />
          </button>
        </span>
      </header>

      {conn.link === "reconnecting" && conn.error && (
        <div className="term-banner">
          <TriangleAlert size={13} /> {conn.error}
        </div>
      )}

      <div
        className="term-scroll"
        ref={scroller}
        onScroll={(event) => {
          const box = event.currentTarget;
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) field.current?.focus();
        }}
      >
        {blocks.length === 0 && (
          <div className="term-welcome">
            <strong>{conn.identity ?? device}</strong>
            <span>Type a RouterOS command. Tab completes from the router, ↑ recalls history.</span>
            <div className="term-suggest">
              {[
                "/system resource print",
                "/interface print",
                "/ip address print",
                "/log print",
              ].map((command) => (
                <button key={command} type="button" onClick={() => void submit(command)}>
                  {command}
                </button>
              ))}
            </div>
          </div>
        )}
        {blocks.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            device={device}
            starred={starred.has(block.command)}
            watching={watch === block.id}
            comparing={comparePick === `${paneId}:${block.id}`}
            onAction={onAction}
          />
        ))}
      </div>

      {confirm && (
        <div className="term-confirm" role="alertdialog" aria-label="Confirm command">
          <TriangleAlert size={15} />
          <span>
            <b>{confirm.word}</b> changes or removes configuration on <b>{device}</b>
            {workspace.broadcast && ` and on the other panes of “${workspace.broadcast.label}”`}.
            Run it?
          </span>
          <button
            type="button"
            className="term-danger"
            onClick={() => void submit(confirm.command, { confirmed: true })}
          >
            Run
          </button>
          <button
            type="button"
            onClick={() => {
              setInput(confirm.command);
              setConfirm(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {fill && (
        <form
          className="term-fill"
          aria-label="Snippet values"
          onSubmit={(event) => {
            event.preventDefault();
            const filled = fillSnippet(fill.command, fill.values);
            setFill(null);
            void submit(filled);
          }}
        >
          <code>
            <Spans lines={staticSpans(fillSnippet(fill.command, fill.values))} />
          </code>
          <div>
            {snippetFields(fill.command).map((item, i) => (
              <label key={item.name}>
                {item.name}
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- the form opens on a key press
                  autoFocus={i === 0}
                  value={fill.values[item.name] ?? ""}
                  placeholder={item.fallback}
                  spellCheck={false}
                  onChange={(event) =>
                    setFill({
                      ...fill,
                      values: { ...fill.values, [item.name]: event.target.value },
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setFill(null);
                  }}
                />
              </label>
            ))}
            <button type="submit" className="term-go">
              Run
            </button>
            <button
              type="button"
              onClick={() => {
                setInput(fill.command);
                setFill(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {showHelp && helpItems.length > 0 && !completions && (
        <div className="term-help" aria-label="Help from the router">
          {helpItems.slice(0, 24).map((item, i) => (
            // eslint-disable-next-line react/no-array-index-key -- notes have no symbol
            <span key={`${item.symbol}-${i}`} data-nested={item.nested}>
              {item.symbol && <b>{item.symbol}</b>}
              {item.text}
            </span>
          ))}
        </div>
      )}

      <footer className="term-input" data-error={syntaxError}>
        <span className="term-prompt">
          <span className="term-prompt-device">{device}</span>
          <span className="term-prompt-mark">&gt;</span>
        </span>
        <div className="term-editor">
          <pre className="term-editor-paint" aria-hidden="true">
            <Spans lines={inputSpans} />
            {ghost && <span className="term-ghost">{ghost.slice(input.length)}</span>}
            {"​"}
          </pre>
          <textarea
            ref={field}
            value={input}
            rows={Math.min(8, input.split("\n").length)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={`Command for ${device}`}
            placeholder="/ip address print"
            onChange={(event) => {
              setInput(event.target.value);
              setCompletions(null);
              // Typing ends a walk through the history.
              recall.current.index = -1;
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setCompletions(null), 150)}
          />
          {completions && (
            <ul className="term-complete" role="listbox" ref={completeList}>
              {completions.items.map((item, i) => (
                <li
                  key={`${item.completion}-${item.style}`}
                  role="option"
                  aria-selected={i === completions.index}
                  data-style={item.style}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyCompletion(item);
                  }}
                >
                  <span>{item.completion}</span>
                  <small>{helpText.get(item.completion) || item.style}</small>
                </li>
              ))}
              <li className="term-complete-hint" aria-hidden="true">
                ↑↓ move · Tab accept · Esc close
              </li>
            </ul>
          )}
        </div>
        <button
          type="button"
          className="term-star-input"
          data-on={showHelp}
          onClick={() => setShowHelp((on) => !on)}
          title="Help from the router for the word being typed"
        >
          <CircleHelp size={13} />
        </button>
        <button
          type="button"
          className="term-star-input"
          disabled={!input.trim()}
          data-on={starred.has(input.trim())}
          onClick={() => void favoritesStore.toggle(input.trim())}
          title="Save what is typed as a favourite. Use {{name}} or {{name=default}} for values asked at run time."
        >
          <Star size={13} fill={starred.has(input.trim()) ? "currentColor" : "none"} />
        </button>
        <span
          className="term-check"
          data-state={fromRouter === null ? "idle" : syntaxError ? "bad" : "ok"}
        >
          {fromRouter === null ? "" : syntaxError ? "router: syntax error" : "router: syntax ok"}
        </span>
      </footer>
    </section>
  );
}
