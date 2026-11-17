/**
 * Dashboard Files — browser-side plumbing shared by the page and its panes: API
 * calls, the transfer queue (upload, download, router-to-router copy), the pane
 * registry and small path helpers.
 */
import { api, postJson, withToken } from "./api";

export interface FilesState {
  enabled: boolean;
  reason: string | null;
  readOnly: boolean;
}
export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}
export interface SearchHit {
  device: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  line?: number;
  text?: string;
}
export interface SearchDone {
  device: string;
  scanned: number;
  truncated: boolean;
  error?: string;
}

const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const auth: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const query = (device: string, path: string): string =>
  `device=${encodeURIComponent(device)}&path=${encodeURIComponent(path)}`;

export const joinPath = (dir: string, name: string): string => `${dir === "/" ? "" : dir}/${name}`;
export const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(
    body?.error || `The dashboard could not complete this request (HTTP ${res.status}).`,
  );
}

/** Read an NDJSON response, one parsed line at a time. */
async function readLines(
  res: Response,
  onItem: (item: Record<string, unknown>) => void,
): Promise<void> {
  if (!res.ok || !res.body) throw await failure(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    rest += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onItem(JSON.parse(line) as Record<string, unknown>);
    if (chunk.done) return;
  }
}

const postFiles = async (path: string, body: unknown): Promise<void> => {
  const answer = await postJson<{
    ok?: boolean;
    error?: string;
    failed?: { path: string; error: string }[];
  }>(path, body);
  if (answer.error) throw new Error(answer.error);
  if (answer.failed?.length)
    throw new Error(
      answer.failed.map((item) => `${baseName(item.path)}: ${item.error}`).join("\n"),
    );
};

// ── listings changed ──────────────────────────────────────────────────────
type Changed = (device: string, dir: string) => void;
const changeListeners = new Set<Changed>();
/** Panes listen here, and reload when a transfer or an edit changed their folder. */
export const filesBus = {
  subscribe(listener: Changed): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  },
  changed(device: string, dir: string): void {
    for (const listener of changeListeners) listener(device, dir);
  },
};

/** A small store for one value, for `useSyncExternalStore`. */
function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: T): void {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface FileRef {
  device: string;
  path: string;
}
/** The file open in the viewer, or null. */
export const viewerStore = store<FileRef | null>(null);

/** Files the viewer can show: text kinds, up to the server's 1 MiB limit. */
export const canPreview = (entry: FileEntry): boolean =>
  !entry.dir &&
  entry.size <= 1024 * 1024 &&
  ["script", "text", "web", "key"].includes(kindOf(entry));

export const filesApi = {
  state: (): Promise<FilesState> => api<FilesState>("/api/files/state"),
  list: (device: string, path: string, signal?: AbortSignal): Promise<FileEntry[]> =>
    api<{ entries: FileEntry[] }>(`/api/files/list?${query(device, path)}`, signal).then(
      (answer) => answer.entries,
    ),
  usage: (device: string): Promise<{ free?: number; total?: number }> =>
    api(`/api/files/usage?device=${encodeURIComponent(device)}`),
  read: (file: FileRef): Promise<{ text: string; size: number; mtime: number }> =>
    api(`/api/files/read?${query(file.device, file.path)}`),
  /** Replace a file with `text`. */
  async write(file: FileRef, text: string): Promise<void> {
    const res = await fetch(withToken(`/api/files/upload?${query(file.device, file.path)}`), {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...auth },
      body: text,
    });
    if (!res.ok) throw await failure(res);
    filesBus.changed(file.device, parentOf(file.path));
  },
  remove: (device: string, paths: string[]): Promise<void> =>
    postFiles("/api/files/delete", { device, paths }),
  rename: (device: string, from: string, to: string): Promise<void> =>
    postFiles("/api/files/rename", { device, from, to }),
  mkdir: (device: string, path: string): Promise<void> =>
    postFiles("/api/files/mkdir", { device, path }),
  /** Streams hits; resolves when every router has answered. */
  async search(
    body: {
      q: string;
      contents: boolean;
      regex: boolean;
      targets: { device: string; path: string }[];
    },
    onHit: (hit: SearchHit) => void,
    onDone: (done: SearchDone) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(withToken("/api/files/search"), {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify(body),
    });
    await readLines(res, (item) => {
      if (item.t === "hit") onHit(item as unknown as SearchHit);
      else if (item.t === "done") onDone(item as unknown as SearchDone);
      else if (item.t === "error") throw new Error(String(item.error));
    });
  },
};

