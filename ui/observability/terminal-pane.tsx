/**
 * One terminal pane: a command-block console bound to one router.
 *
 * Each command is a block (command, live output, status, actions). The pane
 * also owns its connection state: it probes the router on a timer, shows the
 * latency, and reconnects with a growing delay when the probe fails.
 */
import type { IDockviewPanelProps } from "dockview-react";
import {
  ArrowDownToLine,
  BellRing,
  CalendarDays,
  ChartLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  CornerDownLeft,
  Download,
  Ellipsis,
  Eraser,
  Eye,
  FileCode2,
  GitCompareArrows,
  History,
  Pencil,
  Pin,
  Play,
  RotateCw,
  Share2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Star,
  Table2,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  arrive,
  Field,
  Kbd,
  Led,
  LineHover,
  Menu,
  Select,
  Switch,
  TextInput,
  tipProps,
} from "./kit";
import type { Span } from "./terminal-highlight";
import { deviceSpans, hasSyntaxError, loadHighlighter, staticSpans } from "./terminal-highlight";
import type {
  BroadcastResult,
  Completion,
  ExportFormat,
  OutputToken,
  RunEnd,
  SyntaxHelp,
} from "./terminal-lib";
import type { PointItem } from "./terminal-menu";
import { PointMenu, Pop, Shimmer } from "./terminal-menu";
import { RecordTable } from "./terminal-table";
import {
  applyPipes,
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
  planUndo,
  readNumber,
  runCommand,
  scriptStore,
  snippetFields,
  splitPipes,
  terminalApi,
  tokenCommands,
  tokenize,
  undoOfAdd,
  workspace,
} from "./terminal-lib";

