/**
 * Dashboard Files — the files of every router, as in the Files window of WinBox.
 *
 * All file I/O is SFTP, the file subsystem of the RouterOS SSH server. One SFTP
 * session per router is kept open for a short time, so a listing, a search and
 * several transfers share one SSH connection.
 *
 * A router-to-router copy is relayed by this server: it reads the file from the
 * source router and writes it to the destination as one stream. The routers do
 * not need to reach each other, neither router learns the other's credentials,
 * and nothing is stored on this host.
 *
 * Files can hold secrets (backups, exports), so the routes are served only on a
 * protected dashboard (see {@link filesAccess}). A read-only server lists,
 * searches and downloads only. Every operation reaches the audit feed.
 */
import { crc32 } from "node:zlib";
import type { SFTPWrapper } from "ssh2";
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { getConfig, getDevice, resolveDeviceName } from "../core/runtime";
import { isMacTelnetDevice, resolveJump, sshOptionsOf } from "../core/transport";
import { logger } from "../logger";
import { MikroTikSSHClient } from "../ssh/client";
import { DashboardInputError, readOperationBody } from "./bounded-request";
import type { Risk } from "./event";
import { recordToolCall } from "./recorder";
import { terminalAccess } from "./terminal-routes";

/** Why the Files page is unavailable, or `null` when it may be used. */
export function filesAccess(cfg: { host: string; token?: string; files?: boolean }): string | null {
  if (cfg.files === false) return "The Files page is turned off (dashboard.files = false).";
  if (terminalAccess({ host: cfg.host, token: cfg.token }) === null) return null;
  return (
    "The Files page reads and writes files on your routers, so it needs a protected dashboard. " +
    "Set a dashboard token (--dashboard-token) or bind the dashboard to 127.0.0.1 (--dashboard-host)."
  );
}

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

/** The part of an SFTP session this module uses; tests give a fake. */
export type Sftp = Pick<
  SFTPWrapper,
  | "readdir"
  | "stat"
  | "unlink"
  | "rmdir"
  | "mkdir"
  | "rename"
  | "readFile"
  | "createReadStream"
  | "createWriteStream"
>;

/**
 * An absolute, normalised router path. Rejects `..` and control characters, so
 * a request cannot name anything the path does not show.
 */
export function cleanPath(input: unknown): string {
  if (typeof input !== "string") throw new DashboardInputError(400, "A path is required.");
  // eslint-disable-next-line no-control-regex -- control characters are what is rejected
  if (input.length > 1024 || /[\u0000-\u001F]/.test(input))
    throw new DashboardInputError(400, "The path is not valid.");
  const parts = input.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new DashboardInputError(400, "The path must not contain '..'.");
  return `/${parts.join("/")}`;
}

export const joinPath = (dir: string, name: string): string =>
  cleanPath(`${dir === "/" ? "" : dir}/${name}`);
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const call = <T>(
  run: (done: (err: Error | null | undefined, value?: T) => void) => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    run((err, value) => (err ? reject(err) : resolve(value as T)));
  });

