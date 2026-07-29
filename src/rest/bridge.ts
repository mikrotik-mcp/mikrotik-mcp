/**
 * Console ↔ REST bridge — the pure translator between the RouterOS console
 * command strings every tool already emits and the REST API's HTTP shape.
 *
 * Tools build commands with `Cmd` (`/ip/address/print where interface=ether1`).
 * Rather than rewrite 819 handlers, {@link toRequest} maps such a command onto
 * `{method, path, query, body}` and {@link toConsoleText} renders the JSON reply
 * back into console-shaped text those handlers already parse.
 *
 * **The mapping is deliberately conservative: when anything is uncertain,
 * `toRequest` returns `null` and the caller falls back to SSH.** A wrong mapping
 * would run the wrong command on a router; an absent mapping merely costs the
 * SSH round-trip we were trying to save. Every `null` path here is a correctness
 * decision, not a gap to be closed later.
 *
 * Pure: no I/O, no imports from `tools/`, no device state.
 */

/** An HTTP request derived from a console command. */
export interface RestRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** REST path WITHOUT the `/rest` prefix, e.g. `ip/address`. */
  path: string;
  /** Query parameters (REST filters). Empty when there are none. */
  query: Record<string, string>;
  /** JSON body for PUT/PATCH/POST. Undefined for GET/DELETE. */
  body?: Record<string, string>;
  /**
   * True when the console asked for `count-only`, so {@link toConsoleText}
   * renders the array length instead of the records.
   */
  countOnly?: boolean;
}

/**
 * Console verbs that map cleanly onto REST. Anything else — `export`, `monitor`,
 * `find`, scripting — is unmappable by design.
 */
const MAPPABLE = new Set(["print", "add", "set", "remove", "enable", "disable"]);

/**
 * Constructs that mean "do not touch this over REST", checked against the whole
 * command before parsing:
 *
 * - `[` — a `[find ...]` selector resolves server-side in the console; REST has
 *   no equivalent, and guessing one would target the wrong records.
 * - `;` / `:` — a command chain or a scripting expression.
 * - `$` — variable substitution.
 * - `?` — console query syntax, distinct from a REST filter.
 */
const CONSOLE_ONLY = /[[\];:$?]/;

/** Menus with no REST representation at all, matched on the path prefix. */
const NO_REST_MENU = [
  "export",
  "system/backup",
  "system/script",
  "tool/", // interactive: ping, bandwidth-test, traceroute, sniffer
  "file/",
  "certificate/sign",
  "password",
  "quit",
];

/**
 * Split a command into whitespace-separated tokens, keeping double-quoted
 * segments intact and honouring the backslash escapes `quoteValue` emits
 * (`\"` and `\\`). Written as a character loop rather than a regex: the input is
 * machine-generated but arbitrary in length, and a quote-aware regex here would
 * be both unreadable and a backtracking risk.
 */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && i + 1 < command.length) {
      // Preserve the escape for the value parser; it is unwrapped in unquote().
      cur += c + command[i + 1];
      i++;
      started = true;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      cur += c;
      started = true;
      continue;
    }
    if (!quoted && (c === " " || c === "\t")) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return quoted ? [] : out; // an unterminated quote is malformed → unmappable
}

/** Strip surrounding quotes and unescape `\"` / `\\`, inverting `quoteValue`. */
export function unquote(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"') && value.length >= 2)) return value;
  const inner = value.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      // Only these escapes are produced by quoteValue; anything else is literal.
      out += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
      i++;
      continue;
    }
    out += inner[i];
  }
  return out;
}

/** `key=value` → a pair, or null when the token is not an assignment. */
function splitPair(token: string): [string, string] | null {
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  return [token.slice(0, eq), unquote(token.slice(eq + 1))];
}

/**
 * Normalize a menu path: `/ip address` and `/ip/address` both become
 * `ip/address`. RouterOS accepts either spelling and the codebase uses both.
 */
function normalizePath(segments: string[]): string {
  return segments.filter(Boolean).join("/");
}

/**
 * Translate a console command into a REST request, or `null` when it cannot be
 * mapped faithfully (the caller must then use SSH).
 */
export function toRequest(command: string): RestRequest | null {
  const cmd = command.trim();
  if (!cmd.startsWith("/")) return null;
  if (CONSOLE_ONLY.test(cmd)) return null;

  const tokens = tokenize(cmd);
  if (tokens.length === 0) return null;

  // Walk the leading tokens, expanding each on `/` so `/ip address print` and
  // `/ip/address/print` parse identically. Menu segments accumulate until a
  // known verb appears; that verb ends the path and everything after its token
  // is the property/filter list.
  const lead: { seg: string; tokenIdx: number }[] = [];
  for (let i = 0; i < tokens.length && !tokens[i].includes("="); i++) {
    for (const seg of tokens[i].split("/").filter(Boolean)) lead.push({ seg, tokenIdx: i });
  }

  const segments: string[] = [];
  let verb = "";
  let verbToken = -1;
  for (const { seg, tokenIdx } of lead) {
    if (MAPPABLE.has(seg)) {
      verb = seg;
      verbToken = tokenIdx;
      break;
    }
    if (seg === "where") break; // a filter before any verb is malformed
    if (!/^[\w\-.]+$/.test(seg)) return null;
    segments.push(seg);
  }

  // No verb means a console-only command (`/export`, `/tool ping`, `monitor`).
  if (!verb) return null;
  const path = normalizePath(segments);
  if (!path) return null;
  if (NO_REST_MENU.some((m) => path === m.replace(/\/$/, "") || path.startsWith(m))) return null;

  const rest = tokens.slice(verbToken + 1);
  switch (verb) {
    case "print":
      return buildPrint(path, rest);
    case "add":
      return buildAdd(path, rest);
    case "set":
      return buildSet(path, rest);
    case "remove":
      return buildRemove(path, rest);
    case "enable":
      return buildToggle(path, rest, false);
    case "disable":
      return buildToggle(path, rest, true);
    default:
      return null;
  }
}

