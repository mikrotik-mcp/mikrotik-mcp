/**
 * `/export` → a queryable, sectioned record model. PURE, no I/O.
 *
 * The snapshot subsystem normalises export TEXT (`src/snapshots/format.ts`) but
 * never gives you anything to ask questions of. This does: every `add`/`set`
 * line becomes a record of `key → value` under its menu path, with the source
 * line number kept so a finding can point at the exact line a human has to fix.
 *
 * The RouterOS export format is small but has four traps, all handled here:
 *
 * 1. **Line continuations.** Long lines wrap with a trailing `\`, and the
 *    continuation is indented. Joining them wrongly splits one rule into two
 *    half-rules that then pass every check.
 * 2. **Quoted values.** `comment="allow ssh from office"` contains spaces, and
 *    `comment="a=b"` contains an `=`. Splitting on whitespace or on the first
 *    `=` per token corrupts both.
 * 3. **Bare flags.** `/ip route add dst-address=0.0.0.0/0 blackhole` — a token
 *    with no `=` is a flag, and it has to be visible to a rule (`present: true`)
 *    rather than silently dropped.
 * 4. **Repeated sections.** An export can open the same menu twice
 *    (`/ip firewall filter` … `/ip firewall nat` … `/ip firewall filter`). The
 *    records belong to ONE logical section, or half of them are invisible to
 *    every rule.
 *
 * Escape handling inside quotes follows the console: `\"` is a literal quote and
 * `\\` a literal backslash.
 */

/** One `add`/`set` line, parsed. */
export interface ConfigRecord {
  /** Menu path this record lives under, e.g. `/ip/firewall/filter`. */
  section: string;
  /** The verb: `add`, `set`, `remove`, … (whatever the export used). */
  op: string;
  /** Parsed `key=value` pairs. A bare flag maps to `"yes"`. */
  fields: Record<string, string>;
  /** Bare flag tokens, in order (also present in `fields` as `"yes"`). */
  flags: string[];
  /** 1-based line number of the record's FIRST line in the source export. */
  line: number;
  /** The logical (continuation-joined) source line, for showing a human. */
  raw: string;
}

export interface ConfigSection {
  /** Normalised path with `/` separators, e.g. `/ip/firewall/filter`. */
  path: string;
  records: ConfigRecord[];
  /** Line numbers where this menu was opened (more than one if repeated). */
  lines: number[];
}

export interface ConfigModel {
  sections: ConfigSection[];
  /** Section path → section, for direct lookup. */
  byPath: Map<string, ConfigSection>;
  /** Total records across every section. */
  recordCount: number;
  /** Lines that could not be interpreted, with their line numbers. */
  unparsed: { line: number; text: string }[];
}

/**
 * Normalise a menu path to the slash form rules are written against:
 * `/ip firewall filter` and `/ip/firewall/filter` are the same section, and
 * trailing slashes are insignificant.
 */
export function normalizeSection(path: string): string {
  const cleaned = path
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split(/[\s/]+/)
    .filter(Boolean)
    .join("/");
  return `/${cleaned}`;
}

/**
 * Split an argument string into tokens, respecting double quotes.
 *
 * Quotes are stripped from the value but the value keeps its spaces, so
 * `comment="allow ssh"` yields one token whose value is `allow ssh`.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      // Keep the escape for the value pass; it decides whether `\"` is a quote
      // or a literal backslash in the payload.
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Strip surrounding quotes and unescape `\"` / `\\` inside a value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

/**
 * Parse one record's arguments. Splits each token at its FIRST `=` — a `=` inside
 * a quoted value belongs to the value, and `tokenize` has already kept such a
 * token whole.
 */
function parseFields(tokens: string[]): { fields: Record<string, string>; flags: string[] } {
  const fields: Record<string, string> = {};
  const flags: string[] = [];

  // RouterOS `set` (and `remove`/`enable`/…) take a POSITIONAL selector first:
  // `/ip service set telnet disabled=yes` names the item as a bare token, not as
  // `name=telnet`. Surface it as `name` so a rule can say
  // `where: {name: telnet}` — without this, every rule about a named service or
  // a numbered rule silently matches nothing, which reads as "not applicable"
  // and quietly disappears from the report.
  const [first] = tokens;
  if (first !== undefined && !first.includes("=") && !first.startsWith("!")) {
    if (!tokens.some((t) => t.startsWith("name="))) fields.name = unquote(first);
  }

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      // A bare token is a flag (`blackhole`, `disabled`) — or, with a leading
      // `!`, RouterOS's negated form (`!blackhole`), which is a flag set to no.
      const negated = token.startsWith("!");
      const name = negated ? token.slice(1) : token;
      if (name === "") continue;
      flags.push(name);
      fields[name] = negated ? "no" : "yes";
      continue;
    }
    const key = token.slice(0, eq).trim();
    if (key === "") continue;
    fields[key] = unquote(token.slice(eq + 1));
  }
  return { fields, flags };
}

