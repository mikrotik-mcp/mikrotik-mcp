/**
 * Recycle bin of the dashboard Files page.
 *
 * Before a file on a router is deleted or replaced from the page, its bytes are
 * copied to a folder on this host, so the action can be undone for a week. A
 * router has no recycle bin of its own.
 *
 * Each item is two files: `<id>.bin` (the bytes) and `<id>.json` (where it was).
 * Large files are not kept; the caller is told, and the page says so.
 */
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper } from "ssh2";

type Sftp = Pick<SFTPWrapper, "stat" | "createReadStream">;

export interface TrashItem {
  id: string;
  device: string;
  path: string;
  size: number;
  /** When it was put here, in milliseconds. */
  ts: number;
  reason: "deleted" | "replaced";
}

/** A larger file is not kept. */
export const MAX_TRASH_BYTES = 64 * 1024 * 1024;
export const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;
const ID = /^[\w-]+$/;

let trashDir: string | undefined;
/** Where the recycle bin is; `undefined` turns it off. */
export function setTrashDir(dir: string | undefined): void {
  trashDir = dir;
}
export const trashEnabled = (): boolean => trashDir !== undefined;

const remove = (dir: string, id: string): void => {
  rmSync(join(dir, `${id}.bin`), { force: true });
  rmSync(join(dir, `${id}.json`), { force: true });
};

/** Newest first. Items older than a week, and items over the count, are removed. */
export function listTrash(now = Date.now()): TrashItem[] {
  if (!trashDir) return [];
  const dir = trashDir;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const items: TrashItem[] = [];
  for (const name of names) {
    try {
      items.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as TrashItem);
    } catch {
      /* a half-written item: ignore it */
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  const keep = items.filter((item, index) => now - item.ts < TRASH_KEEP_MS && index < MAX_ITEMS);
  for (const item of items) if (!keep.includes(item)) remove(dir, item.id);
  return keep;
}

/**
 * Copy a router file into the recycle bin. False when the bin is off, the path
 * is not a file, or the file is too large — the caller goes on without it.
 */
export async function stash(
  sftp: Sftp,
  device: string,
  path: string,
  reason: TrashItem["reason"],
): Promise<boolean> {
  if (!trashDir) return false;
  const stats = await new Promise<{ size: number; isDirectory: () => boolean } | null>((resolve) =>
    sftp.stat(path, (err, found) => resolve(err ? null : found)),
  );
  if (!stats || stats.isDirectory() || stats.size > MAX_TRASH_BYTES) return false;
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(trashDir, { recursive: true });
    await pipeline(sftp.createReadStream(path), createWriteStream(join(trashDir, `${id}.bin`)));
    const item: TrashItem = { id, device, path, size: stats.size, ts: Date.now(), reason };
    writeFileSync(join(trashDir, `${id}.json`), JSON.stringify(item));
    return true;
  } catch {
    remove(trashDir, id);
    return false;
  }
}

/** The item and a stream of its bytes, or undefined when there is no such item. */
export function openTrash(
  id: string,
): { item: TrashItem; bytes: AsyncIterable<Uint8Array> } | undefined {
  if (!trashDir || !ID.test(id)) return undefined;
  const item = listTrash().find((candidate) => candidate.id === id);
  if (!item) return undefined;
  return { item, bytes: createReadStream(join(trashDir, `${id}.bin`)) };
}

/** Remove one item, or every item. Returns how many were removed. */
export function purgeTrash(id?: string): number {
  if (!trashDir) return 0;
  const items = listTrash().filter((item) => id === undefined || item.id === id);
  for (const item of items) remove(trashDir, item.id);
  return items.length;
}