/**
 * `print [detail] [count-only] [where k=v …]` → GET with equality filters.
 *
 * Only `=` comparisons map. A `~` regex match, `>`/`<`, or an `or`/`and` clause
 * is console-side query syntax with no REST equivalent — those return null so
 * the command runs over SSH and still gets the right answer.
 */
function buildPrint(path: string, rest: string[]): RestRequest | null {
  const query: Record<string, string> = {};
  let countOnly = false;

  for (const token of rest) {
    const bare = token.replace(/^\//, "");
    if (bare === "detail" || bare === "without-paging" || bare === "terse") continue;
    if (bare === "count-only") {
      countOnly = true;
      continue;
    }
    // `where` is a separator, not a filter — RouterOS accepts filters with or
    // without it, and REST expresses both the same way.
    if (bare === "where") continue;
    if (bare === "or" || bare === "and" || bare === "from" || bare === "proplist") return null;

    const pair = splitPair(token);
    if (!pair) return null;
    const [k, v] = pair;
    // A filter operator other than `=` survived tokenization inside the key.
    if (/[~<>!]/.test(k)) return null;
    query[k] = v;
  }

  return { method: "GET", path, query, countOnly };
}

/** `add k=v …` → PUT with a JSON body. */
function buildAdd(path: string, rest: string[]): RestRequest | null {
  const body = collectPairs(rest);
  if (!body || Object.keys(body).length === 0) return null;
  return { method: "PUT", path, query: {}, body };
}

/**
 * `set .id=*1 k=v …` → PATCH `path/*1`.
 *
 * A `set` without an explicit `.id` (or `numbers=`) targets "the settings menu"
 * for singleton menus like `/ip/dns` — that maps to PATCH on the bare path.
 * A `set` selecting rows any other way already returned null via `[find`.
 */
function buildSet(path: string, rest: string[]): RestRequest | null {
  const pairs = collectPairs(rest);
  if (!pairs) return null;
  const id = pairs[".id"] ?? pairs.numbers;
  delete pairs[".id"];
  delete pairs.numbers;
  if (Object.keys(pairs).length === 0) return null;
  return { method: "PATCH", path: id ? `${path}/${id}` : path, query: {}, body: pairs };
}

/** `remove .id=*1` → DELETE `path/*1`. Without an `.id` there is no target. */
function buildRemove(path: string, rest: string[]): RestRequest | null {
  const pairs = collectPairs(rest);
  const id = pairs?.[".id"] ?? pairs?.numbers;
  if (!id) return null;
  return { method: "DELETE", path: `${path}/${id}`, query: {} };
}

/** `enable/disable .id=*1` → PATCH `disabled=no|yes`. */
function buildToggle(path: string, rest: string[], disabled: boolean): RestRequest | null {
  const pairs = collectPairs(rest);
  const id = pairs?.[".id"] ?? pairs?.numbers;
  if (!id) return null;
  return {
    method: "PATCH",
    path: `${path}/${id}`,
    query: {},
    body: { disabled: disabled ? "yes" : "no" },
  };
}

/** All `key=value` tokens, or null if any token is not an assignment. */
function collectPairs(rest: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const token of rest) {
    const pair = splitPair(token);
    if (!pair) return null;
    out[pair[0]] = pair[1];
  }
  return out;
}

// ── JSON → console text ─────────────────────────────────────────────────────

/** Quote a value for console-shaped output when it is not a bare token. */
function renderValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /^[\w.\-:/,*@!]+$/.test(s) && s !== "" ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Render a REST JSON reply as the console-shaped text handlers expect.
 *
 * - **Array** (a list menu) → numbered `N key=value …` records, i.e. the
 *   `print detail` form. The plain `print` form is a per-menu aligned column
 *   layout that cannot be reproduced from JSON alone; `detail` carries strictly
 *   more information, and every handler that extracts `.id` or a property reads
 *   it correctly. This is the one deliberate shape difference between the two
 *   transports, and the reason REST is opt-in per device.
 * - **Object** (a settings menu like `/ip/dns`) → `  key: value` lines, which is
 *   exactly what the console prints for those menus.
 * - **Empty array** → `""`, so `isEmpty()` reports "nothing found" as it does
 *   for SSH.
 */
export function toConsoleText(json: unknown, req?: Pick<RestRequest, "countOnly">): string {
  if (json === null || json === undefined) return "";

  if (Array.isArray(json)) {
    if (req?.countOnly) return String(json.length);
    if (json.length === 0) return "";
    return json
      .map((rec, i) => {
        const body = Object.entries(rec as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${renderValue(v)}`)
          .join(" ");
        return ` ${i} ${body}`;
      })
      .join("\n");
  }

  if (typeof json === "object") {
    const entries = Object.entries(json as Record<string, unknown>);
    if (entries.length === 0) return "";
    return entries.map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : String(v)}`).join("\n");
  }

  return String(json);
}