/** Directories first, then by name. */
export async function listDir(sftp: Sftp, path: string): Promise<FileEntry[]> {
  const rows = await call<Parameters<Parameters<Sftp["readdir"]>[1]>[1]>((done) =>
    sftp.readdir(path, done),
  );
  return rows
    .filter((row) => row.filename !== "." && row.filename !== "..")
    .map((row) => ({
      name: row.filename,
      dir: row.attrs.isDirectory(),
      size: row.attrs.size,
      mtime: row.attrs.mtime,
    }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** A walk of a tree stops at these bounds, and says so. */
const MAX_VISITED = 4000;
const MAX_DEPTH = 8;
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** Make `dir` and the folders above it, when they do not exist. */
export async function ensureDir(sftp: Sftp, dir: string): Promise<void> {
  if (dir === "/") return;
  try {
    await call<unknown>((done) => sftp.stat(dir, done));
    return;
  } catch {
    /* not there yet */
  }
  await ensureDir(sftp, parentOf(dir));
  await call<void>((done) => sftp.mkdir(dir, done));
}

export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Every file and folder under `root` (or `root` itself when it is a file),
 * folders before their contents. Bounded like a search.
 */
export async function walkTree(
  sftp: Sftp,
  root: string,
): Promise<{ files: TreeFile[]; dirs: string[]; truncated: boolean }> {
  const stats = await call<{ size: number; mtime: number; isDirectory: () => boolean }>((done) =>
    sftp.stat(root, done),
  );
  if (!stats.isDirectory())
    return {
      files: [{ path: root, size: stats.size, mtime: stats.mtime }],
      dirs: [],
      truncated: false,
    };
  const files: TreeFile[] = [];
  const dirs = [root];
  let truncated = false;
  const queue = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    for (const entry of await listDir(sftp, path)) {
      if (files.length + dirs.length >= MAX_VISITED) return { files, dirs, truncated: true };
      const full = joinPath(path, entry.name);
      if (!entry.dir) files.push({ path: full, size: entry.size, mtime: entry.mtime });
      else if (depth + 1 < MAX_DEPTH) {
        dirs.push(full);
        queue.push({ path: full, depth: depth + 1 });
      } else truncated = true;
    }
  }
  return { files, dirs, truncated };
}

/** Delete a file, or a folder with everything in it. */
export async function removeTree(sftp: Sftp, target: string): Promise<void> {
  const tree = await walkTree(sftp, target);
  if (tree.truncated) throw new Error("The folder is too large to delete in one step.");
  for (const file of tree.files) await call<void>((done) => sftp.unlink(file.path, done));
  for (const dir of tree.dirs.reverse()) await call<void>((done) => sftp.rmdir(dir, done));
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [...u16(n & 0xffff), ...u16(n >>> 16)];

/**
 * A ZIP archive as a stream. Files are stored, not compressed: router files are
 * mostly compressed already, and the router's link is the limit, not the size.
 */
export async function* zipStream(
  entries: { name: string; mtime: number; read: () => AsyncIterable<Uint8Array> }[],
): AsyncGenerator<Uint8Array> {
  const central: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const date = new Date(entry.mtime * 1000);
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day =
      (Math.max(date.getFullYear() - 1980, 0) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    // Flags: sizes follow the data (bit 3), the name is UTF-8 (bit 11).
    const head = [...u16(20), ...u16(0x0808), ...u16(0), ...u16(time), ...u16(day)];
    yield Uint8Array.from([
      ...u32(0x04034b50),
      ...head,
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    let sum = 0;
    let size = 0;
    for await (const chunk of entry.read()) {
      sum = crc32(chunk, sum);
      size += chunk.byteLength;
      yield chunk;
    }
    yield Uint8Array.from([...u32(0x08074b50), ...u32(sum), ...u32(size), ...u32(size)]);
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...head,
      ...u32(sum),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    );
    offset += 30 + name.length + size + 16;
  }
  yield Uint8Array.from([
    ...central,
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0),
  ]);
}
/** A ZIP without ZIP64 holds less than 4 GiB; stay well under it. */
const MAX_ZIP_BYTES = 2 * 1024 ** 3;

/**
 * Copy a byte stream into a file on a router, with backpressure. A failed or
 * stopped copy removes the partial file: half of a package or a backup is worse
 * than none.
 */
export async function writeStream(
  sftp: Sftp,
  path: string,
  source: AsyncIterable<Uint8Array>,
  onBytes?: (total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  await ensureDir(sftp, parentOf(path));
  const out = sftp.createWriteStream(path);
  let failure: Error | undefined;
  out.on("error", (error: Error) => {
    failure = error;
  });
  let total = 0;
  try {
    for await (const chunk of source) {
      if (signal?.aborted) throw new Error("Stopped.");
      if (failure) throw failure;
      total += chunk.byteLength;
      if (!out.write(chunk))
        await new Promise<void>((resolve) => {
          out.once("drain", resolve);
          out.once("error", () => resolve());
        });
      onBytes?.(total);
    }
    if (failure) throw failure;
    await new Promise<void>((resolve, reject) => {
      out.once("close", () => (failure ? reject(failure) : resolve()));
      out.end();
    });
    return total;
  } catch (error) {
    out.destroy();
    await call<void>((done) => sftp.unlink(path, done)).catch(() => {});
    throw error;
  }
}

export interface SearchHit {
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  /** For a contents search: the line number and the line. */
  line?: number;
  text?: string;
}

/** Contents are searched in files up to this size. */
export const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_HITS = 500;
const TEXT_FILE =
  /\.(?:rsc|txt|log|conf|cfg|json|csv|html?|xml|ya?ml|sh|lua|py|md|ini|pem|crt|key|pub|ovpn)$/i;

/**
 * Walk the tree under `root` and report the files that match. A names search
 * tests the file name; a contents search reads small text files and tests each
 * line. The walk is bounded, and says when it stopped early.
 */
export async function searchTree(
  sftp: Sftp,
  root: string,
  test: (text: string) => boolean,
  options: { contents: boolean; signal?: AbortSignal },
  onHit: (hit: SearchHit) => void,
): Promise<{ scanned: number; truncated: boolean }> {
  let scanned = 0;
  let hits = 0;
  let truncated = false;
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (queue.length > 0 && !options.signal?.aborted) {
    const { path, depth } = queue.shift()!;
    let entries: FileEntry[];
    try {
      entries = await listDir(sftp, path);
    } catch {
      continue; // a directory the user may not read
    }
    for (const entry of entries) {
      if (options.signal?.aborted) break;
      if (scanned >= MAX_VISITED || hits >= MAX_HITS) {
        truncated = true;
        return { scanned, truncated };
      }
      scanned += 1;
      const full = joinPath(path, entry.name);
      const hit = { path: full, dir: entry.dir, size: entry.size, mtime: entry.mtime };
      if (entry.dir) {
        if (depth + 1 < MAX_DEPTH) queue.push({ path: full, depth: depth + 1 });
        else truncated = true;
      }
      if (!options.contents) {
        if (test(entry.name)) {
          hits += 1;
          onHit(hit);
        }
        continue;
      }
      if (entry.dir || entry.size > MAX_CONTENT_BYTES || !TEXT_FILE.test(entry.name)) continue;
      let body: Buffer;
      try {
        body = await call<Buffer>((done) => sftp.readFile(full, done));
      } catch {
        continue;
      }
      const lines = body.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length && hits < MAX_HITS; index += 1) {
        const text = lines[index] ?? "";
        if (!test(text)) continue;
        hits += 1;
        onHit({ ...hit, line: index + 1, text: text.slice(0, 300) });
      }
    }
  }
  return { scanned, truncated };
}

/** The text of a small file. Refuses a folder, a large file and a binary file. */
export async function readText(
  sftp: Sftp,
  path: string,
): Promise<{ text: string; size: number; mtime: number }> {
  const stats = await call<{ size: number; mtime: number; isDirectory: () => boolean }>((done) =>
    sftp.stat(path, done),
  );
  if (stats.isDirectory()) throw new DashboardInputError(400, "This is a folder, not a file.");
  if (stats.size > MAX_CONTENT_BYTES)
    throw new DashboardInputError(413, "The file is larger than 1 MiB. Download it instead.");
  const body = await call<Buffer>((done) => sftp.readFile(path, done));
  if (body.includes(0)) throw new DashboardInputError(415, "This is not a text file.");
  return { text: body.toString("utf8"), size: stats.size, mtime: stats.mtime };
}

/** A matcher for the search box: plain text (no case) or a regular expression. */
export function matcher(query: string, regex: boolean): (text: string) => boolean {
  if (regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, "i");
    } catch {
      throw new DashboardInputError(400, "The regular expression is not valid.");
    }
    return (text) => pattern.test(text);
  }
  const needle = query.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

// ── SFTP sessions ─────────────────────────────────────────────────────────
interface Session {
  client: MikroTikSSHClient;
  sftp: SFTPWrapper;
  users: number;
  idle: ReturnType<typeof setTimeout> | undefined;
}
const sessions = new Map<string, Promise<Session>>();
const IDLE_MS = 60_000;

async function open(device: string): Promise<Session> {
  const dc = getDevice(device);
  if (isMacTelnetDevice(dc))
    throw new DashboardInputError(
      400,
      `'${device}' is reached over MAC-Telnet, which has no file transfer. Configure SSH for it.`,
    );
  const client = new MikroTikSSHClient({
    ...sshOptionsOf(dc),
    jump: resolveJump(dc),
    keepAliveInterval: 15_000,
    keepAliveCountMax: 3,
  });
  if (!(await client.connect()))
    throw new DashboardInputError(
      502,
      `Could not connect to ${device}: ${client.lastError ?? "unknown error"}`,
    );
  try {
    const sftp = await client.sftp();
    const drop = (): void => {
      sessions.delete(device);
      client.disconnect();
    };
    sftp.on("close", drop);
    sftp.on("error", drop);
    return { client, sftp, users: 0, idle: undefined };
  } catch (error) {
    client.disconnect();
    throw new DashboardInputError(502, error instanceof Error ? error.message : String(error));
  }
}

/** Run `work` with the router's SFTP session; the session closes after a quiet minute. */
async function withSftp<T>(device: string, work: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  let pending = sessions.get(device);
  if (!pending) {
    pending = open(device);
    sessions.set(device, pending);
    pending.catch(() => sessions.delete(device));
  }
  const session = await pending;
  if (session.idle) clearTimeout(session.idle);
  session.users += 1;
  try {
    return await work(session.sftp);
  } finally {
    session.users -= 1;
    if (session.users === 0) {
      session.idle = setTimeout(() => {
        if (session.users > 0) return;
        sessions.delete(device);
        session.client.disconnect();
      }, IDLE_MS);
      session.idle.unref?.();
    }
  }
}

/** The router's SFTP session, held until `release`: for a response that streams. */
async function holdSftp(device: string): Promise<{ sftp: SFTPWrapper; release: () => void }> {
  let release!: () => void;
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    withSftp(device, (session) => {
      resolve(session);
      return new Promise<void>((done) => (release = done));
    }).catch(reject);
  });
  return { sftp, release };
}

