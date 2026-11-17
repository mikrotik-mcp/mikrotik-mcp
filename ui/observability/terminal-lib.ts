/**
 * Dashboard terminal — browser-side plumbing shared by the page and its panes:
 * the streamed command runner, API calls, command checks and the pane registry.
 */
import { api, deleteJson, postJson, withToken } from "./api";

export interface TerminalState {
  enabled: boolean;
  reason: string | null;
  readOnly: boolean;
}
export interface HistoryEntry {
  id: number;
  ts: number;
  device: string;
  command: string;
  output: string;
  ok: boolean;
  ms: number;
  error?: string;
}
export interface Favorite {
  id: number;
  ts: number;
  label: string;
  command: string;
}
export interface Completion {
  completion: string;
  style: string;
  offset: number;
}
export interface SyntaxHelp {
  symbol: string;
  text: string;
  nested: number;
}
export interface Probe {
  ok: boolean;
  ms: number;
  identity?: string;
  transport?: string;
  error?: string;
  /** A Safe Mode session is open on this router. */
  safeMode?: boolean;
}
export interface RunEnd {
  ok: boolean;
  ms: number;
  error?: string;
  stopped?: boolean;
  transport?: string;
  /** Safe to send again without repeating a change on the router. */
  retryable?: boolean;
  /** A config snapshot was stored just before this command. */
  snapshot?: boolean;
}

const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
  fetch(withToken(path), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });

export const terminalApi = {
  state: () => api<TerminalState>("/api/terminal/state"),
  history: (filter: { device?: string; q?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (filter.device) query.set("device", filter.device);
    if (filter.q) query.set("q", filter.q);
    query.set("limit", String(filter.limit ?? 300));
    return api<{ entries: HistoryEntry[] }>(`/api/terminal/history?${query}`).then(
      (r) => r.entries,
    );
  },
  deleteHistory: (target: { id?: number; device?: string }) =>
    deleteJson<{ removed: number }>("/api/terminal/history", target),
  favorites: () =>
    api<{ favorites: Favorite[] }>("/api/terminal/favorites").then((r) => r.favorites),
  saveFavorite: (command: string, label?: string) =>
    postJson<{ favorite?: Favorite; error?: string }>("/api/terminal/favorites", {
      command,
      label,
    }),
  deleteFavorite: (id: number) =>
    deleteJson<{ removed: number }>("/api/terminal/favorites", { id }),
  probe: (device: string, signal?: AbortSignal): Promise<Probe> =>
    post("/api/terminal/probe", { device }, signal).then((r) => r.json() as Promise<Probe>),
  highlight: (device: string, input: string, signal?: AbortSignal): Promise<string[]> =>
    post("/api/terminal/highlight", { device, input }, signal)
      .then((r) => r.json() as Promise<{ tokens?: string[] }>)
      .then((r) => r.tokens ?? []),
  syntax: (device: string, input: string, signal?: AbortSignal): Promise<SyntaxHelp[]> =>
    post("/api/terminal/syntax", { device, input }, signal)
      .then((r) => r.json() as Promise<{ items?: SyntaxHelp[] }>)
      .then((r) => r.items ?? []),
  safeMode: (
    device: string,
    action: "enable" | "commit" | "rollback",
  ): Promise<{ ok?: boolean; message?: string; active?: boolean; error?: string }> =>
    post("/api/terminal/safe-mode", { device, action }).then((r) => r.json()),
  /** Start a shared view of a router; resolves with the link to give away. */
  share: (device: string): Promise<string> =>
    post("/api/terminal/share", { device })
      .then((r) => r.json() as Promise<{ id?: string; error?: string }>)
      .then((r) => {
        if (!r.id) throw new Error(r.error ?? "Could not start a shared view.");
        return `${location.origin}${location.pathname}?share=${r.id}#terminal`;
      }),
  /** Known commands and MCP tools whose words match a question (no language model). */
  suggest: (question: string, signal?: AbortSignal) =>
    api<{ commands: string[]; tools: { name: string; title: string }[] }>(
      `/api/terminal/suggest?q=${encodeURIComponent(question)}`,
      signal,
    ),
  /** Differences between the newest stored snapshot and the router now. */
  changes: (device: string): Promise<string> =>
    post("/api/terminal/changes", { device })
      .then((r) => r.json() as Promise<{ text?: string; error?: string }>)
      .then((r) => r.text ?? r.error ?? "No answer."),
  complete: (device: string, input: string, signal?: AbortSignal): Promise<Completion[]> =>
    post("/api/terminal/complete", { device, input }, signal)
      .then((r) => r.json() as Promise<{ completions?: Completion[] }>)
      .then((r) => r.completions ?? []),
};

const DESTRUCTIVE_RE =
  /(?:^|[\s/;[{])(remove|reset-configuration|reset|reboot|shutdown|format|format-drive|downgrade|uninstall|wipe)(?:$|[\s;\]}])/;
const READ_RE =
  /^\/?(?:[^;[\]{}]*\s)?(?:print|export)(?:\s[^;[\]{}]*)?$|^\/?(?:ping|tool[\s/]+(?:ping|traceroute|trace))(?:\s|$)/;

/** The word that makes a command destructive (`remove`, `reboot`, …), if any. */
export const destructiveWord = (command: string): string | undefined =>
  command.match(DESTRUCTIVE_RE)?.[1];
/** A command that only reads: safe to repeat. */
export const isReadCommand = (command: string): boolean => READ_RE.test(command.trim());

/**
 * Run one command and report output as it arrives. Resolves with the end
 * record; a network failure resolves as a retryable error, because the request
 * may not have reached the server (the server decides for commands it received).
 */
export async function runCommand(
  device: string,
  command: string,
  options: {
    maxMs?: number;
    /** Store a config snapshot first when the command is not a read. */
    snapshot?: boolean;
    signal?: AbortSignal;
    onOutput: (text: string) => void;
  },
): Promise<RunEnd> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let res: Response;
  try {
    res = await post(
      "/api/terminal/run",
      { device, command, maxMs: options.maxMs, snapshot: options.snapshot },
      options.signal,
    );
  } catch (e) {
    if (options.signal?.aborted) return { ok: true, ms: elapsed(), stopped: true };
    return {
      ok: false,
      ms: elapsed(),
      error: `Dashboard server unreachable: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
    };
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, ms: elapsed(), error: body?.error ?? `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let end: RunEnd | undefined;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      for (let cut = pending.indexOf("\n"); cut >= 0; cut = pending.indexOf("\n")) {
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { t: string; d?: string } & RunEnd;
        if (message.t === "out" && message.d) options.onOutput(message.d);
        else if (message.t === "end") end = message;
      }
    }
  } catch (e) {
    if (options.signal?.aborted) return { ok: true, ms: elapsed(), stopped: true };
    // The stream broke after the command was sent: its outcome is unknown.
    return {
      ok: false,
      ms: elapsed(),
      error: `Connection to the dashboard was lost: ${e instanceof Error ? e.message : String(e)}`,
      retryable: isReadCommand(command),
    };
  }
  return end ?? { ok: false, ms: elapsed(), error: "The server closed the stream early." };
}

