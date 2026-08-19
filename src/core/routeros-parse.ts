/**
 * Small, dependency-free parsers that turn RouterOS `print` text into structured
 * data for MCP App views. Kept separate from `routeros.ts` (which *builds*
 * commands) and pure so they're trivially unit-testable.
 */

/**
 * Parse the `key: value` output of a single-record `print` (e.g.
 * `/system resource print`, `/system identity print`) into an object.
 *
 * RouterOS pads keys with leading spaces and separates with `: `; values run to
 * end of line. Keys with hyphens are preserved (`cpu-load`, `free-memory`).
 * Lines without a `key:` shape (blanks, flag legends) are skipped.
 *
 * @example
 *   parseKeyValues("  uptime: 1w2d\n  cpu-load: 5%")
 *   // => { uptime: "1w2d", "cpu-load": "5%" }
 */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on `\r?\n`: RouterOS emits CRLF over the SSH exec channel, and a
  // trailing `\r` would otherwise defeat the `(.*)$` anchor below (a non-
  // multiline `$` won't match before a `\r`), yielding zero parsed keys.
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][\w-]*):\s?(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    // First occurrence wins; later duplicate keys (rare) are ignored.
    if (!(key in out)) out[key] = value.trim();
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse a RouterOS date/time string to epoch ms, or `null` if unrecognized.
 * Handles the v7 ISO-ish form (`2026-06-01 12:00:00`) and the v6 form
 * (`jun/01/2026 12:00:00`); the time part is optional. Treated as UTC — fine for
 * day-granularity work like certificate expiry.
 */
export function parseRouterosDate(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = t.match(/^([A-Za-z]{3})\/(\d{1,2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon == null) return null;
    return Date.UTC(+m[3], mon, +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  return null;
}

/** One certificate's expiry status, derived from `/certificate print detail`. */
export interface CertExpiry {
  name: string;
  /** Raw `invalid-after` value as printed by the device. */
  invalidAfter?: string;
  /** Whole days until expiry (negative = already expired), or null if unparseable. */
  daysLeft: number | null;
}

/**
 * Extract per-certificate expiry from `/certificate print detail` output.
 *
 * Records are split on their leading index line; for each, the `name` and
 * `invalid-after` are pulled out and `invalid-after` (which contains a space and
 * so can't be tokenized as a plain `key=value`) is parsed to a day count from
 * `nowMs`. Certificates without an `invalid-after` (e.g. unsigned templates)
 * yield `daysLeft: null`.
 */
export function parseCertExpiry(detail: string, nowMs: number): CertExpiry[] {
  const out: CertExpiry[] = [];
  for (const chunk of detail.split(/\n(?=\s*\d+\s)/)) {
    const nameM = chunk.match(/name="([^"]*)"/);
    if (!nameM) continue;
    const iaM = chunk.match(
      /invalid-after=("?)(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|[A-Za-z]{3}\/\d{1,2}\/\d{4}[ T]\d{2}:\d{2}:\d{2})\1/,
    );
    const expiresMs = iaM ? parseRouterosDate(iaM[2]) : null;
    out.push({
      name: nameM[1],
      invalidAfter: iaM?.[2],
      daysLeft: expiresMs == null ? null : Math.floor((expiresMs - nowMs) / 86_400_000),
    });
  }
  return out;
}

/** Parse a RouterOS size string (`256.0MiB`, `1.2 GiB`, `12345`, `1280KiB`) to bytes. */
export function parseSize(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^([\d.]+)\s*([KMGT]i?B|B)?$/i);
  if (!m) return undefined;
  const val = Number.parseFloat(m[1] as string);
  if (!Number.isFinite(val)) return undefined;
  const mult: Record<string, number> = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
  };
  return val * (mult[(m[2] ?? "B").toUpperCase()] ?? 1);
}

/** Parse a RouterOS percentage string (`5%`, `0`, `12 %`) to a number 0–100. */
export function parsePercent(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^([\d.]+)\s*%?$/);
  if (!m) return undefined;
  const v = Number.parseFloat(m[1] as string);
  return Number.isFinite(v) ? v : undefined;
}

/** Used percentage (0–100) from a total and a free amount; undefined if unknown. */
export function usedPct(total?: number, free?: number): number | undefined {
  if (total == null || free == null || total <= 0) return undefined;
  return Math.max(0, Math.min(100, ((total - free) / total) * 100));
}

/** Structured system metrics extracted from `/system resource print`. */
export interface SystemResource {
  version?: string;
  boardName?: string;
  architecture?: string;
  cpuCount?: number;
  /** Current CPU load, percent 0–100. */
  cpuLoad?: number;
  /** Free / total RAM, bytes. */
  freeMemory?: number;
  totalMemory?: number;
  /** Used RAM, percent 0–100. */
  memUsedPct?: number;
  /** Free / total disk, bytes. */
  freeHdd?: number;
  totalHdd?: number;
  /** Used disk, percent 0–100. */
  hddUsedPct?: number;
  uptime?: string;
}

/**
 * Parse `/system resource print` into structured, typed metrics.
 *
 * Robust to the real-world variations of that output across RouterOS v6/v7 and
 * transports (SSH exec vs the MAC-Telnet console): leading key alignment, one or
 * many spaces after the colon, sizes in MiB/GiB/KiB or bare bytes, and a
 * `cpu-load` reported with or without a `%`. Any field that is absent or
 * unparseable is simply left `undefined` — the caller decides how to render a
 * partial reading.
 *
 * Returns `null` when the text yields NO recognizable metric at all (e.g. an
 * empty response or an error string), so the caller can distinguish "device
 * reported nothing usable" from "device reported some zeros".
 */
export function parseSystemResource(text: string): SystemResource | null {
  const r = parseKeyValues(text);
  const totalMemory = parseSize(r["total-memory"]);
  const freeMemory = parseSize(r["free-memory"]);
  const totalHdd = parseSize(r["total-hdd-space"]);
  const freeHdd = parseSize(r["free-hdd-space"]);
  const cpuLoad = parsePercent(r["cpu-load"]);
  const cpuCount = Number.parseInt(r["cpu-count"] ?? "", 10);
  const out: SystemResource = {
    version: r.version || undefined,
    boardName: r["board-name"] || undefined,
    architecture: r["architecture-name"] || undefined,
    cpuCount: Number.isFinite(cpuCount) ? cpuCount : undefined,
    cpuLoad,
    freeMemory,
    totalMemory,
    memUsedPct: usedPct(totalMemory, freeMemory),
    freeHdd,
    totalHdd,
    hddUsedPct: usedPct(totalHdd, freeHdd),
    uptime: r.uptime || undefined,
  };
  // If not a single recognizable metric came through, the input wasn't a usable
  // resource dump — signal that rather than returning an all-undefined object.
  const gotMetric =
    out.cpuLoad != null ||
    out.totalMemory != null ||
    out.totalHdd != null ||
    out.version != null ||
    out.uptime != null;
  return gotMetric ? out : null;
}

/**
 * Parse a RouterOS `Flags:` legend line into a `{ letter: meaning }` map.
 *
 * Both `print` and `print detail` prepend a legend such as
 * `Flags: X - disabled, R - running, D - dynamic`. The records view uses it to
 * expand the terse flag letters carried on each row into readable chips.
 *
 * @example
 *   parseFlagLegend("Flags: X - disabled, R - running")
 *   // => { X: "disabled", R: "running" }
 */
export function parseFlagLegend(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const line = text.split("\n").find((l) => /^\s*Flags:/.test(l));
  if (!line) return out;
  const body = line.replace(/^\s*Flags:\s*/, "");
  // v6 separates legend entries with `,`; v7 mixes `;` and `,`
  // (e.g. `D - DYNAMIC; X - DISABLED, R - RUNNING`).
  for (const part of body.split(/[;,]/)) {
    const m = part.match(/^\s*([A-Za-z])\s*-\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Tokenise `key=value` / `key="quoted value"` pairs from one chunk of text. */
function parseKvTokens(chunk: string): Record<string, string> {
  const out: Record<string, string> = {};
  // A leading dot is allowed: RouterOS `print detail` abbreviates a repeated
  // dotted prefix, emitting the group head in full (`channel.frequency=5745`)
  // then continuation keys as bare `.suffix=value` (`.band=5ghz-ax`,
  // `.width=20mhz`) that inherit the last head's prefix. Re-expand those to the
  // full `channel.band` / `channel.width` instead of dropping them.
  const re = /(\.?[A-Za-z][\w.-]*)=("(?:[^"\\]|\\.)*"|[^\s]*)/g;
  let prefix = "";
  for (const m of chunk.matchAll(re)) {
    let key = m[1];
    if (key.startsWith(".")) {
      key = prefix + key; // `.band` under `channel.frequency` → `channel.band`
    } else {
      const dot = key.indexOf(".");
      prefix = dot > 0 ? key.slice(0, dot) : "";
    }
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** A parsed multi-record `print` result, ready for the records view. */
export interface ParsedRecords {
  /** Which on-wire shape we recognised. */
  format: "detail" | "columnar" | "keyvalue" | "empty";
  /** Ordered union of column keys across every row. */
  columns: string[];
  /** One object per record; values are always strings. */
  rows: Record<string, string>[];
}

/** A record-starting line: leading index, then the rest (flags + key=value run). */
const INDEX_LINE = /^\s*(\d+)\s+(.*)$/;
/**
 * Leading flag letters on a record line. RouterOS v6 flags are uppercase only
 * (R, X, D); v7 mixes upper and lower case — routes use `As` (active+static),
 * `DAd` (dynamic+active+dynamic-route), etc. The flag token is a contiguous run
 * of ASCII letters that must start with an uppercase letter (so we don't eat a
 * lowercase `key=value` name) and be followed by whitespace or end-of-string.
 */
const LEADING_FLAGS = /^([A-Z][A-Za-z]*)(?=\s|$)/;

/** Build the ordered union of keys seen across rows (first-seen order). */
function unionColumns(rows: Record<string, string>[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/**
 * Parse `print detail` output: records keyed by a leading index, each a run of
 * `key=value` pairs that may wrap across indented continuation lines.
 */
function parseDetailRecords(lines: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let current: { index: string; flags: string; comment: string; chunk: string } | null = null;
  const flush = (): void => {
    if (!current) return;
    const row: Record<string, string> = { "#": current.index };
    if (current.flags.trim()) row.flags = current.flags.trim();
    if (current.comment.trim()) row.comment = current.comment.trim();
    Object.assign(row, parseKvTokens(current.chunk));
    rows.push(row);
    current = null;
  };
  for (const line of lines) {
    const m = line.match(INDEX_LINE);
    if (m) {
      flush();
      let rest = m[2];
      let flags = "";
      const fm = rest.match(LEADING_FLAGS);
      if (fm) {
        flags = fm[1];
        rest = rest.slice(fm[0].length).replace(/^\s+/, "");
      }
      // Pull a RouterOS `;;; comment` (runs to end of this line) out of the
      // key=value stream so it doesn't corrupt tokenising.
      let comment = "";
      const cm = rest.match(/;;;\s*(.*)$/);
      if (cm) {
        comment = cm[1];
        rest = rest.slice(0, cm.index).replace(/\s+$/, "");
      }
      current = { index: m[1], flags, comment, chunk: rest };
    } else if (current) {
      const cm = line.match(/;;;\s*(.*)$/);
      if (cm) {
        current.comment = `${current.comment} ${cm[1]}`.trim();
        current.chunk += ` ${line.slice(0, cm.index)}`;
      } else {
        current.chunk += ` ${line}`;
      }
    }
  }
  flush();
  return rows;
}

/**
 * Keep only the `print detail` records whose parsed fields satisfy `predicate`,
 * returning the ORIGINAL text of the surviving records (preamble/flag legend
 * intact) rather than a re-rendered table.
 *
 * This exists so a tool can filter on something RouterOS's `print where` cannot
 * express. The device-side `where` accepts only space-separated conjunctive
 * terms — it has no `or` and no parentheses, so a clause like
 * `(in-interface~"x" or out-interface~"x")` is not a narrower query, it is a
 * query that silently matches nothing. Filtering here keeps such a search
 * honest at the cost of transferring the full list first.
 *
 * Returns "" when nothing matches, so `isEmpty()` handles it like any other
 * empty device reply.
 */
export function filterDetailBlocks(
  text: string,
  predicate: (row: Record<string, string>) => boolean,
): string {
  const lines = text.split(/\r?\n/);
  // Everything before the first indexed record — the flag legend and column
  // headers — is context that belongs on any non-empty result.
  const firstRecord = lines.findIndex((l) => INDEX_LINE.test(l));
  if (firstRecord === -1) return text;

  const preamble = lines.slice(0, firstRecord);
  const blocks: string[][] = [];
  for (const line of lines.slice(firstRecord)) {
    if (INDEX_LINE.test(line) || blocks.length === 0) blocks.push([]);
    blocks[blocks.length - 1].push(line);
  }

  const kept = blocks.filter((block) => {
    const [row] = parseDetailRecords(block);
    return row ? predicate(row) : false;
  });
  if (kept.length === 0) return "";
  return [...preamble, ...kept.flat()].join("\n");
}

/**
 * Parse columnar `print` output by slicing each data row at the header's column
 * start positions (robust to values that contain spaces, unlike a naive split).
 * The leading `#` column also absorbs any flag letters, which we split back out.
 */
function parseColumnarRecords(lines: string[]): Record<string, string>[] {
  const headerIdx = lines.findIndex(
    (l) => /\S/.test(l) && !l.includes("=") && /^[\s#]*[#A-Z]/.test(l) && /[A-Z]/.test(l),
  );
  if (headerIdx === -1) return [];
  const header = lines[headerIdx];
  // Column start = each token's first character position.
  const starts: { key: string; at: number }[] = [];
  for (const tok of header.matchAll(/\S+/g)) {
    starts.push({ key: tok[0].toLowerCase(), at: tok.index });
  }
  if (starts.length < 2) return [];

  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!/\S/.test(line)) continue;
    const row: Record<string, string> = {};
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i].at;
      const to = i + 1 < starts.length ? starts[i + 1].at : line.length;
      const cell = line.slice(from, to).trim();
      const key = starts[i].key;
      // The `#` column carries `<index> <flags>` (e.g. "0 XR") — split them.
      if (key === "#") {
        const m = cell.match(/^(\d+)\s*([A-Za-z]*)$/);
        if (m) {
          row["#"] = m[1];
          if (m[2]) row.flags = m[2];
          continue;
        }
      }
      row[key] = cell;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

/**
 * Turn raw multi-record `print`/`print detail` text into structured rows for an
 * MCP App view. Tries the reliable `key=value` detail shape first, then columnar
 * position slicing, then a single `key: value` record — always degrading to an
 * empty result (never throwing) so the caller can fall back to the raw text.
 */
export function parseRecords(text: string): ParsedRecords {
  // Drop the `Flags:` legend and the v7 `Columns:` hint line — the latter is
  // uppercase and `=`-free, so the columnar header finder would otherwise
  // mistake it for the real header and slice every row at the wrong offsets.
  // Split on `\r?\n` so CRLF output (RouterOS over the SSH exec channel) leaves
  // no trailing `\r` — a `\r` would defeat the `(.*)$` anchor in INDEX_LINE and
  // hide every detail row.
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*(Flags|Columns):/.test(l));
  const hasKv = /[A-Za-z][\w.-]*=/.test(text);

  if (hasKv && lines.some((l) => INDEX_LINE.test(l))) {
    const rows = parseDetailRecords(lines);
    // Only trust the detail shape if rows actually carried key=value data (not
    // just an index/flags) — otherwise this was columnar text with a stray `=`.
    const hasData = rows.some((r) => Object.keys(r).some((k) => k !== "#" && k !== "flags"));
    if (rows.length && hasData) return { format: "detail", columns: unionColumns(rows), rows };
  }

  const columnar = parseColumnarRecords(lines);
  if (columnar.length) {
    return { format: "columnar", columns: unionColumns(columnar), rows: columnar };
  }

  if (hasKv) {
    // A single `print detail` record with no leading index line.
    const single = parseKvTokens(text);
    if (Object.keys(single).length) {
      return { format: "detail", columns: Object.keys(single), rows: [single] };
    }
  }

  const kv = parseKeyValues(text);
  if (Object.keys(kv).length) {
    return { format: "keyvalue", columns: Object.keys(kv), rows: [kv] };
  }

  return { format: "empty", columns: [], rows: [] };
}

/** The `structuredContent` payload the generic `records` MCP App view renders. */
export interface RecordsView {
  /** Discriminator so the view recognises a generic-records payload. */
  __mikrotikView: "records";
  /** Originating tool name (used by the view's refresh button). */
  tool: string;
  /** Human-readable tool title. */
  title: string;
  /** `list` = a table of rows; `record` = a single detail object. */
  kind: "list" | "record";
  /** The recognised wire format (`detail`/`columnar`/`keyvalue`/`empty`). */
  format: ParsedRecords["format"];
  /** Ordered column keys. */
  columns: string[];
  /** Parsed rows (possibly empty — then the view shows `raw`). */
  rows: Record<string, string>[];
  /** Flag-letter legend, e.g. `{ X: "disabled" }`. */
  flags: Record<string, string>;
  /** Number of rows. */
  count: number;
  /** Original text (label prefix stripped) — the view's always-available fallback. */
  raw: string;
  /** ISO timestamp stamped by the caller at render time. */
  generatedAt: string;
}

/** Strip a leading `LABEL:` / `LABEL DETAILS:` banner some handlers prepend. */
function stripBanner(text: string): string {
  return text.replace(/^[A-Z][A-Z0-9 _'/().-]*:\s*\n+/, "");
}

/**
 * Build the {@link RecordsView} payload for the generic view from a read tool's
 * text output. Pure and total: any text yields a valid payload (rows may be
 * empty, in which case the view renders `raw`).
 */
export function buildRecordsView(
  tool: string,
  title: string,
  text: string,
  generatedAt: string,
): RecordsView {
  const body = stripBanner(text);
  const parsed = parseRecords(body);
  return {
    __mikrotikView: "records",
    tool,
    title,
    kind: parsed.rows.length === 1 && parsed.format !== "columnar" ? "record" : "list",
    format: parsed.format,
    columns: parsed.columns,
    rows: parsed.rows,
    flags: parseFlagLegend(text),
    count: parsed.rows.length,
    raw: body.trimEnd(),
    generatedAt,
  };
}

/** Strip a trailing unit and return the leading number, or null if none. */
export function parseLeadingNumber(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * Convert a RouterOS size like `124.0MiB`, `2048KiB`, `1.5GiB` (or a plain byte
 * count) to bytes, or null if unparseable. Used to compute memory/disk usage
 * percentages for gauges.
 */
export function parseSizeToBytes(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*([KMGT]i?B|B)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  const factor: Record<string, number> = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
  };
  return n * (factor[unit] ?? 1);
}

/** One external/attached disk from `/disk print detail`. */
export interface RouterDisk {
  /** Slot name, e.g. `usb1` — the stable identifier. */
  slot: string;
  model?: string;
  /** Filesystem (`ext4`, `fat32`, …). */
  fs?: string;
  /** Capacity in bytes. */
  size?: number;
  /** Free space in bytes. */
  free?: number;
  mountPoint?: string;
  /** Used percent 0–100. */
  usedPct?: number;
}

/**
 * Parse `/disk print detail` into the mounted, non-empty disks. RouterOS groups
 * large numbers with spaces (`size=124 948 316 160`), which would otherwise cut
 * the token at the first space — so digit-grouping spaces are collapsed before
 * tokenising. Empty slots (flag `E`) and sizeless rows are dropped. Pure.
 */
export function parseDisks(text: string): RouterDisk[] {
  const collapsed = text.replace(/(\d) (?=\d)/g, "$1");
  const { rows } = parseRecords(collapsed);
  const disks: RouterDisk[] = [];
  for (const r of rows) {
    const slot = r.slot ?? r.name ?? "";
    if (!slot) continue;
    if (/E/.test(r.flags ?? "")) continue; // empty slot — nothing attached
    const size = parseLeadingNumber(r.size);
    if (size == null || size <= 0) continue;
    const free = parseLeadingNumber(r.free);
    const usePct = parseLeadingNumber(r.use);
    disks.push({
      slot,
      model: r.model,
      fs: r.fs,
      size,
      free: free ?? undefined,
      mountPoint: r["mount-point"],
      usedPct:
        usePct ?? (free != null && size > 0 ? Math.round(((size - free) / size) * 100) : undefined),
    });
  }
  return disks;
}
