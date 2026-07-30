/**
 * `/log print detail` → structured events. PURE, no I/O.
 *
 * A dedicated parser rather than the shared `parseRecords`, for two reasons
 * found by feeding real device output to it:
 *
 * 1. `time=2026-07-30 17:23:00` carries an **unquoted space**. Every other
 *    RouterOS menu quotes a value containing one, so the generic tokenizer
 *    truncates the timestamp to the date — and a detector with no clock cannot
 *    express "ten failures in five minutes", which is the whole feature.
 * 2. `/log` records have no `.id=` and are separated by blank lines, so the
 *    generic record splitter merges or drops them. Undercounting an attack is
 *    the one error this module must not make.
 *
 * (`correlate_events` in `src/tools/root-cause.ts` uses the generic parser on
 * this same output and therefore already loses records and clocks. Out of scope
 * here — noted so it can be pointed at this module later.)
 *
 * RouterOS 7 also writes a structured `extra-info` field:
 *
 *     message="login failure for user admin from 203.0.113.7 via api"
 *     extra-info="app=api duser=admin outcome=failure src=203.0.113.7 "
 *
 * That is parsed FIRST and the message regex is the fallback. Prose wording
 * changes between releases; the key=value form does not. RouterOS 6 emits no
 * `extra-info` at all, so the fallback is not optional.
 */
import { parseRouterosDate } from "../core/routeros-parse";

/** One `/log` record, fields verbatim. */
export interface LogRecord {
  /** `time=` as printed, e.g. `2026-07-30 17:23:00`. */
  timeText: string;
  topics: string[];
  message: string;
  /** Raw `extra-info=` value, when the release emits one. */
  extraInfo?: string;
  /** The record's own source text, for showing a human the evidence. */
  raw: string;
}

/** What a log line meant, once both the structured and prose forms are read. */
export interface LogEvent {
  device: string;
  /** Epoch ms; `null` when the timestamp could not be read (never guessed). */
  ts: number | null;
  timeText: string;
  topics: string[];
  message: string;
  /** Parsed `extra-info` key/values (empty on RouterOS 6). */
  extra: Record<string, string>;
  /** Service the attempt came through: `ssh`, `api`, `winbox`, `telnet`, … */
  app?: string;
  user?: string;
  outcome?: "success" | "failure";
  /** Source address of the attempt, when the line names one. */
  source?: string;
  /**
   * Stable identity for de-duplication.
   *
   * `/log` is a ring buffer with NO cursor, so successive polls must overlap to
   * avoid missing entries — and an overlap re-delivers lines. Counting one
   * brute-force attempt twice inflates every threshold, so every consumer keys
   * on this.
   */
  key: string;
}

export interface ParsedLog {
  events: LogEvent[];
  /**
   * Lines that could not be read, with their position.
   *
   * Reported, never dropped: a security feature that silently discards the log
   * lines it did not understand is exactly the feature an attacker wants.
   */
  unparsed: { line: number; text: string }[];
}

/** A record begins at a line whose first token is `time=`. */
const RECORD_START = /^\s*time=/;

/** Every `key="quoted"` / `key=bare` pair in a chunk of record text. */
const FIELD_RE = /([a-zA-Z][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;
/** `time=2026-07-30 17:23:00` — the one value RouterOS leaves unquoted with a space. */
const TIME_WITH_CLOCK_RE = /time=(\S+)[ \t]+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;

/**
 * Pull `key="quoted value"` or `key=bare` out of a record's text.
 *
 * Handles the `time=` special case: its value is `date [clock]` with an
 * unquoted space, so the clock is reattached only when it looks like one.
 */
function fields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(FIELD_RE)) {
    out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "");
  }
  const withClock = TIME_WITH_CLOCK_RE.exec(text);
  if (withClock) out.time = `${withClock[1]} ${withClock[2]}`;
  return out;
}

/** Split `/log print detail` output into records. */
export function parseLogRecords(text: string): {
  records: LogRecord[];
  unparsed: { line: number; text: string }[];
} {
  const records: LogRecord[] = [];
  const unparsed: { line: number; text: string }[] = [];
  const lines = text.split("\n");

  let current: string[] = [];
  let startLine = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const raw = current.join("\n");
    const f = fields(raw);
    if (f.time === undefined || f.message === undefined) {
      unparsed.push({ line: startLine, text: raw.trim().slice(0, 200) });
    } else {
      records.push({
        timeText: f.time,
        topics: (f.topics ?? "").split(",").filter(Boolean),
        message: f.message,
        extraInfo: f["extra-info"],
        raw: raw.trim(),
      });
    }
    current = [];
  };

  lines.forEach((line, i) => {
    if (RECORD_START.test(line)) {
      flush();
      startLine = i + 1;
      current = [line];
      return;
    }
    if (current.length > 0) {
      // A blank line ends a record; anything else is a continuation.
      if (line.trim() === "") flush();
      else current.push(line);
      return;
    }
    // Outside any record: banner text and blank lines are expected noise, but a
    // line that looks like it carries a message is a parser gap worth seeing.
    if (line.includes("message=")) unparsed.push({ line: i + 1, text: line.trim().slice(0, 200) });
  });
  flush();

  return { records, unparsed };
}

