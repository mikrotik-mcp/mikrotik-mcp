/**
 * Shared pre-change snapshot capture.
 *
 * The canonical rollback point for any write tool: run `/export terse` on the
 * device and persist it to the same local SQLite store `capture_config_snapshot`
 * uses, returning the new snapshot id so a caller can `diff_config_snapshots`
 * against `live` or roll back. Kept in one place so every write tool (security
 * hardening, port-scan detection, …) snapshots identically.
 */
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { resolveDeviceName } from "../core/runtime";
import { looksLikeError } from "../core/routeros";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { contentSha, countLines, normalizeExport, parseExportMeta } from "./format";
import { openSnapshotStore } from "./store";
import type { Snapshot, SnapshotStore } from "./store";

// One lazily-opened store reused for the life of the (long-lived stdio) process.
let storePromise: Promise<SnapshotStore> | null = null;
function snapshots(): Promise<SnapshotStore> {
  if (!storePromise) storePromise = openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

/**
 * Capture a pre-change configuration snapshot and return its id. Reads the
 * device only (`/export terse`); all mutation is local persistence.
 */
export async function captureSnapshot(
  ctx: ToolContext,
  label: string,
  requireExport = false,
): Promise<string> {
  const device = resolveDeviceName(ctx.device);
  const body = await executeMikrotikCommand("/export terse", ctx);
  if (
    requireExport &&
    (looksLikeError(body) || !/^\/[a-z]/m.test(body) || /#\s*error exporting/i.test(body))
  )
    throw new Error(
      "A complete pre-change configuration export could not be captured; no policy was applied.",
    );
  const meta = parseExportMeta(body);
  const sha = contentSha(normalizeExport(body));
  const ts = Date.now();
  const snap: Snapshot = {
    id: `snap_${ts}_${sha.slice(0, 8)}`,
    device,
    ts,
    label,
    rosVersion: meta.rosVersion,
    body,
    bytes: Buffer.byteLength(body, "utf8"),
    lines: countLines(body),
    sha,
  };
  (await snapshots()).insert(snap);
  return snap.id;
}
