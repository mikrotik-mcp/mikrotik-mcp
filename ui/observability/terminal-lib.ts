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
export interface Probe {
  ok: boolean;
  ms: number;
  identity?: string;
  transport?: string;
  error?: string;
}
export interface RunEnd {
  ok: boolean;
  ms: number;
  error?: string;
  stopped?: boolean;
  transport?: string;
  /** Safe to send again without repeating a change on the router. */
  retryable?: boolean;
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
  options: { maxMs?: number; signal?: AbortSignal; onOutput: (text: string) => void },
): Promise<RunEnd> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let res: Response;
  try {
    res = await post(
      "/api/terminal/run",
      { device, command, maxMs: options.maxMs },
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
  run: (command: string, options?: { fromBroadcast?: boolean }) => void;
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

/** Page-wide switches the panes read. */
export const workspace = {
  broadcast: false,
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
