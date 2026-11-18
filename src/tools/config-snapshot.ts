/**
 * Configuration snapshots & time-travel diff — capture point-in-time RouterOS
 * `/export` dumps, store them locally, and diff any two (or one against the
 * live device) to see exactly what changed.
 *
 * Unlike `/export` to a file on the device (see `backup.ts`), snapshots are
 * captured to the MCP host's own SQLite database (`~/.mikrotik-mcp/snapshots.db`)
 * so they survive device reboots/resets and accumulate a configuration history
 * the model can reason over: "what changed on this router since last Tuesday?".
 *
 * The device is only ever *read* (`/export`); all mutation is local persistence.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { diffLines } from "../core/diff";
import { READ, WRITE, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { isEmpty, looksLikeError, Cmd, menuPath } from "../core/routeros";
import { resolveDeviceName } from "../core/runtime";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { contentSha, countLines, normalizeExport, parseExportMeta } from "../snapshots/format";
import { openSnapshotStore } from "../snapshots/store";
import type { Snapshot, SnapshotStore } from "../snapshots/store";
import type { ToolContext } from "../core/context";

// A single lazily-opened store, reused across calls for the life of the server
// process (the stdio server is long-lived). The `bun:sqlite` dependency only
// loads when the first snapshot tool actually runs.
let storePromise: Promise<SnapshotStore> | null = null;
function snapshots(): Promise<SnapshotStore> {
  if (!storePromise) storePromise = openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

/** Build the `/export` command used for both capture and live diff. */
function exportCommand(opts: { section?: string; terse: boolean; showSensitive: boolean }): string {
  const base = opts.section ? `/${menuPath(opts.section)} export` : "/export";
  // RouterOS `/export` flags are BARE words ("terse", "show-sensitive") — NOT
  // key=value. `/export terse=yes` is a parser error ("expected end of command"),
  // so emit raw fragments rather than Cmd.flag() (which appends `=yes`).
  return new Cmd(base)
    .raw(opts.terse ? "terse" : undefined)
    .raw(opts.showSensitive ? "show-sensitive" : undefined)
    .build();
}

/** Run `/export` on the device and return its body, or throw on a device error. */
async function liveExport(
  ctx: ToolContext,
  opts: { section?: string; terse: boolean; showSensitive: boolean },
): Promise<string> {
  const body = await executeMikrotikCommand(exportCommand(opts), ctx);
  if (isEmpty(body) || looksLikeError(body)) {
    throw new Error(`device returned no usable export: ${body.trim() || "(empty)"}`);
  }
  return body;
}

const RELATIVE_HINT = "`<id>`, `latest` (newest stored), or `live` (capture the device now)";

/** Resolve a snapshot reference to `{ label, body }` for diffing. */
async function resolveRef(
  store: SnapshotStore,
  ref: string,
  device: string,
  ctx: ToolContext,
): Promise<{ label: string; body: string }> {
  if (ref === "live") {
    return {
      label: `${device}@live`,
      body: await liveExport(ctx, { terse: true, showSensitive: false }),
    };
  }
  const snap = ref === "latest" ? store.latest(device) : store.get(ref);
  if (!snap) {
    throw new Error(
      ref === "latest"
        ? `no snapshots stored for device '${device}' yet — capture one first`
        : `snapshot '${ref}' not found`,
    );
  }
  const when = new Date(snap.ts).toISOString();
  return { label: `${snap.id} (${when})`, body: snap.body };
}

function describe(s: Snapshot): string {
  const when = new Date(s.ts).toISOString();
  const label = s.label ? ` "${s.label}"` : "";
  const ver = s.rosVersion ? ` ros=${s.rosVersion}` : "";
  return `${s.id}${label}  ${when}  ${s.lines} lines, ${s.bytes} bytes${ver}  sha=${s.sha}`;
}