const EXTRA_RE = /([a-zA-Z][\w-]*)=("((?:[^"\\]|\\.)*)"|\S*)/g;

/** `app=ssh duser=admin outcome=failure src=203.0.113.7 ` → an object. */
export function parseExtraInfo(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const m of value.matchAll(EXTRA_RE)) {
    out[m[1]] = m[3] !== undefined ? m[3].replace(/\\(.)/g, "$1") : m[2];
  }
  return out;
}

/**
 * Prose fallbacks, for RouterOS 6 and any topic that emits no `extra-info`.
 *
 * Deliberately narrow: these only claim an outcome for wordings that state one.
 * A line this does not recognise yields an event with no `outcome`, which every
 * detector treats as "not evidence" — better than a guess that fires a block.
 */
const MESSAGE_FORMS: {
  re: RegExp;
  outcome?: "success" | "failure";
  map: (m: RegExpMatchArray) => { user?: string; source?: string; app?: string };
}[] = [
  {
    // login failure for user admin from 203.0.113.7 via api
    re: /^login failure for user (\S+) from (\S+) via (\S+)/i,
    outcome: "failure",
    map: (m) => ({ user: m[1], source: m[2], app: m[3] }),
  },
  {
    // user admin logged in from 198.51.100.4 via ssh
    re: /^user (\S+) logged in from (\S+) via (\S+)/i,
    outcome: "success",
    map: (m) => ({ user: m[1], source: m[2], app: m[3] }),
  },
  {
    // user admin logged out from 198.51.100.4 via ssh — an outcome, but not an
    // attempt; recorded without one so it cannot count toward a threshold.
    re: /^user (\S+) logged out from (\S+) via (\S+)/i,
    map: (m) => ({ user: m[1], source: m[2], app: m[3] }),
  },
];

/** Anything that looks like an address, for lines with no explicit `src`. */
const ADDRESS_RE = /\b(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})\b/i;

/** Interpret one record. */
export function toLogEvent(record: LogRecord, device: string): LogEvent {
  const extra = parseExtraInfo(record.extraInfo);

  // `Record<string, string>` types a MISSING key as `string`, which is a lie at
  // runtime — read through an accessor so an absent field is honestly undefined.
  const field = (name: string): string | undefined => extra[name] || undefined;

  let app = field("app");
  let user = field("duser") ?? field("user");
  let source = field("src");
  let outcome: "success" | "failure" | undefined =
    field("outcome") === "success"
      ? "success"
      : field("outcome") === "failure"
        ? "failure"
        : undefined;

  // The structured form wins; the prose fills only what it left empty, so a
  // release that renames a message cannot change an outcome already stated.
  for (const form of MESSAGE_FORMS) {
    const m = record.message.match(form.re);
    if (!m) continue;
    const mapped = form.map(m);
    user ??= mapped.user;
    source ??= mapped.source;
    app ??= mapped.app;
    outcome ??= form.outcome;
    break;
  }
  source ??= record.message.match(ADDRESS_RE)?.[1];

  return {
    device,
    ts: parseRouterosDate(record.timeText),
    timeText: record.timeText,
    topics: record.topics,
    message: record.message,
    extra,
    app,
    user,
    outcome,
    source,
    key: `${device}|${record.timeText}|${record.message}`,
  };
}

/** Parse a device's `/log print detail` output into events. */
export function parseLog(text: string, device: string): ParsedLog {
  const { records, unparsed } = parseLogRecords(text);
  return { events: records.map((r) => toLogEvent(r, device)), unparsed };
}

/**
 * Drop events already seen, mutating `seen` with what survived.
 *
 * The overlap between two polls is not an edge case, it is the normal path —
 * see {@link LogEvent.key}.
 */
export function dedupe(events: LogEvent[], seen: Set<string>): LogEvent[] {
  const fresh: LogEvent[] = [];
  for (const event of events) {
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    fresh.push(event);
  }
  return fresh;
}
