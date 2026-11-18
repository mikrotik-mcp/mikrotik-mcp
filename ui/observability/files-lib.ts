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
  /** Deleted and replaced files are kept in the recycle bin. */
  trash?: boolean;
  /** S3 is configured, so a file can also be saved there. */
  s3?: boolean;
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

export interface FileJob {
  id: string;
  devices: string[];
  dir: string;
  pattern: string;
  everyMs: number;
  keep: number;
  next: number;
  last?: { at: number; ok: boolean; note: string };
}

export interface VaultFile {
  name: string;
  bytes: number;
  modified: number;
}

export interface TrashItem {
  id: string;
  device: string;
  path: string;
  size: number;
  ts: number;
  reason: "deleted" | "replaced";
}

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

/** A store that is also kept in the browser, so it is there after a reload. */
function persisted<T>(key: string, initial: T) {
  let start = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw) start = JSON.parse(raw) as T;
  } catch {
    /* storage unavailable: start empty */
  }
  const inner = store(start);
  return {
    ...inner,
    set(next: T): void {
      inner.set(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* it just does not persist */
      }
    },
  };
}

export interface FileRef {
  device: string;
  path: string;
}
/** The file open in the viewer, or null. */
export const viewerStore = store<FileRef | null>(null);

/** Files picked for a comparison: none, the first, or both. */
export const compareStore = store<FileRef[]>([]);
/** Add a file to the comparison; the second pick opens the differences. */
export const pickForCompare = (file: FileRef): void => {
  const [first] = compareStore.get();
  compareStore.set(first && compareStore.get().length === 1 ? [first, file] : [file]);
};

/** When on, a copy asks the destination router to fetch the file from the source by itself. */
export const directStore = store(false);

/** When on, a copy is read back from the destination and its SHA-256 compared with the source. */
export const verifyStore = store(false);

/** Folders the user marked, to open again with one click. */
export const bookmarkStore = persisted<FileRef[]>("mikrotik-mcp.files.bookmarks", []);
export const isBookmarked = (list: FileRef[], device: string, path: string): boolean =>
  list.some((item) => item.device === device && item.path === path);
export function toggleBookmark(device: string, path: string): void {
  const list = bookmarkStore.get();
  bookmarkStore.set(
    isBookmarked(list, device, path)
      ? list.filter((item) => !(item.device === device && item.path === path))
      : [...list, { device, path }],
  );
}

/** Pane layouts saved under a name. */
export const workspaceStore = persisted<{ name: string; layout: unknown }[]>(
  "mikrotik-mcp.files.workspaces",
  [],
);

/** The file being followed (tail), or null. */
export const tailStore = store<FileRef | null>(null);

/** The router whose storage is being analysed, or null. */
export const analysisStore = store<string | null>(null);

/** Whether the scheduled jobs dialog is open. */
export const jobsStore = store(false);

/** Whether the vault dialog is open. */
export const vaultStore = store(false);

/** Whether the recycle bin dialog is open. */
export const trashStore = store(false);