export const configSnapshotTools: ToolModule = [
  defineTool({
    name: "capture_config_snapshot",
    title: "Capture RouterOS Configuration Snapshot",
    annotations: WRITE,
    description:
      "Runs `/export` (or `/<section> export` when `section` is set) on the device and persists " +
      "the output as a timestamped snapshot in the local MCP-host SQLite database " +
      "(`~/.mikrotik-mcp/snapshots.db`) — not on the device filesystem. Use this to build a " +
      "configuration history that survives device reboots and can be diffed later to answer " +
      "'what changed since X?'. If the content SHA matches the previous snapshot and " +
      "force=false (default), nothing is written and a 'no change' message is returned; set " +
      "force=true to store unconditionally. Limit to one RouterOS section via `section` " +
      '(e.g. "ip firewall filter"); sensitive values (passwords, keys) are redacted unless ' +
      "show_sensitive=true. To compare snapshots use diff_config_snapshots; to read a stored " +
      "body use get_config_snapshot; to browse stored entries use list_config_snapshots. " +
      "Returns the new snapshot id and metadata, or a 'no change' message.",
    inputSchema: {
      label: z.string().optional().describe("Human label, e.g. 'pre-firewall-change'."),
      section: z
        .string()
        .optional()
        .describe(
          'RouterOS path without leading slash, e.g. "ip firewall filter". Omit for full config.',
        ),
      terse: z
        .boolean()
        .default(true)
        .describe("Use `/export terse` (one self-contained line per item) for cleaner diffs."),
      show_sensitive: z.boolean().default(false),
      force: z.boolean().default(false),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Capturing config snapshot for ${device}${a.section ? ` (${a.section})` : ""}`);

      const body = await liveExport(ctx, {
        section: a.section,
        terse: a.terse,
        showSensitive: a.show_sensitive,
      });

      const meta = parseExportMeta(body);
      const sha = contentSha(normalizeExport(body));
      const store = await snapshots();

      const prev = store.latest(device);
      if (prev && prev.sha === sha && !a.force) {
        return (
          `No configuration change since the last snapshot — nothing stored.\n` +
          `Latest: ${describe(prev)}\n` +
          `(pass force=true to snapshot anyway.)`
        );
      }

      const ts = Date.now();
      const snap: Snapshot = {
        id: `snap_${ts}_${sha.slice(0, 8)}`,
        device,
        ts,
        label: a.label,
        rosVersion: meta.rosVersion,
        body,
        bytes: Buffer.byteLength(body, "utf8"),
        lines: countLines(body),
        sha,
      };
      store.insert(snap);

      const drift = prev
        ? `Changed since ${prev.id} (previous sha=${prev.sha}).`
        : `First snapshot for this device.`;
      return `Snapshot captured:\n${describe(snap)}\n${drift}`;
    },
  }),

  defineTool({
    name: "list_config_snapshots",
    title: "List RouterOS Configuration Snapshots",
    annotations: READ,
    description:
      "Lists metadata for stored configuration snapshots for the current device from the local " +
      "MCP-host SQLite database (`~/.mikrotik-mcp/snapshots.db`), newest first. Returns each " +
      "snapshot's id, optional label, capture timestamp, line/byte count, RouterOS version (when available), and " +
      "content SHA — the `/export` body text is not included. Use the returned id with " +
      "get_config_snapshot to read the full body, or pass it to diff_config_snapshots as `from` " +
      "or `to`. To capture a new snapshot use capture_config_snapshot; to delete entries use " +
      "remove_config_snapshot.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(50),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      const store = await snapshots();
      const rows = store.list(device, a.limit, false);
      if (rows.length === 0) {
        return `No configuration snapshots stored for '${device}'. Capture one with capture_config_snapshot.`;
      }
      const total = store.count(device);
      const lines = rows.map((s) => describe(s)).join("\n");
      return `CONFIG SNAPSHOTS for ${device} (showing ${rows.length} of ${total}):\n\n${lines}`;
    },
  }),

  defineTool({
    name: "get_config_snapshot",
    title: "Get RouterOS Configuration Snapshot Body",
    annotations: READ,
    description:
      "Retrieves a stored configuration snapshot by id from the local MCP-host SQLite database. " +
      "With include_body=true (default) returns the full `/export` text — a RouterOS `.rsc` script " +
      "suitable for review or manual re-application on the device. Set include_body=false to return " +
      "metadata only (id, timestamp, size, SHA). The id comes from list_config_snapshots. " +
      "To compare two snapshots or a snapshot against the live device use diff_config_snapshots; " +
      "to delete a snapshot use remove_config_snapshot.",
    inputSchema: {
      id: z.string(),
      include_body: z.boolean().default(true),
    },
    async handler(a, ctx) {
      const store = await snapshots();
      const snap = store.get(a.id);
      if (!snap) return `Snapshot '${a.id}' not found.`;
      if (!a.include_body) return `SNAPSHOT METADATA:\n${describe(snap)}`;
      return `SNAPSHOT ${snap.id}\n${describe(snap)}\n\n--- begin export ---\n${snap.body}\n--- end export ---`;
    },
  }),

  defineTool({
    name: "diff_config_snapshots",
    title: "Diff RouterOS Configuration Snapshots",
    annotations: READ,
    description:
      "Compares two RouterOS `/export` configurations and returns a unified diff (lines added/" +
      `removed) plus a +added/-removed/unchanged summary. Each of \`from\`/\`to\` may be ${RELATIVE_HINT}. ` +
      "Typical uses: drift check (from=latest, to=live) to see what changed since the last " +
      "stored snapshot; or compare two stored snapshots by id. Volatile `/export` header " +
      "timestamps are normalized out so unchanged configs diff clean. " +
      "To capture a new snapshot first use capture_config_snapshot; to list snapshot ids use " +
      "list_config_snapshots; to read a full snapshot body use get_config_snapshot. " +
      "Returns the unified diff text truncated at max_output_lines (raise it if needed).",
    inputSchema: {
      from: z.string().describe(`Baseline side: ${RELATIVE_HINT}.`),
      to: z
        .string()
        .default("live")
        .describe(`Comparison side: ${RELATIVE_HINT}. Defaults to live.`),
      context_lines: z.number().int().min(0).max(20).default(3),
      max_output_lines: z
        .number()
        .int()
        .min(50)
        .max(5000)
        .default(800)
        .describe("Truncate the unified diff beyond this many lines."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      const store = await snapshots();
      const from = await resolveRef(store, a.from, device, ctx);
      const to = await resolveRef(store, a.to, device, ctx);

      const result = diffLines(normalizeExport(from.body), normalizeExport(to.body), {
        contextLines: a.context_lines,
        fromLabel: from.label,
        toLabel: to.label,
      });

      const { added, removed, unchanged, changed } = result.summary;
      const header =
        `CONFIG DIFF  ${from.label}  →  ${to.label}\n` +
        `+${added} added, -${removed} removed, ${unchanged} unchanged`;

      if (!changed) return `${header}\n\nNo differences — configurations are identical.`;

      const diffLinesArr = result.unified.split("\n");
      if (diffLinesArr.length > a.max_output_lines) {
        const shown = diffLinesArr.slice(0, a.max_output_lines).join("\n");
        return `${header}\n\n${shown}\n\n… diff truncated at ${a.max_output_lines} lines (${diffLinesArr.length} total). Raise max_output_lines to see the rest.`;
      }
      return `${header}\n\n${result.unified}`;
    },
  }),

  defineTool({
    name: "remove_config_snapshot",
    title: "Remove RouterOS Configuration Snapshots",
    annotations: DESTRUCTIVE,
    description:
      "Deletes one or more stored configuration snapshots by id from the local MCP-host SQLite " +
      "database (`~/.mikrotik-mcp/snapshots.db`) — never touches the device. Accepts a list of " +
      "one or more ids (obtain ids from list_config_snapshots). Returns the count of entries " +
      "actually removed. To capture snapshots use capture_config_snapshot.",
    inputSchema: {
      ids: z.array(z.string()).min(1),
    },
    async handler(a) {
      const store = await snapshots();
      const removed = store.delete(a.ids);
      if (removed === 0) return `No snapshots removed (none of the given ids matched).`;
      return `Removed ${removed} snapshot${removed === 1 ? "" : "s"}.`;
    },
  }),
];
