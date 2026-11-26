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
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { SFTPWrapper } from "ssh2";
import { backupDir, deleteBackup, safeName, writeBinaryBackup } from "../backups/vault";
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { Cmd, looksLikeError } from "../core/routeros";
import { getS3Client, isS3Configured, s3Key } from "../core/s3";
import { deviceSlug } from "../core/slug";
import { getConfig, getDevice, onConfigChanged, resolveDeviceName } from "../core/runtime";
import { isMacTelnetDevice, resolveJump, sshOptionsOf } from "../core/transport";
import { logger } from "../logger";
import { MikroTikSSHClient } from "../ssh/client";
import { DashboardInputError, readOperationBody } from "./bounded-request";
import type { Risk } from "./event";
import { recordToolCall } from "./recorder";
import { addJob, listJobs, removeJob, runDueJobs, runJob } from "./files-schedules";
import { listTrash, openTrash, purgeTrash, stash, trashEnabled } from "./files-trash";
import { clientError } from "./http-error";

/**
 * Why the Files page is unavailable, or `null` when it may be used. The page is
 * on unless `dashboard.files` is false; it does not need a token or a loopback
 * bind. Whoever can open the dashboard can then read and change router files,
 * so an operator on an untrusted network sets a token or turns the page off.
 */
export function filesAccess(cfg: { files?: boolean } | undefined): string | null {
  return cfg?.files === false
    ? "The Files page is turned off. Turn it on in Config → Dashboard (dashboard.files)."
    : null;
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
export async function removeTree(
  sftp: Sftp,
  target: string,
  before?: (file: string) => Promise<unknown>,
): Promise<void> {
  const tree = await walkTree(sftp, target);
  if (tree.truncated) throw new Error("The folder is too large to delete in one step.");
  for (const file of tree.files) {
    await before?.(file.path);
    await call<void>((done) => sftp.unlink(file.path, done));
  }
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

/** The size of one SFTP write. */
const WRITE_BYTES = 32 * 1024;
/** A write with no answer for this long means the connection to the router is lost. */
export const WRITE_ANSWER_MS = 60_000;

/** `work`, or an error when the router does not answer in `ms`. */
function answered<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The router did not answer for ${Math.round(ms / 1000)} seconds. The connection is probably lost.`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Copy a byte stream into a file on a router, with backpressure. A failed or
 * stopped copy removes the partial file: half of a package or a backup is worse
 * than none. With `keep`, the partial file stays, so a later copy can continue
 * at `start`.
 */
export async function writeStream(
  sftp: Sftp,
  path: string,
  source: AsyncIterable<Uint8Array>,
  onBytes?: (total: number) => void,
  signal?: AbortSignal,
  options: { start?: number; keep?: boolean } = {},
): Promise<number> {
  await ensureDir(sftp, parentOf(path));
  const out = options.start
    ? sftp.createWriteStream(path, { flags: "r+", start: options.start })
    : sftp.createWriteStream(path);
  let failure: Error | undefined;
  out.on("error", (error: Error) => {
    failure = error;
  });
  // Two ways a copy ends that the source does not report: the caller stops it,
  // or the router's connection closes. Without these, the copy waits for ever.
  const stopped = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new Error("Stopped."));
    signal?.addEventListener("abort", () => reject(new Error("Stopped.")), { once: true });
  });
  const closed = new Promise<never>((_, reject) => {
    out.once("close", () =>
      reject(failure ?? new Error("The connection to the router closed before the end.")),
    );
  });
  stopped.catch(() => {});
  closed.catch(() => {});
  const iterator = source[Symbol.asyncIterator]();
  let total = options.start ?? 0;
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), stopped, closed]);
      if (next.done) break;
      if (failure) throw failure;
      // One small write at a time, each confirmed by the router. A browser upload
      // arrives in pieces of up to 1 MiB, and RouterOS stops answering when such
      // a piece is sent as many SFTP requests at once.
      for (let at = 0; at < next.value.byteLength; at += WRITE_BYTES) {
        const piece = next.value.subarray(at, at + WRITE_BYTES);
        await Promise.race([
          answered(
            new Promise<void>((resolve, reject) => {
              out.write(piece, (error) => (error ? reject(error) : resolve()));
            }),
            WRITE_ANSWER_MS,
          ),
          stopped,
          closed,
        ]);
        total += piece.byteLength;
        onBytes?.(total);
      }
    }
    if (failure) throw failure;
    await new Promise<void>((resolve, reject) => {
      out.once("close", () => (failure ? reject(failure) : resolve()));
      out.end();
    });
    return total;
  } catch (error) {
    void iterator.return?.()?.catch(() => {});
    out.destroy();
    // On a lost connection the removal gets no answer either: do not wait long for it.
    if (!options.keep)
      await answered(
        call<void>((done) => sftp.unlink(path, done)),
        10_000,
      ).catch(() => {});
    throw error;
  }
}

/** The SHA-256 of a file on a router, as hex. */
export async function hashFile(sftp: Sftp, path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of sftp.createReadStream(path) as AsyncIterable<Uint8Array>)
    hash.update(chunk);
  return hash.digest("hex");
}

/** A copy larger than this is written to `<name>.part` first, so it can continue after a failure. */
export const RESUMABLE_BYTES = 8 * 1024 * 1024;

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
    // No SSH keepalive: RouterOS does not answer the keepalive request, so the
    // client would end a healthy session after interval × count, in the middle
    // of a long transfer. A lost connection is found by the write watchdog.
  });
  if (!(await client.connect()))
    throw new DashboardInputError(
      502,
      `Could not connect to ${device}: ${client.lastError ?? "unknown error"}`,
    );
  try {
    const sftp = await client.sftp();
    const drop = (why: string): void => {
      if (sessions.delete(device))
        logger.info(`Files: the SFTP session to '${device}' ended (${why})`);
      client.disconnect();
    };
    sftp.on("close", () => drop("closed"));
    sftp.on("error", (error: Error) => drop(error.message));
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

let jobTimer: ReturnType<typeof setInterval> | undefined;

/** Close every SFTP session and stop the scheduled jobs (dashboard shutdown). */
export function closeFileSessions(): void {
  if (jobTimer) clearInterval(jobTimer);
  jobTimer = undefined;
  for (const [device, pending] of Array.from(sessions)) {
    sessions.delete(device);
    void pending.then((session) => session.client.disconnect()).catch(() => {});
  }
}

onConfigChanged(() => {
  const devices = getConfig()?.devices ?? {};
  for (const [device, pending] of Array.from(sessions)) {
    const dc = devices[device];
    if (!dc || dc.disabled) {
      sessions.delete(device);
      void pending.then((session) => session.client.disconnect()).catch(() => {});
    }
  }
});

/** A tail starts with this much of the end of the file, and ends after this long. */
const TAIL_START_BYTES = 32 * 1024;
const TAIL_MAX_MS = 30 * 60_000;

// ── vault ─────────────────────────────────────────────────────────────────
/** A file is read into memory on its way to the vault; larger ones are refused. */
export const MAX_VAULT_BYTES = 256 * 1024 * 1024;

export interface VaultFile {
  name: string;
  bytes: number;
  /** Milliseconds since the epoch. */
  modified: number;
}

/** Every file in the backup vault of this host, newest first. */
export function listVault(): VaultFile[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, stats: statSync(join(dir, name)) }))
    .filter(({ stats }) => stats.isFile())
    .map(({ name, stats }) => ({ name, bytes: stats.size, modified: stats.mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
}

/** `<router>_<file>`, as the Backups page names its files, with only safe characters. */
export const vaultName = (device: string, path: string): string =>
  `${deviceSlug(device)}_${baseName(path).replace(/[^A-Za-z0-9._-]+/g, "-")}`;

/**
 * Copy the files of `dir` that match `pattern` into the vault, for a scheduled
 * job. A file that the vault already has, with the same size, is left out.
 */
async function collectToVault(device: string, dir: string, pattern: RegExp): Promise<string[]> {
  return withSftp(device, async (sftp) => {
    const written: string[] = [];
    const have = new Map(listVault().map((item) => [item.name, item.bytes]));
    for (const entry of await listDir(sftp, dir)) {
      if (entry.dir || entry.size > MAX_VAULT_BYTES || !pattern.test(entry.name)) continue;
      const name = vaultName(device, entry.name);
      if (have.get(name) === entry.size) continue;
      const data = await call<Buffer>((done) => sftp.readFile(joinPath(dir, entry.name), done));
      written.push(writeBinaryBackup(name, data));
    }
    return written;
  });
}
const dropFromVault = (name: string): void => {
  try {
    deleteBackup(name);
  } catch {
    /* already gone */
  }
};
const routerNames = (): string[] =>
  Object.entries(getConfig().devices ?? {})
    .filter(([, dc]) => !dc.disabled)
    .map(([name]) => name);

// ── direct copy ───────────────────────────────────────────────────────────
interface Endpoint {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  jumpHost?: unknown;
  jumpVia?: unknown;
}

/**
 * Why the destination router cannot fetch a file from the source by itself, or
 * `null` when it can. A direct copy gives the destination the source's SSH
 * password for one command, so it is used only when the caller asks for it.
 */
export function directBlocker(source: Endpoint, target: Endpoint): string | null {
  if (!source.host) return "the source router has no IP address in the config.";
  if (!source.password) return "the source router signs in with a key, not a password.";
  if (source.jumpHost || source.jumpVia) return "the source router is behind a jump host.";
  if (!target.host) return "the destination router is not reached over SSH.";
  return null;
}

/** The `/tool fetch` that makes a router pull a file from another router over SFTP. */
export function fetchCommand(source: Endpoint, sourcePath: string, targetPath: string): string {
  return new Cmd("/tool fetch")
    .raw("mode=sftp")
    .set("address", source.host ?? "")
    .set("port", source.port ?? 22)
    .set("user", source.username ?? "")
    .set("password", source.password ?? "")
    .set("src-path", sourcePath.slice(1))
    .set("dst-path", targetPath.slice(1))
    .build();
}

/** Have the destination fetch the file; progress is the size of the growing file. */
async function directCopy(
  source: { device: string; path: string },
  target: { device: string; path: string },
  total: number,
  writer: Sftp,
  progress: (done: number) => void,
  signal: AbortSignal,
): Promise<void> {
  await ensureDir(writer, parentOf(target.path));
  const size = (): Promise<number> =>
    call<{ size: number }>((done) => writer.stat(target.path, done)).then(
      (stats) => stats.size,
      () => 0,
    );
  const poll = setInterval(() => void size().then(progress), 1000);
  try {
    const output = await executeMikrotikCommand(
      fetchCommand(getDevice(source.device), source.path, target.path),
      createContext(undefined, target.device),
      { maxMs: 600_000, signal },
    );
    if (looksLikeError(output)) throw new Error(output.trim().split("\n").pop() ?? "fetch failed");
    const got = await size();
    if (got !== total) throw new Error(`the destination has ${got} of ${total} bytes`);
  } finally {
    clearInterval(poll);
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

/** `denied` is asked on each request, so a change in the settings applies at once. */
export function createFilesRoutes(options: { denied: () => string | null }) {
  if (!jobTimer) {
    jobTimer = setInterval(() => {
      if (options.denied() !== null) return;
      void runDueJobs(routerNames(), collectToVault, dropFromVault).catch((error) =>
        logger.warn(`Scheduled file jobs did not run: ${message(error)}`),
      );
    }, 60_000);
    jobTimer.unref?.();
  }

  return async function filesRoutes(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith("/api/files/")) return null;
    const key = `${req.method} ${path}`;
    const readOnly = getConfig().readOnly;
    const denied = options.denied();

    if (key === "GET /api/files/state")
      return json({
        enabled: denied === null,
        reason: denied,
        readOnly,
        trash: trashEnabled(),
        s3: isS3Configured(),
      });
    if (denied !== null) return json({ error: denied }, 403);

    try {
      if (key === "GET /api/files/list") {
        const device = deviceOf(url.searchParams.get("device"));
        const dir = cleanPath(url.searchParams.get("path") ?? "/");
        return json({ path: dir, entries: await withSftp(device, (sftp) => listDir(sftp, dir)) });
      }

      if (key === "GET /api/files/usage") {
        const device = deviceOf(url.searchParams.get("device"));
        const output = await executeMikrotikCommand(
          ':put ([/system resource get free-hdd-space] . "/" . [/system resource get total-hdd-space] . "/" . [/system resource get architecture-name] . "/" . [/system resource get version])',
          createContext(undefined, device),
        );
        // 83382272/134217728/arm64/7.16.1 (stable)
        const cells = output.match(/(\d+)\/(\d+)\/([^/\s]*)\/(\S*)/);
        return json(
          cells
            ? { free: Number(cells[1]), total: Number(cells[2]), arch: cells[3], version: cells[4] }
            : {},
        );
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
          // A stopped download continues where it was.
          const offset = Math.min(
            Math.max(Number(url.searchParams.get("offset")) || 0, 0),
            stats.size,
          );
          const source = sftp.createReadStream(file, offset ? { start: offset } : undefined);
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
              "content-length": String(stats.size - offset),
              // Bun streams without a length; the browser reads the size here.
              "x-file-size": String(stats.size),
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

      if (key === "GET /api/files/trash") return json({ items: listTrash() });
      if (key === "GET /api/files/jobs") return json({ jobs: listJobs() });
      if (key === "GET /api/files/vault") return json({ dir: backupDir(), files: listVault() });

      if (key === "GET /api/files/tail") {
        // Follow a file that grows (a log): its end now, then what is added.
        const device = deviceOf(url.searchParams.get("device"));
        const file = cleanPath(url.searchParams.get("path"));
        const every = Math.min(
          Math.max(Number(url.searchParams.get("every")) || 2000, 200),
          60_000,
        );
        const { sftp, release } = await holdSftp(device);
        const size = (): Promise<number> =>
          call<{ size: number }>((done) => sftp.stat(file, done)).then((stats) => stats.size);
        const stop = new AbortController();
        req.signal.addEventListener("abort", () => stop.abort(), { once: true });
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              let offset = Math.max((await size()) - TAIL_START_BYTES, 0);
              const until = Date.now() + TAIL_MAX_MS;
              while (!stop.signal.aborted && Date.now() < until) {
                const now = await size();
                if (now < offset) {
                  offset = 0;
                  controller.enqueue(encoder.encode("\n--- the file was replaced ---\n"));
                }
                if (now > offset) {
                  const range = { start: offset, end: now - 1 };
                  for await (const chunk of sftp.createReadStream(
                    file,
                    range,
                  ) as AsyncIterable<Uint8Array>)
                    controller.enqueue(new Uint8Array(chunk));
                  offset = now;
                }
                await new Promise((resolve) => setTimeout(resolve, every));
              }
              controller.close();
            } catch (error) {
              if (!stop.signal.aborted) controller.error(error);
            } finally {
              release();
            }
          },
          cancel() {
            stop.abort();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/plain; charset=utf-8", ...noStore },
        });
      }

      if (key === "GET /api/files/hash") {
        const device = deviceOf(url.searchParams.get("device"));
        const file = cleanPath(url.searchParams.get("path"));
        return json({ sha256: await withSftp(device, (sftp) => hashFile(sftp, file)) });
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

      if (key.startsWith("POST /api/files/jobs")) {
        // A job reads routers and writes this host, so a read-only server may have jobs.
        const input = JSON.parse((await readOperationBody(req, 16_384)) || "{}") as Record<
          string,
          unknown
        >;
        if (key === "POST /api/files/jobs") {
          const devices = (Array.isArray(input.devices) ? input.devices : []).map(deviceOf);
          try {
            return json({
              job: addJob({ ...input, devices, dir: cleanPath(input.dir ?? "/") }),
            });
          } catch (error) {
            throw new DashboardInputError(400, message(error));
          }
        }
        const id = String(input.id ?? "");
        if (key === "POST /api/files/jobs/remove") return json({ ok: removeJob(id) });
        const job = listJobs().find((candidate) => candidate.id === id);
        if (!job) throw new DashboardInputError(404, "There is no such job.");
        await runJob(job, routerNames(), collectToVault, dropFromVault);
        return json({ job });
      }

      if (key === "POST /api/files/vault/save") {
        // Reads the router and writes this host, so a read-only server may do it.
        const input = JSON.parse((await readOperationBody(req, 65_536)) || "{}") as Record<
          string,
          unknown
        >;
        const device = deviceOf(input.device);
        const paths = (Array.isArray(input.paths) ? input.paths : []).slice(0, 100).map(cleanPath);
        if (paths.length === 0) throw new DashboardInputError(400, "Choose the files to save.");
        const toS3 = input.s3 === true;
        if (toS3 && !isS3Configured()) throw new DashboardInputError(400, "S3 is not configured.");
        const started = Date.now();
        const saved: { path: string; name: string; s3?: string }[] = [];
        const failed: { path: string; error: string }[] = [];
        await withSftp(device, async (sftp) => {
          for (const file of paths) {
            try {
              const stats = await call<{ size: number; isDirectory: () => boolean }>((done) =>
                sftp.stat(file, done),
              );
              if (stats.isDirectory()) throw new Error("A folder is not saved. Select its files.");
              if (stats.size > MAX_VAULT_BYTES) throw new Error("The file is larger than 256 MiB.");
              const data = await call<Buffer>((done) => sftp.readFile(file, done));
              const name = writeBinaryBackup(vaultName(device, file), data);
              const entry: (typeof saved)[number] = { path: file, name };
              if (toS3) {
                entry.s3 = s3Key(name, device);
                await getS3Client().write(entry.s3, data);
              }
              saved.push(entry);
            } catch (error) {
              failed.push({ path: file, error: message(error) });
            }
          }
        });
        audit(
          device,
          "READ",
          started,
          { toVault: paths, s3: toS3 },
          `${saved.length} saved, ${failed.length} failed`,
          failed.length > 0,
        );
        return json({ ok: failed.length === 0, saved, failed });
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
          const bytes = await withSftp(device, async (sftp) => {
            // The file this upload replaces goes to the recycle bin first.
            await stash(sftp, device, file, "replaced");
            return writeStream(
              sftp,
              file,
              req.body as unknown as AsyncIterable<Uint8Array>,
              undefined,
              req.signal,
            );
          });
          // A browser that left early gives a shorter body, with no error.
          const expected = Number(req.headers.get("content-length"));
          if (expected > 0 && bytes !== expected) {
            await withSftp(device, (sftp) => call<void>((done) => sftp.unlink(file, done))).catch(
              () => {},
            );
            throw new Error(`The upload stopped at ${bytes} of ${expected} bytes.`);
          }
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
        const wantDirect = body.direct === true && source.device !== target.device;
        return ndjson(req, async (send, signal) => {
          try {
            const done = await withSftp(source.device, (reader) =>
              withSftp(target.device, async (writer) => {
                const stats = await call<{
                  size: number;
                  mtime: number;
                  isDirectory: () => boolean;
                }>((done) => reader.stat(source.path, done));
                if (stats.isDirectory()) throw new Error("A directory cannot be copied.");
                let last = 0;
                const progress = (done: number): void => {
                  if (Date.now() - last < 150) return;
                  last = Date.now();
                  send({ t: "progress", done });
                };
                await stash(writer, target.device, target.path, "replaced");
                const blocker = wantDirect
                  ? directBlocker(getDevice(source.device), getDevice(target.device))
                  : "not asked";
                if (blocker === null) {
                  send({ t: "start", total: stats.size, via: "direct" });
                  try {
                    await directCopy(source, target, stats.size, writer, progress, signal);
                    return { bytes: stats.size };
                  } catch (error) {
                    if (signal.aborted) throw error;
                    send({
                      t: "note",
                      text: `Direct copy failed (${message(error)}). Relaying instead.`,
                    });
                  }
                } else if (wantDirect) send({ t: "note", text: `Relayed: ${blocker}` });
                // A large copy goes to `<name>.part`, which a later copy continues.
                const resumable = stats.size > RESUMABLE_BYTES;
                const part = resumable ? `${target.path}.part` : target.path;
                const sizeOf = (path: string): Promise<number> =>
                  call<{ size: number }>((done) => writer.stat(path, done)).then(
                    (found) => found.size,
                    () => -1,
                  );
                // Continue only from a part that is not older than the source: an
                // older one was made from another version of the file.
                const left = resumable
                  ? await call<{ size: number; mtime: number }>((done) =>
                      writer.stat(part, done),
                    ).catch(() => null)
                  : null;
                const offset =
                  left && left.size <= stats.size && left.mtime >= stats.mtime ? left.size : 0;
                send({ t: "start", total: stats.size, via: "relay", resumed: offset });
                // The hash of what passes through, when the copy starts at the first byte.
                const passing = offset === 0 ? createHash("sha256") : null;
                const source$ = reader.createReadStream(
                  source.path,
                  offset ? { start: offset } : undefined,
                ) as AsyncIterable<Uint8Array>;
                const tap = async function* (): AsyncGenerator<Uint8Array> {
                  for await (const chunk of source$) {
                    passing?.update(chunk);
                    yield chunk;
                  }
                };
                await writeStream(writer, part, tap(), progress, signal, {
                  start: offset,
                  keep: resumable,
                });
                if (resumable) {
                  await call<void>((done) => writer.unlink(target.path, done)).catch(() => {});
                  await call<void>((done) => writer.rename(part, target.path, done));
                }
                const written = await sizeOf(target.path);
                if (written !== stats.size)
                  throw new Error(`The destination has ${written} of ${stats.size} bytes.`);
                let sha256 = passing?.digest("hex");
                if (body.verify === true) {
                  sha256 ??= await hashFile(reader, source.path);
                  if ((await hashFile(writer, target.path)) !== sha256)
                    throw new Error("Checksum mismatch: the copy is not the same as the source.");
                }
                return { bytes: stats.size, sha256, verified: body.verify === true };
              }),
            );
            audit(target.device, "WRITE", started, args, `${done.bytes} bytes`);
            send({ t: "end", ok: true, ...done });
          } catch (error) {
            audit(target.device, "WRITE", started, args, message(error), true);
            send({ t: "end", ok: false, error: message(error) });
          }
        });
      }

      if (key === "POST /api/files/vault/send") {
        // A vault file to a folder of a router.
        const name = safeName(String(body.name ?? ""));
        const file = join(backupDir(), name);
        if (!existsSync(file)) throw new DashboardInputError(404, "This file is not in the vault.");
        const device = deviceOf(body.device);
        const target = joinPath(cleanPath(body.dir ?? "/"), name);
        const started = Date.now();
        const bytes = await withSftp(device, async (sftp) => {
          await stash(sftp, device, target, "replaced");
          return writeStream(sftp, target, createReadStream(file));
        });
        audit(device, "WRITE", started, { fromVault: name, to: target }, `${bytes} bytes`);
        return json({ ok: true, path: target });
      }

      if (key === "POST /api/files/trash/restore") {
        const found = openTrash(String(body.id ?? ""));
        if (!found) throw new DashboardInputError(404, "This item is not in the recycle bin.");
        const { item, bytes } = found;
        const started = Date.now();
        await withSftp(deviceOf(item.device), (sftp) => writeStream(sftp, item.path, bytes));
        purgeTrash(item.id);
        audit(item.device, "WRITE", started, { restore: item.path }, `${item.size} bytes`);
        return json({ ok: true, device: item.device, path: item.path });
      }
      if (key === "POST /api/files/trash/purge")
        return json({ removed: purgeTrash(typeof body.id === "string" ? body.id : undefined) });

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
              await removeTree(sftp, target, (file) => stash(sftp, device, file, "deleted"));
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

      if (key === "POST /api/files/make") {
        // A backup or an export, written by the router into its own files.
        const kind = body.kind === "export" ? "export" : "backup";
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const name = typeof body.name === "string" && body.name ? body.name : `${kind}-${stamp}`;
        if (!/^[\w.-]{1,80}$/.test(name))
          throw new DashboardInputError(400, "Use letters, digits, '.', '-' and '_' in the name.");
        const command =
          kind === "backup"
            ? new Cmd("/system backup save").set("name", name).build()
            : new Cmd("/export").set("file", name).build();
        const output = await executeMikrotikCommand(command, createContext(undefined, device));
        const failed = looksLikeError(output);
        audit(device, "WRITE", started, { [kind]: name }, output || "created", failed);
        if (failed) throw new DashboardInputError(502, output.trim());
        return json({ ok: true, file: `${name}.${kind === "backup" ? "backup" : "rsc"}` });
      }

      if (key === "POST /api/files/import") {
        // RouterOS names a file without the leading '/'.
        const file = cleanPath(body.path).slice(1);
        if (!/\.rsc$/i.test(file))
          throw new DashboardInputError(400, "Only a .rsc file is imported.");
        const dryRun = body.dryRun !== false;
        // `dry-run` is a flag without a value; RouterOS refuses `dry-run=yes`.
        const command = new Cmd("/import")
          .set("file-name", file)
          .raw("verbose=yes")
          .raw(dryRun ? "dry-run" : undefined)
          .build();
        let output: string;
        let failed: boolean;
        try {
          output = await executeMikrotikCommand(command, createContext(undefined, device), {
            maxMs: 120_000,
          });
          // The dry run says "No syntax errors found"; a real run names a "Script Error".
          failed = dryRun
            ? !/no syntax errors found/i.test(output)
            : /script error/i.test(output) || looksLikeError(output);
        } catch (error) {
          // A script with an error ends the command with a failure: that is the answer.
          output = message(error);
          failed = true;
        }
        audit(
          device,
          dryRun ? "READ" : "DANGEROUS",
          started,
          { import: file, dryRun },
          output,
          failed,
        );
        return json({ ok: !failed, dryRun, output });
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
      return json({ error: clientError(error) }, 502);
    }
  };
}