/** The `.rsc` file open in the import dialog, or null. */
export const importStore = store<FileRef | null>(null);

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
  usage: (device: string): Promise<RouterSystem> =>
    api(`/api/files/usage?device=${encodeURIComponent(device)}`),
  /** Every file under a folder, for a folder copy. */
  tree: (
    device: string,
    path: string,
  ): Promise<{ files: TreeFile[]; dirs: string[]; truncated: boolean }> =>
    api(`/api/files/tree?${query(device, path)}`),
  /** The SHA-256 of a file, computed by the server from the router's bytes. */
  hash: (file: FileRef): Promise<string> =>
    api<{ sha256: string }>(`/api/files/hash?${query(file.device, file.path)}`).then(
      (answer) => answer.sha256,
    ),
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
  /** Have the router write a backup or an export into its files. */
  async make(device: string, kind: "backup" | "export"): Promise<string> {
    const answer = await postJson<{ file?: string; error?: string }>("/api/files/make", {
      device,
      kind,
    });
    if (!answer.file) throw new Error(answer.error ?? "The router did not make the file.");
    filesBus.changed(device, "/");
    return answer.file;
  },
  /** Run a `.rsc` file. A dry run reports the errors and changes nothing. */
  async importScript(file: FileRef, dryRun: boolean): Promise<{ ok: boolean; output: string }> {
    const answer = await postJson<{ ok?: boolean; output?: string; error?: string }>(
      "/api/files/import",
      { device: file.device, path: file.path, dryRun },
    );
    if (answer.error) throw new Error(answer.error);
    return { ok: answer.ok === true, output: answer.output ?? "" };
  },
  vault: (): Promise<{ dir: string; files: VaultFile[] }> => api("/api/files/vault"),
  /** Copy router files into the backup vault of the server (and to S3). */
  async saveToVault(device: string, paths: string[], s3: boolean): Promise<string[]> {
    const answer = await postJson<{
      saved?: { name: string }[];
      failed?: { path: string; error: string }[];
      error?: string;
    }>("/api/files/vault/save", { device, paths, s3 });
    if (answer.error) throw new Error(answer.error);
    if (answer.failed?.length)
      throw new Error(
        answer.failed.map((item) => `${baseName(item.path)}: ${item.error}`).join("\n"),
      );
    return (answer.saved ?? []).map((item) => item.name);
  },
  async sendFromVault(name: string, device: string, dir: string): Promise<void> {
    const answer = await postJson<{ ok?: boolean; error?: string }>("/api/files/vault/send", {
      name,
      device,
      dir,
    });
    if (!answer.ok) throw new Error(answer.error ?? "The file was not sent.");
    filesBus.changed(device, dir);
  },
  jobs: (): Promise<FileJob[]> => api<{ jobs: FileJob[] }>("/api/files/jobs").then((a) => a.jobs),
  async addJob(job: {
    devices: string[];
    dir: string;
    pattern: string;
    everyMs: number;
    keep: number;
  }): Promise<void> {
    const answer = await postJson<{ job?: FileJob; error?: string }>("/api/files/jobs", job);
    if (!answer.job) throw new Error(answer.error ?? "The job was not saved.");
  },
  removeJob: (id: string): Promise<unknown> => postJson("/api/files/jobs/remove", { id }),
  async runJob(id: string): Promise<void> {
    const answer = await postJson<{ job?: FileJob; error?: string }>("/api/files/jobs/run", { id });
    if (!answer.job) throw new Error(answer.error ?? "The job did not run.");
  },
  trash: (): Promise<TrashItem[]> =>
    api<{ items: TrashItem[] }>("/api/files/trash").then((answer) => answer.items),
  async restore(id: string): Promise<void> {
    const answer = await postJson<{ device?: string; path?: string; error?: string }>(
      "/api/files/trash/restore",
      { id },
    );
    if (!answer.device || !answer.path)
      throw new Error(answer.error ?? "The file was not restored.");
    filesBus.changed(answer.device, parentOf(answer.path));
  },
  purge: (id?: string): Promise<unknown> => postJson("/api/files/trash/purge", { id }),
  remove: (device: string, paths: string[]): Promise<void> =>
    postFiles("/api/files/delete", { device, paths }),
  rename: (device: string, from: string, to: string): Promise<void> =>
    postFiles("/api/files/rename", { device, from, to }),
  mkdir: (device: string, path: string): Promise<void> =>
    postFiles("/api/files/mkdir", { device, path }),
  /** Follow a growing file: `onText` gets its end, then what is added, until the signal aborts. */
  async tail(file: FileRef, onText: (text: string) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(withToken(`/api/files/tail?${query(file.device, file.path)}`), {
      signal,
      headers: auth,
    });
    if (!res.ok || !res.body) throw await failure(res);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      onText(decoder.decode(chunk.value, { stream: true }));
    }
  },
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

/** When on, an upload to one pane goes to the same folder on every open router. */
export const broadcastStore = store(false);
/** The routers an upload goes to: this one, or every open router when broadcasting. */
export const uploadTargets = (device: string): string[] =>
  broadcastStore.get()
    ? Array.from(new Set([device, ...paneList.map((pane) => pane.device)]))
    : [device];

/**
 * The files of a drop from the computer. A dropped folder gives its files with
 * `sub`, their folder below the drop target.
 */
