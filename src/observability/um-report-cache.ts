import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getConfig } from "../core/runtime";
import type { DeviceConfig } from "../config";
import type { UmSnapshot } from "./um-reports";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_AGE = 24 * 60 * 60_000;
const sourceSchema = z.object({
  available: z.boolean(),
  rows: z.array(z.record(z.string(), z.string())).max(100_000),
  collectionMs: z.number().nonnegative().optional(),
});
const snapshotSchema = z.object({
  device: z.string(),
  collectedAt: z.number().positive(),
  collectionMs: z.number().nonnegative(),
  clock: z.object({ zone: z.string(), offsetMs: z.number().nullable() }),
  sources: z.record(z.string(), sourceSchema),
});

/** Namespace by the actual target and jump chain, not just a reusable device name. */
export function umReportCachePath(device: string): string | undefined {
  const config = getConfig();
  if (!config.dashboard.enabled || config.dashboard.dbPath === ":memory:") return;
  const chain = [];
  const seen = new Set<string>();
  let name: string | undefined = device;
  while (name && !seen.has(name)) {
    seen.add(name);
    const target: DeviceConfig | undefined = config.devices[name];
    chain.push([name, target]);
    name = target?.jumpVia;
  }
  // Credentials participate in invalidation but never appear in the filename/payload.
  const key = createHash("sha256").update(JSON.stringify(chain)).digest("hex");
  return join(`${config.dashboard.dbPath}.um-reports`, `${key}.json`);
}

/** Corrupt, expired, mismatched or partial files are cache misses, never reports. */
export async function loadUmReportCache(
  path: string | undefined,
  device: string,
  fields: Record<string, readonly string[]>,
): Promise<UmSnapshot | undefined> {
  if (!path) return;
  try {
    if ((await stat(path)).size > MAX_BYTES) return;
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (raw.version !== 1) return;
    const snapshot = snapshotSchema.parse(raw.snapshot);
    const age = Date.now() - snapshot.collectedAt;
    if (snapshot.device !== device || age < 0 || age > MAX_AGE) return;
    const sources: Record<string, z.infer<typeof sourceSchema>> = {};
    for (const [key, keys] of Object.entries(fields)) {
      const source = snapshot.sources[key];
      if (!source) return;
      sources[key] = {
        ...source,
        rows: source.rows.map((row) =>
          Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]])),
        ),
      };
    }
    return { ...snapshot, sources } as UmSnapshot;
  } catch {
    // Unreadable/corrupt cache: collect a fresh report instead.
  }
}

/** Atomic private file: no browser storage, credentials or extra SQLite writer. */
export async function saveUmReportCache(
  path: string | undefined,
  snapshot: UmSnapshot,
): Promise<boolean> {
  if (!path || Object.values(snapshot.sources).some((source) => source.error)) return false;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const text = JSON.stringify({ version: 1, snapshot });
    if (Buffer.byteLength(text) > MAX_BYTES) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, path);
    return true;
  } catch {
    // A read-only disk must not discard a successfully collected in-memory report.
    return false;
  } finally {
    await unlink(temp).catch(() => {});
  }
}