/** Remove terminal control sequences and normalise line ends. */
export function cleanOutput(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n?/g, "\n")
  );
}

// ── pane registry: lets the page, the drawer and broadcast reach every pane ──

export interface PaneHandle {
  id: string;
  device: string;
  /** Resolves with the result, or `null` when the pane first asks the user something. */
  run: (command: string, options?: { fromBroadcast?: boolean }) => Promise<BroadcastResult | null>;
  insert: (command: string) => void;
  focus: () => void;
}
const panes = new Map<string, PaneHandle>();
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const listener of listeners) listener();
};

export const paneRegistry = {
  add(handle: PaneHandle): () => void {
    panes.set(handle.id, handle);
    changed();
    return () => {
      if (panes.get(handle.id) === handle) panes.delete(handle.id);
      changed();
    };
  },
  all: (): PaneHandle[] => Array.from(panes.values()),
  get: (id: string): PaneHandle | undefined => panes.get(id),
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export interface BroadcastResult extends RunEnd {
  device: string;
}
/** Where a broadcast goes: every open pane, or the panes of a group's routers. */
export interface BroadcastTarget {
  label: string;
  /** `null` means every router. */
  devices: string[] | null;
}
export interface BroadcastGroup {
  name: string;
  devices: string[];
}

/** Page-wide switches the panes read. */
export const workspace = {
  broadcast: null as BroadcastTarget | null,
  /** Opens the schedule drawer with a command to schedule. */
  onSchedule: (() => {}) as (command: string) => void,
  /** Called with every pane's result when a broadcast command has finished. */
  onBroadcastDone: (() => {}) as (command: string, results: BroadcastResult[]) => void,
  /** The pane that last had focus. */
  activePane: "" as string,
  /** Called after any command finishes, so the history drawer can refresh. */
  onCommandDone: (() => {}) as () => void,
  /** Called when a pane stars or unstars a command. */
  onFavoritesChanged: (() => {}) as () => void,
};

const LAYOUT_KEY = "mikrotik-mcp.terminal.layout.v1";
export const layoutStorage = {
  load(): unknown {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  save(layout: unknown): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* storage unavailable: the layout just does not persist */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(LAYOUT_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

// ── favourites: one shared list, read by every pane through useSyncExternalStore ──

let favoriteList: Favorite[] = [];
const favoriteListeners = new Set<() => void>();
export const favoritesStore = {
  get: (): Favorite[] => favoriteList,
  subscribe(listener: () => void): () => void {
    favoriteListeners.add(listener);
    return () => favoriteListeners.delete(listener);
  },
  async refresh(): Promise<void> {
    try {
      favoriteList = await terminalApi.favorites();
      for (const listener of favoriteListeners) listener();
    } catch {
      /* keep the last known list */
    }
  },
  /** Star the command, or unstar it when it is already a favourite. */
  async toggle(command: string): Promise<boolean> {
    const existing = favoriteList.find((f) => f.command === command);
    if (existing) await terminalApi.deleteFavorite(existing.id);
    else await terminalApi.saveFavorite(command);
    await favoritesStore.refresh();
    return !existing;
  },
};

/** A pane's blocks, kept in the browser so a reload does not empty the pane. */
const PANE_KEY = "mikrotik-mcp.terminal.pane.";
const PANE_BLOCKS = 40;
const PANE_OUTPUT_CHARS = 20_000;
export const paneStorage = {
  load<T>(paneId: string): T[] {
    try {
      const raw = localStorage.getItem(PANE_KEY + paneId);
      return raw ? (JSON.parse(raw) as T[]) : [];
    } catch {
      return [];
    }
  },
  /** Keeps the newest blocks and the end of each long output. */
  save(paneId: string, blocks: { output: string }[]): void {
    try {
      const kept = blocks
        .slice(-PANE_BLOCKS)
        .map((block) => ({ ...block, output: block.output.slice(-PANE_OUTPUT_CHARS) }));
      localStorage.setItem(PANE_KEY + paneId, JSON.stringify(kept));
    } catch {
      /* storage full or unavailable: the pane just starts empty next time */
    }
  },
  remove(paneId: string): void {
    try {
      localStorage.removeItem(PANE_KEY + paneId);
    } catch {
      /* nothing to remove */
    }
  },
};

// ── export ──────────────────────────────────────────────────────────────

export interface ExportBlock {
  ts: number;
  command: string;
  output: string;
  status: string;
  ms?: number;
  error?: string;
}
export type ExportFormat = "txt" | "md" | "rsc";

/**
 * A pane's blocks as one document: `txt` is a transcript, `md` is a report with
 * fenced blocks, `rsc` holds only the commands that succeeded (a script).
 */
export function exportSession(device: string, blocks: ExportBlock[], format: ExportFormat): string {
  const when = (ts: number): string => new Date(ts).toISOString().replace("T", " ").slice(0, 19);
  if (format === "rsc") {
    const commands = blocks.filter((b) => b.status === "ok").map((b) => b.command);
    return [`# ${device} - commands exported ${when(Date.now())} UTC`, ...commands, ""].join("\n");
  }
  if (format === "md") {
    const parts = blocks.map((b) => {
      const result = b.status === "ok" ? `${b.ms ?? 0} ms` : b.status;
      const body = b.error ? `${b.output}\n${b.error}`.trim() : b.output;
      return [
        `### \`${b.command.replace(/`/g, "'")}\``,
        `${when(b.ts)} UTC - ${result}`,
        "",
        "```text",
        body || "(no output)",
        "```",
      ].join("\n");
    });
    return [`# Terminal session - ${device}`, "", ...parts, ""]
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return blocks
    .map((b) =>
      [`[${when(b.ts)}] ${device} > ${b.command}`, b.output, b.error ? `! ${b.error}` : ""]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n")
    .concat("\n");
}

/** Save text as a file through the browser. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── snippets: commands with {{placeholders}} ────────────────────────────

const FIELD_RE = /\{\{\s*([\w-]+)\s*(?:=([^}]*))?\}\}/g;
export interface SnippetField {
  name: string;
  /** From `{{name=value}}`; empty when the snippet gives none. */
  fallback: string;
}

/** The placeholders of a command, each name once, in order of appearance. */
export function snippetFields(command: string): SnippetField[] {
  const fields = new Map<string, SnippetField>();
  for (const match of command.matchAll(FIELD_RE)) {
    const name = match[1] ?? "";
    const fallback = (match[2] ?? "").trim();
    const known = fields.get(name);
    if (!known) fields.set(name, { name, fallback });
    else if (!known.fallback && fallback) known.fallback = fallback;
  }
  return Array.from(fields.values());
}

/** Replace every placeholder with its value, or with the snippet's default for it. */
export function fillSnippet(command: string, values: Record<string, string>): string {
  const defaults = new Map(snippetFields(command).map((field) => [field.name, field.fallback]));
  return command.replace(
    FIELD_RE,
    (_all, name: string) => values[name] || defaults.get(name) || "",
  );
}

// ── compare: pick two outputs (any panes), then see their differences ───

export interface CompareSide {
  /** `paneId:blockId`, so a block knows that it is the one picked. */
  key: string;
  label: string;
  text: string;
}
let compareState: { first?: CompareSide; second?: CompareSide } = {};
const compareListeners = new Set<() => void>();
const compareChanged = (): void => {
  for (const listener of compareListeners) listener();
};
/** Show a ready-made diff text (a snapshot diff) in the compare dialog. */
let changesText: { title: string; text: string } | null = null;
export const changesStore = {
  get: (): { title: string; text: string } | null => changesText,
  subscribe(listener: () => void): () => void {
    compareListeners.add(listener);
    return () => compareListeners.delete(listener);
  },
  show(title: string, text: string): void {
    changesText = { title, text };
    compareChanged();
  },
  close(): void {
    changesText = null;
    compareChanged();
  },
};

export const compareStore = {
  get: (): { first?: CompareSide; second?: CompareSide } => compareState,
  subscribe(listener: () => void): () => void {
    compareListeners.add(listener);
    return () => compareListeners.delete(listener);
  },
  /** First pick marks a side; picking it again unmarks; a second pick opens the diff. */
  pick(side: CompareSide): void {
    const first = compareState.first;
    if (!first) compareState = { first: side };
    else if (first.key === side.key) compareState = {};
    else compareState = { first, second: side };
    compareChanged();
  },
  clear(): void {
    compareState = {};
    compareChanged();
  },
};

const GROUPS_KEY = "mikrotik-mcp.terminal.groups.v1";
export const groupStorage = {
  load(): BroadcastGroup[] {
    try {
      const raw = localStorage.getItem(GROUPS_KEY);
      return raw ? (JSON.parse(raw) as BroadcastGroup[]) : [];
    } catch {
      return [];
    }
  },
  save(groups: BroadcastGroup[]): void {
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
    } catch {
      /* storage unavailable: groups last for this visit only */
    }
  },
};

// ── named workspaces: saved pane layouts ────────────────────────────────

export interface SavedWorkspace {
  name: string;
  /** A dockview layout (`api.toJSON()`), panes and their routers included. */
  layout: unknown;
}
const WORKSPACES_KEY = "mikrotik-mcp.terminal.workspaces.v1";
export const workspaceStorage = {
  load(): SavedWorkspace[] {
    try {
      const raw = localStorage.getItem(WORKSPACES_KEY);
      return raw ? (JSON.parse(raw) as SavedWorkspace[]) : [];
    } catch {
      return [];
    }
  },
  save(list: SavedWorkspace[]): void {
    try {
      localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: workspaces last for this visit only */
    }
  },
};

// ── alerts on a watched command ─────────────────────────────────────────

/**
 * Check a watched output against a rule. Returns the alert text, or `null`.
 *
 * Rules:
 *  - `changed`             the output differs from the previous run
 *  - `cpu-load > 80`       the number after `cpu-load` (any of > >= < <= = !=)
 *  - `/regex/`             the output matches the regular expression
 *  - anything else         the output contains that text (case ignored)
 */
export function evalAlert(rule: string, output: string, previous: string): string | null {
  const text = rule.trim();
  if (!text) return null;
  if (text.toLowerCase() === "changed")
    return previous && previous !== output ? "The output changed." : null;
  const numeric = text.match(/^([\w.-]+)\s*(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
  if (numeric) {
    const [, key = "", op = "", limit = ""] = numeric;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = output.match(
      new RegExp(`(?:^|[\\s;])${escaped}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "m"),
    );
    if (!found?.[1]) return null;
    const value = Number(found[1]);
    const bound = Number(limit);
    const hit =
      op === ">"
        ? value > bound
        : op === ">="
          ? value >= bound
          : op === "<"
            ? value < bound
            : op === "<="
              ? value <= bound
              : op === "="
                ? value === bound
                : value !== bound;
    return hit ? `${key} is ${found[1]} (${op} ${limit})` : null;
  }
  const regex = text.match(/^\/(.+)\/([a-z]*)$/);
  if (regex) {
    try {
      const found = output.match(new RegExp(regex[1] ?? "", regex[2] || "m"));
      return found ? `Matched ${text}: ${found[0].slice(0, 80)}` : null;
    } catch {
      return null;
    }
  }
  return output.toLowerCase().includes(text.toLowerCase())
    ? `The output contains "${text}".`
    : null;
}

/** Show a browser notification when the user allowed it (asks once). */
export function notify(title: string, body: string): void {
  if (typeof Notification === "undefined") return;
  const show = (): void => {
    try {
      const _shown = new Notification(title, { body, tag: title });
      void _shown;
    } catch {
      /* notifications are blocked in this context */
    }
  };
  if (Notification.permission === "granted") show();
  else if (Notification.permission === "default")
    void Notification.requestPermission().then((answer) => answer === "granted" && show());
}

// ── scripts: several commands, one per line ─────────────────────────────

/**
 * The commands of a script: blank lines and `#` comments dropped, and a line
 * that ends with `\\` joined to the next one (as RouterOS exports do).
 */
export function scriptLines(text: string): string[] {
  const commands: string[] = [];
  let pending = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!pending && (!line || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trimEnd()} `;
      continue;
    }
    commands.push((pending + line).trim());
    pending = "";
  }
  if (pending.trim()) commands.push(pending.trim());
  return commands.filter(Boolean);
}

/** Which pane the script dialog works on; empty when it is closed. */
let scriptPane = "";
const scriptListeners = new Set<() => void>();
export const scriptStore = {
  get: (): string => scriptPane,
  subscribe(listener: () => void): () => void {
    scriptListeners.add(listener);
    return () => scriptListeners.delete(listener);
  },
  open(paneId: string): void {
    scriptPane = paneId;
    for (const listener of scriptListeners) listener();
  },
  close(): void {
    scriptStore.open("");
  },
};

// ── pipes: filters applied to the output in the browser ─────────────────

const PIPE_VERBS = new Set(["grep", "count", "sort", "head", "tail", "uniq"]);

/**
 * Split `command | grep x | count` into the RouterOS command and its filters.
 * A `|` inside quotes, brackets or braces belongs to the command, and so does
 * one that no known filter follows (RouterOS uses `|` in expressions).
 */
export function splitPipes(input: string): { command: string; filters: string[] } {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\\") i++;
    else if (char === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (char === "[" || char === "{" || char === "(") depth++;
    else if (char === "]" || char === "}" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === "|" && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  // Filters are the trailing parts that all start with a known verb.
  let first = parts.length;
  while (first > 1 && PIPE_VERBS.has(parts[first - 1]?.trim().split(/\s+/)[0] ?? "")) first--;
  return {
    command: parts.slice(0, first).join("|").trim(),
    filters: parts.slice(first).map((part) => part.trim()),
  };
}

/** Apply the filters of {@link splitPipes} to an output, in order. */
export function applyPipes(output: string, filters: string[]): string {
  let lines = output.split("\n");
  for (const filter of filters) {
    const [verb = "", ...args] = filter.split(/\s+/);
    if (verb === "grep") {
      const invert = args.includes("-v");
      const pattern = args.filter((arg) => arg !== "-v" && arg !== "-i").join(" ");
      let test: (line: string) => boolean;
      try {
        const regex = new RegExp(pattern, "i");
        test = (line) => regex.test(line);
      } catch {
        test = (line) => line.toLowerCase().includes(pattern.toLowerCase());
      }
      lines = lines.filter((line) => test(line) !== invert);
    } else if (verb === "count") lines = [String(lines.filter((line) => line.trim()).length)];
    else if (verb === "sort") {
      lines = lines.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (args.includes("-r")) lines.reverse();
    } else if (verb === "uniq") lines = lines.filter((line, i) => line !== lines[i - 1]);
    else if (verb === "head") lines = lines.slice(0, Number(args[0]) || 10);
    else if (verb === "tail") lines = lines.slice(-(Number(args[0]) || 10));
  }
  return lines.join("\n");
}

/** The number after `key` in an output (`cpu-load: 37%`, `rx-byte=1024`), if any. */
export function readNumber(output: string, key: string): number | undefined {
  const name = key.trim();
  if (!name) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = output.match(
    new RegExp(`(?:^|[\\s;])${escaped}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "m"),
  );
  return found?.[1] === undefined ? undefined : Number(found[1]);
}

// ── tokens in an output that can start the next command ─────────────────

export type OutputToken = { kind: "ip" | "mac"; value: string };
const TOKEN_RE =
  /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b|\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?\b/g;

/** An output cut into plain text and IP / MAC tokens, in order. */
export function tokenize(output: string): (string | OutputToken)[] {
  const parts: (string | OutputToken)[] = [];
  let last = 0;
  for (const match of output.matchAll(TOKEN_RE)) {
    if (match.index > last) parts.push(output.slice(last, match.index));
    parts.push({ kind: match[0].includes(":") ? "mac" : "ip", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < output.length) parts.push(output.slice(last));
  return parts;
}

/** Commands a token suggests. They are put in the input to review, never run. */
export function tokenCommands(token: OutputToken): { label: string; command: string }[] {
  const { kind, value } = token;
  if (kind === "mac")
    return [
      { label: "Find in ARP", command: `/ip arp print where mac-address=${value}` },
      {
        label: "Find the bridge port",
        command: `/interface bridge host print where mac-address=${value}`,
      },
      {
        label: "Find the DHCP lease",
        command: `/ip dhcp-server lease print where mac-address=${value}`,
      },
    ];
  const host = value.split("/")[0] ?? value;
  return [
    { label: "Ping", command: `/ping ${host} count=4` },
    { label: "Traceroute", command: `/tool traceroute ${host} count=1` },
    { label: "Find in ARP", command: `/ip arp print where address=${host}` },
    {
      label: "Find connections",
      command: `/ip firewall connection print where src-address~"${host}"`,
    },
    {
      label: "Add to an address list…",
      command: `/ip firewall address-list add list={{list}} address=${value}`,
    },
  ];
}

// ── undo for simple changes ─────────────────────────────────────────────

export type UndoPlan =
  /** The opposite command is known before the command runs. */
  | { kind: "known"; undo: string }
  /** `add`: run `wrapped` so the router prints the new item's id; undo removes that id. */
  | { kind: "add"; wrapped: string; path: string };

/**
 * How to undo a command, when that is certain: `enable` / `disable`,
 * `disabled=yes|no`, and a plain `add`. Anything else returns `null` (use a
 * snapshot or Safe Mode): a `set` needs the old values, a `remove` the old item.
 */
export function planUndo(command: string): UndoPlan | null {
  const text = command.trim();
  // One plain command only: no script, no sub-expression that could change things.
  if (!text.startsWith("/") || /[;{}]/.test(text)) return null;
  const verb = text.match(/^(\/[\w\s/-]+?)\s+(enable|disable|add|set)(\s|$)/);
  if (!verb) return null;
  const [, path = "", action = ""] = verb;
  if (action === "enable" || action === "disable")
    return {
      kind: "known",
      undo: text.replace(
        /\s(enable|disable)(\s|$)/,
        (_all, was: string, end: string) => ` ${was === "enable" ? "disable" : "enable"}${end}`,
      ),
    };
  if (action === "set") {
    const flag = text.match(/\sdisabled=(yes|no|true|false)(\s|$)/);
    // Only when `disabled` is the one property that is set.
    if (!flag || (text.match(/\s[\w-]+=/g) ?? []).filter((p) => !/numbers=/.test(p)).length !== 1)
      return null;
    const was = flag[1] === "yes" || flag[1] === "true";
    return {
      kind: "known",
      undo: text.replace(/\sdisabled=\w+/, ` disabled=${was ? "no" : "yes"}`),
    };
  }
  if (text.includes("[")) return null;
  return { kind: "add", wrapped: `:put [${text}]`, path: path.trim() };
}

/** The undo of an `add`, from what the router printed for the wrapped command. */
export function undoOfAdd(path: string, output: string): string | undefined {
  const id = output.match(/\*[0-9A-Fa-f]+/)?.[0];
  return id ? `${path} remove ${id}` : undefined;
}