/** Close every SFTP session (dashboard shutdown). */
export function closeFileSessions(): void {
  for (const [device, pending] of Array.from(sessions)) {
    sessions.delete(device);
    void pending.then((session) => session.client.disconnect()).catch(() => {});
  }
}

// ── routes ────────────────────────────────────────────────────────────────
const noStore = { "cache-control": "no-store" };
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStore });

function audit(
  device: string,
  risk: Risk,
  started: number,
  args: Record<string, unknown>,
  output: string,
  isError = false,
): void {
  recordToolCall({
    tool: "dashboard_files",
    title: "Dashboard Files",
    risk,
    device,
    deviceTransport: "ssh",
    ts: started,
    durationMs: Date.now() - started,
    isError,
    args,
    output,
    hasStructured: false,
  });
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** NDJSON response; `run` sends messages until it returns. A lost viewer aborts it. */
function ndjson(
  req: Request,
  run: (send: (item: unknown) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (item: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`));
        } catch {
          abort.abort();
        }
      };
      try {
        await run(send, abort.signal);
      } catch (error) {
        send({ t: "error", error: message(error) });
      }
      try {
        controller.close();
      } catch {
        /* the viewer already left */
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", ...noStore },
  });
}

/** Upload bodies are not read by `readOperationBody`, so the origin is checked here. */
function sameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin)
    throw new DashboardInputError(403, "Cross-origin operation denied");
}

const deviceOf = (value: unknown): string => {
  if (typeof value !== "string" || !value)
    throw new DashboardInputError(400, "A router is required.");
  const name = resolveDeviceName(value);
  try {
    getDevice(name);
  } catch {
    throw new DashboardInputError(404, `There is no router named '${name}'.`);
  }
  return name;
};

export function createFilesRoutes(options: { denied: string | null }) {
  return async function filesRoutes(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith("/api/files/")) return null;
    const key = `${req.method} ${path}`;
    const readOnly = getConfig().readOnly;

    if (key === "GET /api/files/state")
      return json({ enabled: options.denied === null, reason: options.denied, readOnly });
    if (options.denied !== null) return json({ error: options.denied }, 403);

    try {
      if (key === "GET /api/files/list") {
        const device = deviceOf(url.searchParams.get("device"));
        const dir = cleanPath(url.searchParams.get("path") ?? "/");
        return json({ path: dir, entries: await withSftp(device, (sftp) => listDir(sftp, dir)) });
      }

      if (key === "GET /api/files/usage") {
        const device = deviceOf(url.searchParams.get("device"));
        const output = await executeMikrotikCommand(
          ':put ([/system resource get free-hdd-space] . "/" . [/system resource get total-hdd-space])',
          createContext(undefined, device),
        );
        const cells = output.match(/(\d+)\/(\d+)/);
        return json(cells ? { free: Number(cells[1]), total: Number(cells[2]) } : {});
      }

      if (key === "GET /api/files/download") {
        const device = deviceOf(url.searchParams.get("device"));
        const file = cleanPath(url.searchParams.get("path"));
        const started = Date.now();
        return await withSftp(device, async (sftp) => {
          const stats = await call<{ size: number; isDirectory: () => boolean }>((done) =>
            sftp.stat(file, done),
          );
          if (stats.isDirectory())
            throw new DashboardInputError(400, "A directory cannot be downloaded.");
          const source = sftp.createReadStream(file);
          // Hold the SFTP session until the browser has the whole file.
          let release!: () => void;
          const held = withSftp(device, () => new Promise<void>((resolve) => (release = resolve)));
          void held.catch(() => {});
          const finish = (error?: string): void => {
            release();
            audit(
              device,
              "READ",
              started,
              { download: file },
              error ?? `${stats.size} bytes`,
              !!error,
            );
          };
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              source.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 1) <= 0) source.pause();
              });
              source.on("end", () => {
                controller.close();
                finish();
              });
              source.on("error", (error: Error) => {
                controller.error(error);
                finish(error.message);
              });
            },
            pull() {
              source.resume();
            },
            cancel() {
              source.destroy();
              finish("The viewer stopped the download.");
            },
          });
          return new Response(body, {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(stats.size),
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(baseName(file))}`,
              ...noStore,
            },
          });
        });
      }

      if (key === "GET /api/files/tree") {
        const device = deviceOf(url.searchParams.get("device"));
        const root = cleanPath(url.searchParams.get("path"));
        return json(await withSftp(device, (sftp) => walkTree(sftp, root)));
      }

      if (key === "GET /api/files/zip") {
        const device = deviceOf(url.searchParams.get("device"));
        const roots = url.searchParams.getAll("path").slice(0, 200).map(cleanPath);
        if (roots.length === 0) throw new DashboardInputError(400, "Choose the files to download.");
        const started = Date.now();
        // Names in the archive are relative to the folder the selection is in.
        const base = parentOf(roots[0] ?? "/");
        const files: TreeFile[] = [];
        await withSftp(device, async (sftp) => {
          for (const root of roots) files.push(...(await walkTree(sftp, root)).files);
        });
        if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ZIP_BYTES)
          throw new DashboardInputError(413, "The selection is larger than 2 GiB.");
        const { sftp, release } = await holdSftp(device);
        const archive = zipStream(
          files.map((file) => ({
            name: file.path.slice(base === "/" ? 1 : base.length + 1),
            mtime: file.mtime,
            read: () => sftp.createReadStream(file.path) as AsyncIterable<Uint8Array>,
          })),
        );
        const finish = (error?: string): void => {
          release();
          audit(device, "READ", started, { zip: roots }, error ?? `${files.length} files`, !!error);
        };
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await archive.next();
              if (next.done) {
                controller.close();
                finish();
              } else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
              finish(message(error));
            }
          },
          cancel() {
            void archive.return(undefined);
            finish("The viewer stopped the download.");
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${device.replace(/[^\w.-]+/g, "-")}-files.zip"`,
            ...noStore,
          },
        });
      }

      if (key === "GET /api/files/read") {
        const device = deviceOf(url.searchParams.get("device"));
        const file = cleanPath(url.searchParams.get("path"));
        const started = Date.now();
        const answer = await withSftp(device, (sftp) => readText(sftp, file));
        audit(device, "READ", started, { read: file }, `${answer.size} bytes`);
        return json(answer);
      }

      if (req.method !== "POST") return json({ error: "Unsupported files route" }, 405);

      if (key === "POST /api/files/search") {
        const body = JSON.parse((await readOperationBody(req, 16_384)) || "{}") as Record<
          string,
          unknown
        >;
        const query = typeof body.q === "string" ? body.q.trim() : "";
        if (!query) throw new DashboardInputError(400, "Type what to search for.");
        const contents = body.contents === true;
        const test = matcher(query.slice(0, 200), body.regex === true);
        const targets = (Array.isArray(body.targets) ? body.targets : [])
          .slice(0, 24)
          .map((target: { device?: unknown; path?: unknown }) => ({
            device: deviceOf(target?.device),
            path: cleanPath(target?.path ?? "/"),
          }));
        if (targets.length === 0) throw new DashboardInputError(400, "Choose a router to search.");
        return ndjson(req, async (send, signal) => {
          await Promise.all(
            targets.map(async ({ device, path: root }) => {
              try {
                const result = await withSftp(device, (sftp) =>
                  searchTree(sftp, root, test, { contents, signal }, (hit) =>
                    send({ t: "hit", device, ...hit }),
                  ),
                );
                send({ t: "done", device, ...result });
              } catch (error) {
                send({ t: "done", device, scanned: 0, truncated: false, error: message(error) });
              }
            }),
          );
        });
      }

      // Everything below changes a router.
      if (readOnly)
        return json(
          { error: "This server is read-only. Files can be viewed and downloaded." },
          403,
        );

      if (key === "POST /api/files/upload") {
        sameOrigin(req);
        const device = deviceOf(url.searchParams.get("device"));
        const file = cleanPath(url.searchParams.get("path"));
        if (file === "/" || !req.body) throw new DashboardInputError(400, "A file is required.");
        const started = Date.now();
        try {
          const bytes = await withSftp(device, (sftp) =>
            writeStream(
              sftp,
              file,
              req.body as unknown as AsyncIterable<Uint8Array>,
              undefined,
              req.signal,
            ),
          );
          audit(device, "WRITE", started, { upload: file }, `${bytes} bytes`);
          return json({ ok: true, bytes });
        } catch (error) {
          audit(device, "WRITE", started, { upload: file }, message(error), true);
          throw error;
        }
      }

      const body = JSON.parse((await readOperationBody(req, 65_536)) || "{}") as Record<
        string,
        unknown
      >;

      if (key === "POST /api/files/transfer") {
        const from = body.from as { device?: unknown; path?: unknown } | undefined;
        const to = body.to as { device?: unknown; path?: unknown } | undefined;
        const source = { device: deviceOf(from?.device), path: cleanPath(from?.path) };
        const target = { device: deviceOf(to?.device), path: cleanPath(to?.path) };
        if (source.device === target.device && source.path === target.path)
          throw new DashboardInputError(400, "The source and the destination are the same file.");
        const started = Date.now();
        const args = {
          copy: `${source.device}:${source.path}`,
          to: `${target.device}:${target.path}`,
        };
        return ndjson(req, async (send, signal) => {
          try {
            const bytes = await withSftp(source.device, (reader) =>
              withSftp(target.device, async (writer) => {
                const stats = await call<{ size: number; isDirectory: () => boolean }>((done) =>
                  reader.stat(source.path, done),
                );
                if (stats.isDirectory()) throw new Error("A directory cannot be copied.");
                send({ t: "start", total: stats.size });
                let last = 0;
                return writeStream(
                  writer,
                  target.path,
                  reader.createReadStream(source.path) as AsyncIterable<Uint8Array>,
                  (done) => {
                    if (Date.now() - last < 150) return;
                    last = Date.now();
                    send({ t: "progress", done });
                  },
                  signal,
                );
              }),
            );
            audit(target.device, "WRITE", started, args, `${bytes} bytes`);
            send({ t: "end", ok: true, bytes });
          } catch (error) {
            audit(target.device, "WRITE", started, args, message(error), true);
            send({ t: "end", ok: false, error: message(error) });
          }
        });
      }

      const device = deviceOf(body.device);
      const started = Date.now();

      if (key === "POST /api/files/delete") {
        const paths = (Array.isArray(body.paths) ? body.paths : []).slice(0, 200).map(cleanPath);
        if (paths.length === 0 || paths.includes("/"))
          throw new DashboardInputError(400, "Choose the files to delete.");
        const failed: { path: string; error: string }[] = [];
        await withSftp(device, async (sftp) => {
          for (const target of paths) {
            try {
              await removeTree(sftp, target);
            } catch (error) {
              failed.push({ path: target, error: message(error) });
            }
          }
        });
        audit(
          device,
          "DESTRUCTIVE",
          started,
          { delete: paths },
          failed.length ? `${failed.length} of ${paths.length} failed` : `${paths.length} deleted`,
          failed.length > 0,
        );
        return json({ ok: failed.length === 0, failed });
      }

      if (key === "POST /api/files/rename") {
        const from = cleanPath(body.from);
        const to = cleanPath(body.to);
        if (from === "/" || to === "/")
          throw new DashboardInputError(400, "A file name is required.");
        await withSftp(device, (sftp) => call<void>((done) => sftp.rename(from, to, done)));
        audit(device, "WRITE", started, { rename: from, to }, "renamed");
        return json({ ok: true });
      }

      if (key === "POST /api/files/mkdir") {
        const dir = cleanPath(body.path);
        if (dir === "/") throw new DashboardInputError(400, "A folder name is required.");
        await withSftp(device, (sftp) => call<void>((done) => sftp.mkdir(dir, done)));
        audit(device, "WRITE", started, { mkdir: dir }, "created");
        return json({ ok: true });
      }

      return json({ error: "Unknown files route" }, 404);
    } catch (error) {
      if (error instanceof DashboardInputError) return json({ error: error.message }, error.status);
      logger.warn(`Files route ${key} failed: ${message(error)}`);
      return json({ error: message(error) }, 502);
    }
  };
}