// ── open panes ────────────────────────────────────────────────────────────
export interface PaneHandle {
  device: string;
  path: string;
  /** Open `dir` and select `name` in it. */
  reveal: (dir: string, name?: string) => void;
}
const panes = new Map<string, PaneHandle>();
const paneListeners = new Set<() => void>();
let paneList: (PaneHandle & { id: string })[] = [];
const publishPanes = (): void => {
  paneList = Array.from(panes, ([id, handle]) => ({ id, ...handle }));
  for (const listener of paneListeners) listener();
};
export const filePanes = {
  set(id: string, handle: PaneHandle): void {
    panes.set(id, handle);
    publishPanes();
  },
  remove(id: string): void {
    panes.delete(id);
    publishPanes();
  },
  all: (): (PaneHandle & { id: string })[] => paneList,
  subscribe(listener: () => void): () => void {
    paneListeners.add(listener);
    return () => paneListeners.delete(listener);
  },
};

/** What is being dragged between panes (the browser hides drag data until the drop). */
export const dragState: { current: { device: string; dir: string; entries: FileEntry[] } | null } =
  {
    current: null,
  };
export const DRAG_TYPE = "application/x-mikrotik-files";

// ── transfers ─────────────────────────────────────────────────────────────
export type TransferKind = "upload" | "download" | "copy";
export interface Transfer {
  id: string;
  kind: TransferKind;
  name: string;
  from: string;
  to: string;
  total: number;
  done: number;
  status: "queued" | "active" | "done" | "error" | "stopped";
  error?: string;
  started?: number;
  finished?: number;
}
type Report = (done: number, total?: number) => void;
type Job = (report: Report, signal: AbortSignal) => Promise<void>;

/** Transfers that run at the same time; the rest wait in the queue. */
const PARALLEL = 3;
let transfers: Transfer[] = [];
const jobs = new Map<string, { job: Job; abort?: AbortController }>();
const transferListeners = new Set<() => void>();

function patch(id: string, change: Partial<Transfer>): void {
  transfers = transfers.map((item) => (item.id === id ? { ...item, ...change } : item));
  for (const listener of transferListeners) listener();
}

function pump(): void {
  let active = transfers.filter((item) => item.status === "active").length;
  for (const item of transfers) {
    if (active >= PARALLEL) return;
    if (item.status !== "queued") continue;
    const entry = jobs.get(item.id);
    if (!entry) continue;
    active += 1;
    const abort = new AbortController();
    entry.abort = abort;
    patch(item.id, { status: "active", started: Date.now(), done: 0, error: undefined });
    let shown = 0;
    const report: Report = (done, total) => {
      // Many small progress events; the list redraws about ten times a second.
      if (Date.now() - shown < 100 && total === undefined) return;
      shown = Date.now();
      patch(item.id, total === undefined ? { done } : { done, total });
    };
    entry
      .job(report, abort.signal)
      .then(() => {
        const now = transfers.find((t) => t.id === item.id);
        patch(item.id, { status: "done", done: now?.total ?? 0, finished: Date.now() });
      })
      .catch((error: unknown) =>
        patch(item.id, {
          status: abort.signal.aborted ? "stopped" : "error",
          error: abort.signal.aborted
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
          finished: Date.now(),
        }),
      )
      .finally(pump);
  }
}