/** Join `\`-continued physical lines into logical ones, keeping start numbers. */
function logicalLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let buffer = "";
  let startLine = 0;

  const physical = text.replace(/\r\n/g, "\n").split("\n");
  for (const [index, rawLine] of physical.entries()) {
    const line = rawLine.replace(/\r$/, "");
    if (buffer === "") startLine = index + 1;
    buffer = buffer === "" ? line : `${buffer} ${line.trim()}`;

    if (buffer.trimEnd().endsWith("\\")) {
      // Drop the trailing `\` (and the space before it) so the next physical
      // line joins with exactly one separator.
      buffer = buffer.trimEnd().slice(0, -1).trimEnd();
      continue;
    }
    out.push({ line: startLine, text: buffer });
    buffer = "";
  }
  // An export that ends mid-continuation still has content worth keeping.
  if (buffer !== "") out.push({ line: startLine, text: buffer });
  return out;
}

const RECORD_VERBS = new Set(["add", "set", "remove", "unset", "move", "enable", "disable"]);

/**
 * Parse an `/export` into a sectioned model.
 *
 * Anything unrecognised lands in `unparsed` rather than being dropped: a rule
 * file evaluated against a config we only half-understood should be able to say
 * so, instead of reporting a confident pass over lines nobody read.
 */
export function parseExport(text: string): ConfigModel {
  const byPath = new Map<string, ConfigSection>();
  const unparsed: { line: number; text: string }[] = [];
  let currentSection: string | null = null;
  let recordCount = 0;

  /**
   * Get (or create) a section. `opened` marks the call as a menu-path line, so
   * `lines` records where the MENU was opened — a section opened twice has two
   * entries — rather than accumulating one entry per record in it.
   */
  const section = (path: string, line: number, opened = false): ConfigSection => {
    const existing = byPath.get(path);
    if (existing) {
      if (opened && !existing.lines.includes(line)) existing.lines.push(line);
      return existing;
    }
    const created: ConfigSection = { path, records: [], lines: opened ? [line] : [] };
    byPath.set(path, created);
    return created;
  };

  for (const { line, text: logical } of logicalLines(text)) {
    const trimmed = logical.trim();
    if (trimmed === "") continue;
    // `#` starts a comment line (the export header, and `# comment` separators).
    if (trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("/")) {
      // A menu path, optionally with an inline command:
      // `/ip firewall filter` or `/ip dns set servers=1.1.1.1`.
      const tokens = tokenize(trimmed);
      const verbIndex = tokens.findIndex((t, i) => i > 0 && RECORD_VERBS.has(t));
      if (verbIndex > 0) {
        const path = normalizeSection(tokens.slice(0, verbIndex).join(" "));
        const target = section(path, line, true);
        const { fields, flags } = parseFields(tokens.slice(verbIndex + 1));
        target.records.push({
          section: path,
          op: tokens[verbIndex],
          fields,
          flags,
          line,
          raw: trimmed,
        });
        recordCount++;
        currentSection = path;
        continue;
      }
      currentSection = normalizeSection(trimmed);
      section(currentSection, line, true);
      continue;
    }

    const tokens = tokenize(trimmed);
    const verb = tokens[0];
    if (!verb || !RECORD_VERBS.has(verb)) {
      unparsed.push({ line, text: trimmed });
      continue;
    }
    if (currentSection === null) {
      // A record before any menu path — a truncated or hand-edited export.
      unparsed.push({ line, text: trimmed });
      continue;
    }

    const target = section(currentSection, line);
    const { fields, flags } = parseFields(tokens.slice(1));
    target.records.push({
      section: currentSection,
      op: verb,
      fields,
      flags,
      line,
      raw: trimmed,
    });
    recordCount++;
  }

  return {
    sections: [...byPath.values()],
    byPath,
    recordCount,
    unparsed,
  };
}

/**
 * Records of a section. Accepts either path form and returns `[]` for a section
 * the export does not contain — the caller decides whether that is a pass, a
 * fail, or not-applicable, because only the rule knows.
 */
export function recordsOf(model: ConfigModel, path: string): ConfigRecord[] {
  return model.byPath.get(normalizeSection(path))?.records ?? [];
}

/**
 * A section's settings as one record.
 *
 * Single-value menus (`/ip/ssh`, `/ip/settings`) are exported as one or more
 * `set` lines, and a rule about them ("strong-crypto must be yes") reads far
 * more naturally against a single merged record than against a list. Later
 * `set` lines win, which is what the device itself does when replaying the
 * export.
 */
export function settingsOf(model: ConfigModel, path: string): ConfigRecord | undefined {
  const records = recordsOf(model, path).filter((r) => r.op === "set");
  if (records.length === 0) return undefined;
  const merged: ConfigRecord = {
    section: normalizeSection(path),
    op: "set",
    fields: {},
    flags: [],
    line: records[0].line,
    raw: records.map((r) => r.raw).join("\n"),
  };
  for (const record of records) {
    Object.assign(merged.fields, record.fields);
    merged.flags.push(...record.flags);
  }
  return merged;
}