type BlockStatus = "running" | "ok" | "error" | "stopped";
interface Block {
  id: number;
  ts: number;
  /** When the current run started (for the "running · 7 s" chip). */
  started?: number;
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
  /** The command that reverses this one, when that is certain. */
  undo?: string;
  /** One value per run of the charted number (watch mode). */
  series?: number[];
  /** Kept above the scrolling list, always in view. */
  pinned?: boolean;
  /** Show the output as a table of records. */
  table?: boolean;
  /** Line numbers that differ from the previous run (watch mode). */
  changed?: Set<number>;
  /** The previous text of each changed line, for "▲ from 32%". */
  changedFrom?: Record<number, string>;
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
/** "5 s", "2 min". */
const seconds = (ms: number): string => (ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`);
const clockTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const latencyTone = (ms: number | undefined): string =>
  ms === undefined ? "idle" : ms < 80 ? "good" : ms < 300 ? "fair" : "slow";
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
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = 56 / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(12 - ((v - min) / span) * 10).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="term-spark" viewBox="0 0 56 14" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

/** Line chart of a watched number: one point per run. */
function SeriesChart({ values }: { values: number[] }): ReactNode {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const step = 600 / (values.length - 1);
  const xy = values.map((v, i): [number, number] => [i * step, 58 - ((v - low) / span) * 52]);
  const points = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <figure className="term-chart">
      <svg viewBox="0 0 600 64" preserveAspectRatio="none">
        <polygon points={`0,64 ${points} 600,64`} />
        <polyline points={points} />
        <LineHover
          width={600}
          height={64}
          points={xy}
          band={Math.max(8, Math.min(32, step))}
          color="var(--sig)"
          label={`Watched value over ${values.length} runs`}
          card={(i) => {
            const prev = values[i - 1];
            const delta = prev === undefined ? 0 : values[i]! - prev;
            return {
              title: `Run ${i + 1} of ${values.length}`,
              rows: [
                { label: "Value", value: String(values[i]), color: "var(--sig)" },
                { label: "Range", value: `${low} – ${high}` },
              ],
              foot:
                prev === undefined
                  ? undefined
                  : {
                      label: "vs previous run",
                      value: `${delta >= 0 ? "+" : "−"}${Math.abs(Number(delta.toFixed(3)))}`,
                    },
            };
          }}
        />
      </svg>
      <figcaption>
        <span>min {low}</span>
        <span>max {high}</span>
        <b>now {values.at(-1)}</b>
        <span>{values.length} runs</span>
      </figcaption>
    </figure>
  );
}

/** Seconds since `since`, counting while it is shown. */
function Elapsed({ since }: { since: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** "▲ from 32%" when the first changed word of a line is a number. */
function changeNote(before: string | undefined, after: string): ReactNode {
  if (before === undefined) return null;
  const a = before.trim().split(/\s+/);
  const b = after.trim().split(/\s+/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const was = Number.parseFloat(a[i] ?? "");
    const now = Number.parseFloat(b[i] ?? "");
    if (Number.isNaN(was) || Number.isNaN(now) || was === now) return null;
    return <span className="g">{`   ${now > was ? "▲" : "▼"} from ${a[i]}`}</span>;
  }
  return null;
}

/** Header lines of a print: "Flags: …", "Columns: …" and the column titles. */
const HEAD_LINE = /^\s*(Flags|Columns):|^\s*#?\s*[A-Z][A-Z0-9-]+(\s{2,}[A-Z][A-Z0-9-]+)+\s*$/;
/** "   uptime: 2d21h", the detail form of a print. */
const KEY_LINE = /^(\s*)([\w.-]+:)(\s.*)?$/;

function BlockViewBase({
  block,
  device,
  watching,
  watchEvery,
  comparing,
  cursor,
  onAction,
  onMenu,
  onToken,
}: {
  block: Block;
  device: string;
  watching: boolean;
  watchEvery: number;
  onMenu: (block: Block, x: number, y: number) => void;
  onToken: (token: OutputToken, x: number, y: number) => void;
  /** This block is the first side of a comparison. */
  comparing: boolean;
  /** The arrow keys are on this block. */
  cursor: boolean;
  onAction: (action: string, block: Block) => void;
}) {
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLElement>(null);
  // A new block slides in.
  useLayoutEffect(() => {
    if (root.current) arrive(root.current);
  }, []);
  const copy = (): void => {
    void navigator.clipboard.writeText(block.output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const isScript = /(?:^|\s)export(?:\s|$)/.test(block.command);
  const body = useMemo(() => {
    if (!block.output) return null;
    if (isScript && block.output.length < 60_000)
      return <Spans lines={staticSpans(block.output)} />;
    if (block.output.length > 120_000) return block.output;
    const changed = block.changed;
    const lines = block.output.split("\n");
    // IP and MAC addresses open a menu of commands about them.
    const paint = (line: string, row: number): ReactNode => {
      if (HEAD_LINE.test(line)) return <span className="f">{line}</span>;
      const parts = tokenize(line).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <span
            // eslint-disable-next-line react/no-array-index-key -- the same address may repeat
            key={`${row}-${i}`}
            className="tok"
            role="button"
            tabIndex={-1}
            onClick={(event) => onToken(part, event.clientX, event.clientY)}
          >
            {part.value}
          </span>
        ),
      );
      const kv = parts.length === 1 && typeof parts[0] === "string" ? KEY_LINE.exec(line) : null;
      if (!kv) return parts;
      return (
        <>
          {kv[1]}
          <span className="k">{kv[2]}</span>
          {kv[3] && <span className="v">{kv[3]}</span>}
        </>
      );
    };
    return lines.map((line, i) =>
      changed?.has(i) ? (
        // eslint-disable-next-line react/no-array-index-key -- lines have no identity
        <span key={i} className="chg">
          {paint(line, i)}
          {changeNote(block.changedFrom?.[i], line)}
        </span>
      ) : (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i}>
          {paint(line, i)}
          {i < lines.length - 1 && !changed?.has(i + 1) ? "\n" : ""}
        </span>
      ),
    );
  }, [block.output, block.changed, block.changedFrom, isScript, onToken]);

  const isPrint = /\bprint\b/.test(block.command) && block.status === "ok";
  return (
    <article
      ref={root}
      className="term-blk"
      data-status={block.status}
      data-watch={watching || undefined}
      data-block-id={block.id}
      data-cursor={cursor || undefined}
      data-comparing={comparing || undefined}
      onContextMenu={(event) => {
        // Shift + right-click keeps the browser's own menu.
        if (event.shiftKey) return;
        event.preventDefault();
        onMenu(block, event.clientX, event.clientY);
      }}
    >
      <header className="term-blk-h">
        <button
          type="button"
          className="term-fold"
          onClick={() => onAction("fold", block)}
          aria-label={block.collapsed ? "Show output" : "Hide output"}
        >
          {block.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="pr" title={device}>
          ›
        </span>
        <code className="cmd">
          <Spans lines={staticSpans(block.command)} />
        </code>
        <span className="sp" />
        {watching && block.status !== "running" && (
          <span className="term-ch" data-tone="w">
            watch · {seconds(watchEvery)} · ×{block.runs}
          </span>
        )}
        {block.status === "running" && (
          <span className="term-ch" data-tone="r">
            {block.note ?? (
              <>
                running · <Elapsed since={block.started ?? block.ts} />
              </>
            )}
          </span>
        )}
        {block.status === "ok" && (
          <span className="term-ch" data-tone="ok">
            ✓ {block.ms} ms
          </span>
        )}
        {block.status === "stopped" && <span className="term-ch">stopped · {block.ms} ms</span>}
        {block.status === "error" && (
          <span className="term-ch" data-tone="bad">
            ✕ failed · {block.ms} ms
          </span>
        )}
        {block.runs > 1 && !watching && <span className="term-ch">×{block.runs}</span>}
        {block.undo && (
          <button
            type="button"
            className="term-ch term-ch-btn"
            onClick={() => onAction("undo", block)}
            title={`Put the opposite command in the input: ${block.undo}`}
          >
            <Undo2 size={11} /> undo
          </button>
        )}
        {block.snapshot && (
          <button
            type="button"
            className="term-ch term-ch-btn"
            onClick={() => onAction("changes", block)}
            title="A snapshot was stored before this command. Show what differs from it now."
          >
            <History size={11} /> what changed?
          </button>
        )}
        {block.alert && (
          <span className="term-ch" data-tone="bad" title={block.alert}>
            <BellRing size={11} /> {block.alert}
          </span>
        )}
        {block.status !== "running" && (
          <time className="term-ch term-time" dateTime={new Date(block.ts).toISOString()}>
            {clockTime(block.ts)}
          </time>
        )}
        <span className="acts">
          {/* Stop and Run again never share a click: a late click on Stop must
              not run a finished command a second time. */}
          {block.status === "running" ? (
            <button type="button" onClick={() => onAction("stop", block)} title="Stop (Ctrl+C)">
              <Square size={13} />
            </button>
          ) : watching ? (
            <button type="button" onClick={() => onAction("watch", block)} title="Stop watching">
              <Square size={13} />
            </button>
          ) : (
            <button type="button" onClick={() => onAction("rerun", block)} title="Run again">
              <Play size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onAction("watch", block)}
            title={watching ? "Stop watching" : "Watch: run again on a timer and mark what changed"}
            data-on={watching || undefined}
          >
            <Eye size={13} />
          </button>
          {isPrint && (
            <button
              type="button"
              onClick={() => onAction("table", block)}
              title={block.table ? "Show as text" : "Show as a table"}
              data-on={block.table || undefined}
            >
              <Table2 size={13} />
            </button>
          )}
          {block.status !== "error" && (
            <button
              type="button"
              className="wide"
              onClick={() => onAction("chart", block)}
              title="Chart a number of this block while it is watched"
              data-on={(block.series?.length ?? 0) > 1 || undefined}
            >
              <ChartLine size={13} />
            </button>
          )}
          {block.status !== "running" && block.status !== "error" && (
            <button
              type="button"
              className="wide"
              onClick={() => onAction("pin", block)}
              title={block.pinned ? "Unpin" : "Pin to the top of the pane"}
              data-on={block.pinned || undefined}
            >
              <Pin size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            disabled={!block.output && !block.error}
            title="Copy output"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </span>
      </header>
      {block.status === "running" && (
        <div className="term-blk-prog" aria-hidden="true">
          <Shimmer />
        </div>
      )}
      {!block.collapsed && (
        <>
          {block.series && block.series.length > 1 && <SeriesChart values={block.series} />}
          {block.table && block.output ? (
            <RecordTable output={block.output} />
          ) : (
            body !== null && <pre className="term-blk-o">{body}</pre>
          )}
          {block.status !== "running" && !block.output && !block.error && (
            <div className="term-blk-empty">no output</div>
          )}
          {block.error && (
            <pre className="term-blk-o">
              <span className="err">{block.error}</span>
            </pre>
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
      changedFrom: undefined,
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
  /** Name of the number to chart for the watched block, e.g. `cpu-load`. */
  const [chartKey, setChartKey] = useState("");
  const chartKeyRef = useRef(chartKey);
  chartKeyRef.current = chartKey;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chartField = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ id: number; x: number; y: number; selection: string } | null>(
    null,
  );
  const [tokenMenu, setTokenMenu] = useState<{ token: OutputToken; x: number; y: number } | null>(
    null,
  );
  /** The block the arrow keys are on; null while typing a new command. */
  const [cursorBlock, setCursorBlock] = useState<number | null>(null);
  /** False while the user has scrolled up from the end. */
  const [atEnd, setAtEnd] = useState(true);
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
          started: Date.now(),
          error: undefined,
          note: undefined,
          runs: b.runs + 1,
        }));
      else
        setBlocks((list) => [
          ...list,
          {
            id,
            ts: Date.now(),
            started: Date.now(),
            command,
            output: "",
            status: "running",
            runs: 1,
          },
        ]);
      // `… | grep x | count` filters the output here; the router gets the command only.
      const sent = splitPipes(command);
      // An `add` is wrapped so the router prints the new id, which the undo needs.
      const plan = planUndo(sent.command);
      const toRun = plan?.kind === "add" ? plan.wrapped : sent.command;
      const abort = new AbortController();
      running.current.set(id, abort);
      // A new command jumps to the end; a watch tick must not move the view.
      if (!options.quiet) {
        stick.current = true;
        setAtEnd(true);
      }

      let end: RunEnd = { ok: false, ms: 0 };
      let buffer = "";
      for (let attempt = 1; ; attempt++) {
        buffer = "";
        // A watched block keeps its old output until the new run is complete.
        if (!options.quiet) patch(id, { output: "", changed: undefined });
        end = await runCommand(device, toRun, {
          maxMs: limitRef.current,
          snapshot: guardRef.current,
          signal: abort.signal,
          onOutput: (text) => {
            buffer = (buffer + cleanOutput(text)).slice(-MAX_BLOCK_CHARS);
            if (!options.quiet) patch(id, { output: applyPipes(buffer, sent.filters) });
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
      const output = applyPipes(buffer.replace(/\n+$/, ""), sent.filters);
      const result = end;
      // A watched run may raise an alert; it notifies once, when it starts to hold.
      const earlier = blocksRef.current.find((b) => b.id === id);
      const alert =
        options.quiet && result.ok
          ? (evalAlert(alertRuleRef.current, output, earlier?.output ?? "") ?? undefined)
          : undefined;
      if (alert && !earlier?.alert) notify(`${device}: ${command}`, alert);
      const charted =
        options.quiet && result.ok ? readNumber(output, chartKeyRef.current) : undefined;
      patch(id, (b) => {
        let changed: Set<number> | undefined;
        let changedFrom: Record<number, string> | undefined;
        if (options.quiet && b.output && b.output !== output) {
          const before = b.output.split("\n");
          const differing = new Set<number>();
          changedFrom = {};
          output.split("\n").forEach((line, i) => {
            if (line === before[i]) return;
            differing.add(i);
            if (before[i] !== undefined) changedFrom![i] = before[i]!;
          });
          changed = differing;
        }
        return {
          output,
          changed,
          changedFrom,
          alert,
          undo: !result.ok
            ? undefined
            : plan?.kind === "known"
              ? plan.undo
              : plan?.kind === "add"
                ? undoOfAdd(plan.path, output)
                : undefined,
          series: charted === undefined ? b.series : [...(b.series ?? []), charted].slice(-120),
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
      setCursorBlock(null);
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

  const closeMenus = (): void => {
    setMenu(null);
    setTokenMenu(null);
  };
  const openToken = useCallback((token: OutputToken, x: number, y: number): void => {
    // A click that ends a text selection is a copy gesture, not a menu request.
    if (window.getSelection()?.toString()) return;
    setMenu(null);
    setTokenMenu({ token, x, y });
  }, []);
  // ── context menu of a block ─────────────────────────────────────────────
  const openMenu = useCallback((block: Block, x: number, y: number): void => {
    setTokenMenu(null);
    setMenu({ id: block.id, x, y, selection: window.getSelection()?.toString() ?? "" });
  }, []);

  const onAction = useCallback(
    (action: string, block: Block): void => {
      if (action === "stop") running.current.get(block.id)?.abort();
      else if (action === "rerun") void submit(block.command);
      else if (action === "fold") patch(block.id, { collapsed: !block.collapsed });
      else if (action === "table") patch(block.id, { table: !block.table });
      else if (action === "pin") patch(block.id, { pinned: !block.pinned });
      else if (action === "schedule") workspace.onSchedule(block.command);
      else if (action === "undo" && block.undo) {
        // Shown for review; the user runs it.
        setInput(block.undo);
        field.current?.focus();
      } else if (action === "changes")
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
      else if (action === "chart") {
        // A chart needs runs: watch the block, then name the number to chart.
        setWatch(block.id);
        setSettingsOpen(true);
        setTimeout(() => chartField.current?.focus(), 60);
      } else if (action === "remove") {
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

  /** Mark a block as the one the arrows are on, show its command, and bring it into view. */
  const walkTo = (block: Block): void => {
    setCursorBlock(block.id);
    recallInto(block.command);
    stick.current = false;
  };
  // Bring the marked block into view once it is rendered as marked.
  useEffect(() => {
    if (cursorBlock === null) return;
    scroller.current
      ?.closest(".term-pane")
      ?.querySelector(`[data-block-id="${cursorBlock}"]`)
      // The top of the block: its command line must be in view, also for a long output.
      ?.scrollIntoView({ block: "start" });
  }, [cursorBlock]);

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
      // Walk up the blocks of this pane: its command goes to the field and the
      // block is marked and scrolled into view. With no block, recall the history.
      const list = blocksRef.current;
      const state = recall.current;
      if (list.length) {
        event.preventDefault();
        const at = list.findIndex((block) => block.id === cursorBlock);
        if (at === -1) state.draft = input;
        const target = list[at === -1 ? list.length - 1 : Math.max(0, at - 1)];
        if (target) walkTo(target);
        return;
      }
      if (!state.list.length) return;
      event.preventDefault();
      if (state.index === -1) state.draft = input;
      state.index = state.index === -1 ? state.list.length - 1 : Math.max(0, state.index - 1);
      recallInto(state.list[state.index] ?? "");
    } else if (event.key === "ArrowDown" && !input.slice(area.selectionEnd).includes("\n")) {
      const list = blocksRef.current;
      const state = recall.current;
      const at = list.findIndex((block) => block.id === cursorBlock);
      if (at !== -1) {
        event.preventDefault();
        const target = list[at + 1];
        if (target) walkTo(target);
        else {
          // Past the last block: back to what was being typed, at the end of the pane.
          setCursorBlock(null);
          recallInto(state.draft);
          stick.current = true;
          const box = scroller.current;
          if (box) box.scrollTop = box.scrollHeight;
        }
        return;
      }
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
  const renderBlock = (block: Block): ReactNode => (
    <BlockView
      key={block.id}
      block={block}
      device={device}
      watching={watch === block.id}
      watchEvery={watchEvery}
      comparing={comparePick === `${paneId}:${block.id}`}
      cursor={cursorBlock === block.id}
      onAction={onAction}
      onMenu={openMenu}
      onToken={openToken}
    />
  );
  const menuBlock = menu ? blocks.find((b) => b.id === menu.id) : undefined;
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
  /** Start a shared view and show its link as a block (also copied when allowed). */
  const shareView = async (): Promise<void> => {
    let output = "";
    let error: string | undefined;
    try {
      const link = await terminalApi.share(device);
      void navigator.clipboard?.writeText(link).catch(() => {});
      output = `${link}\n\nRead-only view of the commands on ${device} from now, for 24 hours.\nThe viewer needs access to this dashboard. The link does not limit that access.`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    setBlocks((list) => [
      ...list,
      {
        id: nextBlockId++,
        ts: Date.now(),
        command: "# share this terminal",
        output,
        error,
        status: error ? "error" : "ok",
        ms: 0,
        runs: 1,
      },
    ]);
  };
  const clear = (): void => setBlocks((list) => list.filter((b) => b.status === "running"));
  const exportAs = (format: ExportFormat): void => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadText(`${device}-${stamp}.${format}`, exportSession(device, blocks, format));
  };

  const copyText = (text: string): void => void navigator.clipboard.writeText(text);
  /** Everything a block can do, for its right-click menu. */
  const blockMenu = (block: Block, selection: string): PointItem[][] => [
    [
      ...(selection
        ? [
            {
              label: "Copy selected text",
              icon: <Copy size={14} />,
              onSelect: () => copyText(selection),
            },
          ]
        : []),
      block.status === "running"
        ? {
            label: "Stop",
            icon: <Square size={14} />,
            danger: true,
            onSelect: () => onAction("stop", block),
          }
        : {
            label: "Run again",
            icon: <Play size={14} />,
            shortcut: "R",
            onSelect: () => onAction("rerun", block),
          },
      {
        label: "Edit in the input",
        icon: <Pencil size={14} />,
        onSelect: () => {
          setInput(block.command);
          field.current?.focus();
        },
      },
      {
        label: watch === block.id ? "Stop watching" : `Watch every ${seconds(watchEvery)}`,
        icon: <Eye size={14} />,
        onSelect: () => onAction("watch", block),
      },
      {
        label: block.table ? "Show as text" : "Show as a table",
        icon: <Table2 size={14} />,
        disabled: !block.output,
        onSelect: () => onAction("table", block),
      },
      {
        label: comparePick ? "Compare with the picked block" : "Compare with…",
        icon: <GitCompareArrows size={14} />,
        disabled: !block.output,
        onSelect: () => onAction("compare", block),
      },
      {
        label: "Schedule…",
        icon: <CalendarDays size={14} />,
        onSelect: () => onAction("schedule", block),
      },
    ],
    [
      {
        label: "Copy output",
        icon: <Copy size={14} />,
        shortcut: "Ctrl C",
        disabled: !block.output,
        onSelect: () => copyText(block.output),
      },
      {
        label: "Copy command",
        icon: <CornerDownLeft size={14} />,
        onSelect: () => copyText(block.command),
      },
      {
        label: "Save as .txt",
        icon: <Download size={14} />,
        onSelect: () => onAction("save", block),
      },
      {
        label: starred.has(block.command) ? "Remove from favourites" : "Add to favourites",
        icon: <Star size={14} />,
        onSelect: () => onAction("star", block),
      },
      {
        label: block.pinned ? "Unpin" : "Pin to the top of the pane",
        icon: <Pin size={14} />,
        onSelect: () => onAction("pin", block),
      },
      ...(block.snapshot
        ? [
            {
              label: "What changed since the snapshot?",
              icon: <History size={14} />,
              onSelect: () => onAction("changes", block),
            },
          ]
        : []),
      {
        label: block.collapsed ? "Show output" : "Hide output",
        icon: block.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />,
        onSelect: () => onAction("fold", block),
      },
    ],
    [
      {
        label: "Remove",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => onAction("remove", block),
      },
    ],
  ];

  /** A key from the phone key row, sent to the command line as if typed. */
  const press = (key: string, ctrlKey = false): void => {
    const area = field.current;
    if (!area) return;
    area.focus();
    area.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
    );
  };
  const typeChar = (ch: string): void => {
    const area = field.current;
    const at = area?.selectionStart ?? input.length;
    setInput(input.slice(0, at) + ch + input.slice(area?.selectionEnd ?? at));
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(at + ch.length, at + ch.length);
    });
  };

  const badText = fromRouter
    ? fromRouter
        .flat()
        .filter((span) => span.bad)
        .map((span) => span.text)
        .join("")
        .trim()
    : "";
  const caretCol = input
    .slice(0, field.current?.selectionStart ?? input.length)
    .split("\n")
    .at(-1)?.length;
  const others = workspace.broadcast
    ? paneRegistry
        .all()
        .filter((pane) => pane.id !== paneId)
        .filter(
          (pane) =>
            !workspace.broadcast?.devices || workspace.broadcast.devices.includes(pane.device),
        ).length
    : 0;

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
      <header className="term-st">
        <span
          className="term-link"
          data-link={conn.link}
          title={conn.link === "reconnecting" ? `Attempt ${conn.attempt}` : undefined}
        >
          <Led tone={conn.link === "online" ? "ok" : conn.link === "connecting" ? "warn" : "bad"} />
          <b>
            {conn.link === "online" && "connected"}
            {conn.link === "connecting" && "connecting…"}
            {conn.link === "reconnecting" && `retry in ${retryIn} s`}
          </b>
        </span>
        {conn.identity && <span className="term-st-id">{conn.identity}</span>}
        {conn.transport && <span className="term-st-tr">{conn.transport.toUpperCase()}</span>}
        <span
          className="term-lat"
          data-tone={latencyTone(last)}
          {...tipProps(() => {
            const l = conn.latency;
            const prev = l.at(-2);
            const avg = l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : undefined;
            return {
              title: "Round trip",
              sub: conn.transport,
              rows: [
                { label: "Last probe", value: last === undefined ? "—" : `${last} ms` },
                { label: "Average", value: avg === undefined ? "—" : `${avg} ms` },
                { label: "Lowest", value: l.length ? `${Math.min(...l)} ms` : "—" },
                { label: "Highest", value: l.length ? `${Math.max(...l)} ms` : "—" },
              ],
              foot:
                last !== undefined && prev !== undefined
                  ? {
                      label: `vs previous probe · last ${l.length}`,
                      value: `${last - prev >= 0 ? "+" : "−"}${Math.abs(last - prev)} ms`,
                      // Slower is worse: a rise shows in pink.
                      tone: last > prev ? "down" : last < prev ? "up" : undefined,
                    }
                  : { label: "Probes", value: String(l.length) },
            };
          })}
        >
          <Sparkline values={conn.latency} />
          <span>{last === undefined ? "— ms" : `${last} ms`}</span>
        </span>
        <span className="sp" />
        {conn.safeMode && (
          <span className="term-st-chip" data-tone="safe" role="group" aria-label="Safe Mode">
            <ShieldCheck size={12} /> Safe Mode
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
        )}
        {!conn.safeMode && (
          <button
            type="button"
            className="term-ib"
            disabled={safeBusy || conn.link !== "online"}
            onClick={() => void safeMode("enable")}
            aria-label="Start Safe Mode"
            title="Safe Mode: the router undoes your uncommitted changes if this session is lost. Changes run through one Safe Mode session until you commit or roll back."
          >
            <Shield size={14} />
          </button>
        )}
        <Pop
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          label="Pane settings"
          width={320}
          trigger={
            <button
              type="button"
              className="term-ib"
              data-on={settingsOpen || undefined}
              aria-label="Pane settings"
              title="Pane settings"
            >
              <SlidersHorizontal size={14} />
              {(guard || !autoRetry) && <i className="term-ib-mark" />}
            </button>
          }
        >
          <div className="term-pop-row">
            <span>
              <b>Auto-retry</b>
              <small>
                Only when the router was not reached, or the command only reads. A change that may
                already have run is never sent twice.
              </small>
            </span>
            <Switch checked={autoRetry} onCheckedChange={setAutoRetry} aria-label="Auto-retry" />
          </div>
          <div className="term-pop-row">
            <span>
              <b>Snapshot before changes</b>
              <small>Stored on this computer. If it fails, the command does not run.</small>
            </span>
            <Switch
              checked={guard}
              onCheckedChange={setGuard}
              aria-label="Snapshot before changes"
            />
          </div>
          <div className="term-pop-row">
            <span>
              <b>Time limit</b>
              <small>A command is stopped after this long.</small>
            </span>
            <Select
              size="sm"
              label="Command time limit"
              value={String(limit)}
              onChange={(value) => setLimit(Number(value))}
              options={LIMIT_CHOICES.map((ms) => ({ value: String(ms), label: seconds(ms) }))}
              style={{ width: 96 }}
            />
          </div>
          <div className="term-pop-row">
            <span>
              <b>Watch every</b>
              <small>How often a watched block runs again.</small>
            </span>
            <Select
              size="sm"
              label="Watch interval"
              value={String(watchEvery)}
              onChange={(value) => setWatchEvery(Number(value))}
              options={WATCH_CHOICES.map((ms) => ({ value: String(ms), label: seconds(ms) }))}
              style={{ width: 96 }}
            />
          </div>
          <Field
            className="term-pop-row term-pop-field"
            label={
              <>
                <ChartLine size={12} /> Chart a number of the watched block
              </>
            }
          >
            <TextInput
              ref={chartField}
              size="sm"
              mono
              value={chartKey}
              placeholder="cpu-load"
              spellCheck={false}
              onChange={setChartKey}
            />
          </Field>
          <Field
            className="term-pop-row term-pop-field"
            label={
              <>
                <BellRing size={12} /> Alert when the watched block…
              </>
            }
          >
            <TextInput
              size="sm"
              mono
              value={alertRule}
              placeholder="changed · cpu-load > 80 · /down|error/"
              spellCheck={false}
              onChange={setAlertRule}
            />
          </Field>
          <p className="term-pop-foot">
            {conn.transport ?? "not connected"} · {stats.total} command
            {stats.total === 1 ? "" : "s"}
            {stats.failed > 0 && ` · ${stats.failed} failed`}
          </p>
        </Pop>
        <Menu
          label="More actions"
          trigger={
            <button
              type="button"
              className="term-ib"
              aria-label="More actions"
              title="More actions"
            >
              <Ellipsis size={15} />
            </button>
          }
          groups={[
            [
              {
                label: "Run a script…",
                icon: <FileCode2 size={14} />,
                onSelect: () => scriptStore.open(paneId),
              },
              {
                label: "Share a read-only view",
                icon: <Share2 size={14} />,
                onSelect: () => void shareView(),
              },
              {
                label: "Check the connection now",
                icon: <RotateCw size={14} />,
                onSelect: () => probeNow.current(),
              },
            ],
            [
              {
                label: "Save transcript (.txt)",
                icon: <Download size={14} />,
                onSelect: () => exportAs("txt"),
              },
              {
                label: "Save report (.md)",
                icon: <Download size={14} />,
                onSelect: () => exportAs("md"),
              },
              {
                label: "Save commands that ran (.rsc)",
                icon: <Download size={14} />,
                onSelect: () => exportAs("rsc"),
              },
            ],
            [
              {
                label: "Clear this pane",
                icon: <Eraser size={14} />,
                shortcut: "Ctrl L",
                onSelect: clear,
              },
            ],
          ]}
        />
      </header>

      {conn.link === "reconnecting" && conn.error && (
        <div className="term-banner">
          <TriangleAlert size={13} /> {conn.error}
        </div>
      )}

      {blocks.some((block) => block.pinned) && (
        <div className="term-pinned" aria-label="Pinned blocks">
          <div className="term-pinned-head">
            <Pin size={11} /> Pinned · {blocks.filter((block) => block.pinned).length}
            <button
              type="button"
              onClick={() => setBlocks((list) => list.map((b) => ({ ...b, pinned: false })))}
              title="Move the pinned blocks back into the list"
            >
              Unpin all
            </button>
          </div>
          {blocks.filter((block) => block.pinned).map(renderBlock)}
        </div>
      )}
      <div className="term-scroll-wrap">
        <div
          className="term-scroll"
          ref={scroller}
          onScroll={(event) => {
            const box = event.currentTarget;
            const end = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
            stick.current = end;
            setAtEnd(end);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) field.current?.focus();
          }}
        >
          {blocks.length === 0 && (
            <div className="term-welcome">
              <strong>{conn.identity ?? device}</strong>
              <span>
                Type a RouterOS command. Tab completes from the router, ↑ recalls history.
              </span>
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
          {blocks.filter((block) => !block.pinned).map(renderBlock)}
        </div>
        {!atEnd && (
          <button
            type="button"
            className="term-to-end"
            onClick={() => {
              const box = scroller.current;
              if (!box) return;
              // Not animated: a smooth scroll does not run while the tab is in the background.
              box.scrollTop = box.scrollHeight;
              stick.current = true;
              setAtEnd(true);
            }}
            title="Go to the end of this terminal"
            aria-label="Go to the end of this terminal"
          >
            <ArrowDownToLine size={15} />
          </button>
        )}
      </div>

      <PointMenu
        at={tokenMenu}
        onClose={() => setTokenMenu(null)}
        label={`Commands for ${tokenMenu?.token.value ?? ""}`}
        head={tokenMenu && <b>{tokenMenu.token.value}</b>}
        width={280}
        groups={
          tokenMenu
            ? [
                tokenCommands(tokenMenu.token).map((item) => ({
                  label: item.label,
                  onSelect: () => {
                    setInput(item.command);
                    field.current?.focus();
                  },
                })),
                [
                  {
                    label: "Copy",
                    icon: <Copy size={14} />,
                    onSelect: () => copyText(tokenMenu.token.value),
                  },
                ],
              ]
            : []
        }
      />
      <PointMenu
        at={menu && menuBlock ? menu : null}
        onClose={closeMenus}
        label="Block actions"
        head={
          menuBlock && (
            <>
              <b>{menuBlock.command}</b>
              <span>
                {device}
                {menuBlock.ms !== undefined && ` · ${menuBlock.ms} ms`} · {clockTime(menuBlock.ts)}
              </span>
            </>
          )
        }
        groups={menuBlock && menu ? blockMenu(menuBlock, menu.selection) : []}
      />

      {confirm && (
        <div className="term-cf" role="alertdialog" aria-label="Confirm command">
          <span className="ic">
            <TriangleAlert size={15} />
          </span>
          <div>
            <b>
              <code>{confirm.word}</code> changes configuration on {device}
            </b>
            {others > 0 && (
              <small>
                and on the {others} other pane{others === 1 ? "" : "s"} you broadcast to.
              </small>
            )}
          </div>
          <span className="sp" />
          <button
            type="button"
            className="term-act"
            onClick={() => {
              setInput(confirm.command);
              setConfirm(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="term-act"
            data-tone="bad"
            onClick={() => void submit(confirm.command, { confirmed: true })}
          >
            Run it
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
          onKeyDown={(event) => {
            if (event.key === "Escape") setFill(null);
          }}
        >
          <div className="term-fill-hd">
            Fill in the snippet
            <button
              type="button"
              className="term-ib"
              aria-label="Cancel"
              title="Cancel (Esc)"
              onClick={() => {
                setInput(fill.command);
                setFill(null);
              }}
            >
              <X size={14} />
            </button>
          </div>
          <code className="pv">
            {fill.command.split(/(\{\{[^}]*\}\})/).map((part, i) => {
              const name = /^\{\{([^}=]+)/.exec(part)?.[1]?.trim();
              return name ? (
                // eslint-disable-next-line react/no-array-index-key -- a name may repeat
                <u key={i}>{fill.values[name] || name}</u>
              ) : (
                part
              );
            })}
          </code>
          <div className="term-fill-row">
            {snippetFields(fill.command).map((item, i) => (
              <TextInput
                key={item.name}
                size="sm"
                mono
                prefix={item.name}
                label={item.name}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the form opens on a key press
                autoFocus={i === 0}
                value={fill.values[item.name] ?? ""}
                placeholder={item.fallback}
                spellCheck={false}
                wrapClassName="term-fill-in"
                onChange={(value) =>
                  setFill({ ...fill, values: { ...fill.values, [item.name]: value } })
                }
              />
            ))}
            <button type="submit" className="term-act" data-tone="go">
              Run
            </button>
          </div>
        </form>
      )}

      <footer className="term-inp" data-error={syntaxError || undefined}>
        <div className="term-inp-line">
          <span className="pr">›</span>
          <div className="term-editor">
            <pre className="term-editor-paint" aria-hidden="true">
              <Spans lines={inputSpans} />
              {ghost && <span className="gh">{ghost.slice(input.length)}</span>}
              {"​"}
            </pre>
            {/* kit-exempt: the terminal command line, not a form field */}
            <textarea
              ref={field}
              value={input}
              rows={Math.min(8, input.split("\n").length)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={`Command for ${device}`}
              placeholder="Type a command, or ↑ for the last one"
              onChange={(event) => {
                setInput(event.target.value);
                setCompletions(null);
                // Typing ends a walk through the blocks or the history.
                recall.current.index = -1;
                setCursorBlock(null);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => setTimeout(() => setCompletions(null), 150)}
            />
          </div>
          {ghost && <span className="hint">→ accept</span>}
          {completions && (
            <ul
              className="term-cmp"
              role="listbox"
              ref={completeList}
              style={{ left: `min(calc(${caretCol ?? 0}ch + 24px), calc(100% - 412px))` }}
            >
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
                  <b>{item.completion}</b>
                  <span>{helpText.get(item.completion) ?? ""}</span>
                  <small>{item.style}</small>
                </li>
              ))}
              <li className="ft" aria-hidden="true">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move <Kbd>Tab</Kbd> accept <Kbd>Esc</Kbd> close
              </li>
            </ul>
          )}
        </div>
        <div className="term-inp-ft">
          <span
            className="term-check"
            data-state={fromRouter === null ? "idle" : syntaxError ? "bad" : "ok"}
          >
            {fromRouter === null
              ? ""
              : syntaxError
                ? `router: syntax error${badText ? ` at “${badText}”` : ""}`
                : "router: syntax ok"}
          </span>
          <span className="sp" />
          <span>
            <Kbd>Tab</Kbd> complete
          </span>
          <span>
            <Kbd>↑</Kbd> blocks
          </span>
          <span>
            <Kbd>Shift</Kbd>
            <Kbd>↵</Kbd> new line
          </span>
          <button
            type="button"
            className="term-ib sm"
            data-on={showHelp || undefined}
            onClick={() => setShowHelp((on) => !on)}
            aria-label="Help from the router"
            title="Help from the router for the word being typed"
          >
            <CircleHelp size={13} />
          </button>
          <button
            type="button"
            className="term-ib sm"
            disabled={!input.trim()}
            data-on={starred.has(input.trim()) || undefined}
            onClick={() => void favoritesStore.toggle(input.trim())}
            aria-label="Save as a favourite"
            title="Save what is typed as a favourite. Use {{name}} or {{name=default}} for values asked at run time."
          >
            <Star size={13} fill={starred.has(input.trim()) ? "currentColor" : "none"} />
          </button>
        </div>
        {showHelp && helpItems.length > 0 && (
          <div className="term-helps" aria-label="Help from the router">
            {helpItems.slice(0, 24).map((item, i) => (
              // eslint-disable-next-line react/no-array-index-key -- notes have no symbol
              <span key={`${item.symbol}-${i}`} data-nested={item.nested}>
                {item.symbol && <b>{item.symbol}</b>}
                {item.text}
              </span>
            ))}
          </div>
        )}
        <div className="term-keys" role="group" aria-label="Keys">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press("Tab")}
          >
            Tab
          </button>
          <button
            type="button"
            aria-label="Up"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press("ArrowUp")}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Down"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press("ArrowDown")}
          >
            ↓
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => typeChar("|")}
          >
            |
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => typeChar("/")}
          >
            /
          </button>
          <button
            type="button"
            aria-label="Stop the running command"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press("c", true)}
          >
            ^C
          </button>
          <button
            type="button"
            className="go"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press("Enter")}
          >
            Run
          </button>
        </div>
      </footer>
    </section>
  );
}