function enqueue(item: Omit<Transfer, "id" | "done" | "status">, job: Job): void {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, { job });
  transfers = [...transfers, { ...item, id, done: 0, status: "queued" }];
  for (const listener of transferListeners) listener();
  pump();
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const transferQueue = {
  get: (): Transfer[] => transfers,
  subscribe(listener: () => void): () => void {
    transferListeners.add(listener);
    return () => transferListeners.delete(listener);
  },
  stop(id: string): void {
    const item = transfers.find((t) => t.id === id);
    if (item?.status === "queued") patch(id, { status: "stopped", finished: Date.now() });
    else jobs.get(id)?.abort?.abort();
  },
  retry(id: string): void {
    patch(id, { status: "queued", done: 0, error: undefined, finished: undefined });
    pump();
  },
  clearFinished(): void {
    const keep = transfers.filter((item) => item.status === "queued" || item.status === "active");
    for (const item of transfers) if (!keep.includes(item)) jobs.delete(item.id);
    transfers = keep;
    for (const listener of transferListeners) listener();
  },

  /** Browser → router. `fetch` reports no upload progress, so this uses XHR. */
  upload(device: string, dir: string, file: File): void {
    const path = joinPath(dir, file.name);
    enqueue(
      {
        kind: "upload",
        name: file.name,
        from: "this computer",
        to: `${device}:${dir}`,
        total: file.size,
      },
      (report, signal) =>
        new Promise<void>((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open("POST", withToken(`/api/files/upload?${query(device, path)}`));
          if (TOKEN) request.setRequestHeader("authorization", `Bearer ${TOKEN}`);
          request.setRequestHeader("content-type", "application/octet-stream");
          request.upload.onprogress = (event) => report(event.loaded);
          request.onerror = () => reject(new Error("The upload was interrupted."));
          request.onabort = () => reject(new Error("Stopped."));
          request.onload = () => {
            filesBus.changed(device, dir);
            if (request.status >= 200 && request.status < 300) return resolve();
            let reason = `The upload failed (HTTP ${request.status}).`;
            try {
              reason = (JSON.parse(request.responseText) as { error?: string }).error || reason;
            } catch {
              /* not JSON: keep the short reason */
            }
            reject(new Error(reason));
          };
          signal.addEventListener("abort", () => request.abort(), { once: true });
          request.send(file);
        }),
    );
  },

  /** Router → browser, then saved as a file. */
  download(device: string, path: string, size: number): void {
    enqueue(
      {
        kind: "download",
        name: baseName(path),
        from: `${device}:${parentOf(path)}`,
        to: "this computer",
        total: size,
      },
      async (report, signal) => {
        const res = await fetch(withToken(`/api/files/download?${query(device, path)}`), {
          signal,
          headers: auth,
        });
        if (!res.ok || !res.body) throw await failure(res);
        const total = Number(res.headers.get("content-length")) || size;
        report(0, total);
        const reader = res.body.getReader();
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let done = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          parts.push(chunk.value as Uint8Array<ArrayBuffer>);
          done += chunk.value.byteLength;
          report(done);
        }
        if (done < total) throw new Error("The router closed the file before the end.");
        saveBlob(new Blob(parts), baseName(path));
      },
    );
  },

  /** Router → router (or folder → folder), relayed by the server. */
  copy(
    from: { device: string; path: string; size: number },
    to: { device: string; dir: string },
  ): void {
    const name = baseName(from.path);
    enqueue(
      {
        kind: "copy",
        name,
        from: `${from.device}:${parentOf(from.path)}`,
        to: `${to.device}:${to.dir}`,
        total: from.size,
      },
      async (report, signal) => {
        const res = await fetch(withToken("/api/files/transfer"), {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({
            from: { device: from.device, path: from.path },
            to: { device: to.device, path: joinPath(to.dir, name) },
          }),
        });
        let ended = false;
        try {
          await readLines(res, (item) => {
            if (item.t === "start") report(0, Number(item.total));
            else if (item.t === "progress") report(Number(item.done));
            else if (item.t === "end") {
              ended = true;
              if (item.ok !== true) throw new Error(String(item.error ?? "The copy failed."));
            } else if (item.t === "error") throw new Error(String(item.error));
          });
          if (!ended) throw new Error("The copy stopped before the end.");
        } finally {
          filesBus.changed(to.device, to.dir);
        }
      },
    );
  },
};

// ── presentation helpers ──────────────────────────────────────────────────
export type FileKind =
  | "folder"
  | "backup"
  | "script"
  | "package"
  | "text"
  | "key"
  | "support"
  | "web"
  | "image"
  | "file";

const KINDS: [RegExp, FileKind][] = [
  [/\.(?:backup|umb)$/i, "backup"],
  [/\.(?:rsc|auto\.rsc)$/i, "script"],
  [/\.npk$/i, "package"],
  [/\.(?:txt|log|conf|cfg|json|csv|md|ini|ya?ml)$/i, "text"],
  [/\.(?:crt|pem|key|pub|p12|pfx|ovpn)$/i, "key"],
  [/\.rif$/i, "support"],
  [/\.(?:html?|css|js)$/i, "web"],
  [/\.(?:png|jpe?g|gif|svg|ico|bmp)$/i, "image"],
];
export function kindOf(entry: { name: string; dir: boolean }): FileKind {
  if (entry.dir) return "folder";
  return KINDS.find(([pattern]) => pattern.test(entry.name))?.[1] ?? "file";
}

/** `12 Nov 2026, 14:05`, or a dash when the router gave no time. */
export function when(mtime: number): string {
  // RouterOS gives built-in folders a time near zero.
  if (mtime < 86_400) return "—";
  return new Date(mtime * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Bytes per second and the time left, for an active transfer. */
export function pace(item: Transfer, now = Date.now()): { speed: number; left: number } {
  const seconds = Math.max((now - (item.started ?? now)) / 1000, 0.001);
  const speed = item.done / seconds;
  return { speed, left: speed > 0 ? (item.total - item.done) / speed : Infinity };
}

/** Names in `names` that the folder already has. */
export const conflicts = (existing: FileEntry[], names: string[]): string[] => {
  const have = new Set(existing.map((entry) => entry.name));
  return names.filter((name) => have.has(name));
};

const LAYOUT_KEY = "mikrotik-mcp.files.layout";
export const filesLayout = {
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
};