export async function droppedFiles(transfer: DataTransfer): Promise<{ file: File; sub: string }[]> {
  // The browser forgets the drop when the event ends: read the entries first.
  const entries = Array.from(transfer.items ?? []).map((item) => item.webkitGetAsEntry?.() ?? null);
  const plain = Array.from(transfer.files);
  if (!entries.some((entry) => entry?.isDirectory)) return plain.map((file) => ({ file, sub: "" }));
  const found: { file: File; sub: string }[] = [];
  const walk = async (entry: FileSystemEntry, sub: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      found.push({ file, sub });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) return;
      for (const child of batch) await walk(child, sub ? `${sub}/${entry.name}` : entry.name);
    }
  };
  for (const entry of entries) if (entry) await walk(entry, "");
  return found;
}

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
  /** How a copy travels: relayed by the server, or fetched by the router itself. */
  via?: string;
  /** Something the user should know, such as a fallback. */
  note?: string;
}
/** `extra` sets other fields of the row, such as how a copy travels. */
type Report = (done: number, total?: number, extra?: Partial<Transfer>) => void;
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
    const report: Report = (done, total, extra) => {
      // Many small progress events; the list redraws about ten times a second.
      if (Date.now() - shown < 100 && total === undefined && !extra) return;
      shown = Date.now();
      patch(item.id, { done, ...(total === undefined ? {} : { total }), ...extra });
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

/** The bytes a download has so far; a retry continues after them. */
interface Received {
  parts: Uint8Array<ArrayBuffer>[];
  done: number;
}

/**
 * Stream a response into memory with progress, then save it. `size` 0 = unknown.
 * With `kept`, a retry asks the server for the bytes after the ones it has.
 */
async function fetchToDisk(
  url: string,
  name: string,
  size: number,
  report: Report,
  signal: AbortSignal,
  kept?: Received,
): Promise<void> {
  const state = kept ?? { parts: [], done: 0 };
  const res = await fetch(withToken(state.done ? `${url}&offset=${state.done}` : url), {
    signal,
    headers: auth,
  });
  if (!res.ok || !res.body) throw await failure(res);
  const total = Number(res.headers.get("x-file-size")) || size;
  if (total)
    report(state.done, total, state.done ? { note: `continued at ${state.done} bytes` } : {});
  const reader = res.body.getReader();
  const { parts } = state;
  let { done } = state;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    parts.push(chunk.value as Uint8Array<ArrayBuffer>);
    done += chunk.value.byteLength;
    state.done = done;
    report(done);
  }
  if (done < total) throw new Error("The router closed the file before the end.");
  // An archive has no known size until it ends.
  report(done, done);
  saveBlob(new Blob(parts), name);
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
  /** Removes one finished, failed or stopped transfer from the list. */
  dismiss(id: string): void {
    const item = transfers.find((t) => t.id === id);
    if (!item || item.status === "queued" || item.status === "active") return;
    jobs.delete(id);
    transfers = transfers.filter((t) => t.id !== id);
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
    const received: Received = { parts: [], done: 0 };
    enqueue(
      {
        kind: "download",
        name: baseName(path),
        from: `${device}:${parentOf(path)}`,
        to: "this computer",
        total: size,
      },
      (report, signal) =>
        fetchToDisk(
          `/api/files/download?${query(device, path)}`,
          baseName(path),
          size,
          report,
          signal,
          received,
        ),
    );
  },

  /** Several files or folders of one router, as one ZIP archive. */
  downloadZip(device: string, dir: string, paths: string[], size: number): void {
    const name = `${device}-${paths.length === 1 ? baseName(paths[0] ?? "") : "files"}.zip`;
    const list = paths.map((path) => `path=${encodeURIComponent(path)}`).join("&");
    enqueue(
      { kind: "download", name, from: `${device}:${dir}`, to: "this computer", total: size },
      (report, signal) =>
        fetchToDisk(
          `/api/files/zip?device=${encodeURIComponent(device)}&${list}`,
          name,
          0,
          report,
          signal,
        ),
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
            direct: directStore.get(),
            verify: verifyStore.get(),
          }),
        });
        let ended = false;
        try {
          await readLines(res, (item) => {
            if (item.t === "start")
              report(Number(item.resumed ?? 0), Number(item.total), {
                via: String(item.via ?? ""),
                ...(Number(item.resumed) > 0
                  ? { note: `continued at ${String(item.resumed)} bytes` }
                  : {}),
              });
            else if (item.t === "note") report(0, undefined, { note: String(item.text) });
            else if (item.t === "progress") report(Number(item.done));
            else if (item.t === "end") {
              ended = true;
              if (typeof item.sha256 === "string")
                report(Number(item.bytes), undefined, {
                  note: `sha256 ${item.sha256.slice(0, 16)}…${item.verified === true ? " verified" : ""}`,
                });
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

/** What `/system resource` says about a router. */
export interface RouterSystem {
  free?: number;
  total?: number;
  arch?: string;
  version?: string;
}

/** `routeros-7.16.1-arm64.npk` → package, version, architecture (none for x86). */
export function npkInfo(name: string): { pkg: string; version: string; arch?: string } | null {
  const cells = name.match(
    /^(.+?)-(\d+\.\d+(?:\.\d+)?(?:(?:beta|rc)\d+)?)(?:-([a-z0-9_]+))?\.npk$/i,
  );
  return cells
    ? { pkg: cells[1] ?? "", version: cells[2] ?? "", arch: cells[3]?.toLowerCase() }
    : null;
}

/** Why a package file does not fit a router. Empty when it fits, or cannot be told. */
export function packageWarnings(name: string, router: RouterSystem): string[] {
  const info = npkInfo(name);
  if (!info || !router.arch) return [];
  const warnings: string[] = [];
  // RouterOS names x86 packages without an architecture.
  const fileArch = info.arch ?? "x86";
  const routerArch = router.arch.toLowerCase().replace(/^x86_64$/, "x86");
  if (fileArch !== routerArch)
    warnings.push(
      `${name} is for ${fileArch}, but the router is ${router.arch}. It will not install.`,
    );
  if (router.version && info.pkg !== "routeros" && info.version !== router.version)
    warnings.push(
      `${name} is version ${info.version}, but the router runs ${router.version}. An extra package must have the version of RouterOS.`,
    );
  return warnings;
}

export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
}
export interface DiskReport {
  total: number;
  /** Bytes for each top-level folder, and for the files in the root, largest first. */
  groups: { name: string; bytes: number; count: number }[];
  largest: TreeFile[];
  /** Files that are usually safe to remove, with the reason. */
  suggestions: { title: string; why: string; files: TreeFile[] }[];
}

const DAY = 24 * 60 * 60;
/** Where the space of a router goes, and what could be removed. */
export function analyzeDisk(files: TreeFile[], nowSeconds = Date.now() / 1000): DiskReport {
  const groups = new Map<string, { bytes: number; count: number }>();
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const name = parts.length > 1 ? `/${parts[0]}` : "files in /";
    const group = groups.get(name) ?? { bytes: 0, count: 0 };
    group.bytes += file.size;
    group.count += 1;
    groups.set(name, group);
  }
  const bySize = [...files].sort((a, b) => b.size - a.size);
  // Old backups: in each folder, the ones after the newest three, older than 30 days.
  const backups = new Map<string, TreeFile[]>();
  for (const file of files)
    if (/\.backup$/i.test(file.path))
      backups.set(parentOf(file.path), [...(backups.get(parentOf(file.path)) ?? []), file]);
  const oldBackups = Array.from(backups.values()).flatMap((list) =>
    list
      .sort((a, b) => b.mtime - a.mtime)
      .slice(3)
      .filter((file) => nowSeconds - file.mtime > 30 * DAY),
  );
  const suggestions = [
    {
      title: "Support output files",
      why: "autosupout files are made after a crash or for MikroTik support. They are large and are made again when needed.",
      files: files.filter((file) => /autosupout.*\.rif$/i.test(file.path)),
    },
    {
      title: "Old backups",
      why: "Backups older than 30 days, after the newest three of each folder.",
      files: oldBackups,
    },
    {
      title: "Unfinished copies",
      why: ".part files are left by a copy that did not finish. A retry of that copy continues from them.",
      files: files.filter((file) => /\.part$/i.test(file.path)),
    },
  ].filter((item) => item.files.length > 0);
  return {
    total: files.reduce((sum, file) => sum + file.size, 0),
    groups: Array.from(groups, ([name, group]) => ({ name, ...group })).sort(
      (a, b) => b.bytes - a.bytes,
    ),
    largest: bySize.slice(0, 15),
    suggestions,
  };
}

export interface FolderRow {
  name: string;
  /** `left`/`right`: only on that side. `different`: both, with another size. */
  state: "left" | "right" | "different" | "same";
  left?: FileEntry;
  right?: FileEntry;
  /** For `different`: the side with the later time of change. */
  newer?: "left" | "right";
}

/** Compare the files of two folders by name and size. Folders are left out. */
export function compareFolders(left: FileEntry[], right: FileEntry[]): FolderRow[] {
  const files = (list: FileEntry[]): Map<string, FileEntry> =>
    new Map(list.filter((entry) => !entry.dir).map((entry) => [entry.name, entry]));
  const a = files(left);
  const b = files(right);
  return Array.from(new Set([...a.keys(), ...b.keys()]))
    .sort((x, y) => x.localeCompare(y))
    .map((name) => {
      const l = a.get(name);
      const r = b.get(name);
      if (!l || !r) return { name, state: l ? "left" : "right", left: l, right: r };
      if (l.size === r.size) return { name, state: "same", left: l, right: r };
      return {
        name,
        state: "different",
        left: l,
        right: r,
        newer: l.mtime === r.mtime ? undefined : l.mtime > r.mtime ? "left" : "right",
      };
    });
}

/** Whether the folder comparison dialog is open. */
export const syncStore = store(false);

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
