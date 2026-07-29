/**
 * Helpers for assembling RouterOS CLI commands safely and concisely.
 *
 * Two jobs:
 *   1. Cut the per-tool boilerplate of conditionally appending `key=value`
 *      pairs (the dominant pattern across all 17 scope modules).
 *   2. **Quote/escape values correctly.** The RouterOS console treats `;` as a
 *      command separator and whitespace as an argument separator, so an
 *      unquoted user-supplied value such as `My LAN; /system reset` would split
 *      into extra commands. `Cmd` quotes any value that isn't a bare-safe token
 *      and escapes embedded quotes/backslashes — this is the injection boundary.
 */

/**
 * Characters that are safe to pass to the RouterOS console without quoting.
 *
 * `!` is included deliberately: it is RouterOS's negation operator in firewall
 * match values (`dst-address-list=!IR`, `tcp-flags=syn,!ack`,
 * `connection-state=!established`, `in-interface=!ether1`). It MUST stay
 * unquoted — `"!IR"` is read as a list literally named `!IR`, not "not in IR" —
 * and it is injection-safe (it is not a command/argument separator). Any value
 * that also carries a real separator (`;`, whitespace, …) still fails this test
 * and gets quoted, so the negation case is the only thing this enables.
 */
const BARE_SAFE = /^[\w.\-:/,*@!]+$/;

/** Quote and escape a value for the RouterOS console if it isn't a bare token. */
export function quoteValue(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value !== "" && BARE_SAFE.test(value)) return value;
  // Escape, in order: backslash, double-quote, dollar sign, then control chars
  // into their RouterOS escape sequences. Literal newlines/tabs must become
  // `\n`/`\r`/`\t` because the command is sent over the SSH `exec` channel as a
  // single line — a raw newline would terminate the console command mid-string
  // (e.g. a multi-line `/system script add source=...`) rather than stay inside
  // the quotes.  `$` MUST be escaped as `\$` because RouterOS interprets a bare
  // `$` inside double-quoted strings as variable substitution — an unescaped
  // `$var` is silently replaced with the (usually empty) value of that variable,
  // corrupting scripts and expressions.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  // CodeQL reports this as "unsafe shell command constructed from library
  // input" because the built command eventually reaches ssh2's `client.exec`
  // channel, which its models treat as a system-command sink. That flow is the
  // product: this server exists to run RouterOS console commands on a remote
  // device, and the ssh2 channel sends the string to the ROUTER's console, not
  // to any local OS shell. This function IS the sanitizer for that sink — every
  // value goes through `Cmd`/`quoteValue`, never string concatenation (see the
  // module header), and the escape order above (backslash first) leaves no way
  // to break out of the quotes. Accepted and reviewed, not an open injection
  // path.
  // codeql[js/shell-command-constructed-from-input]
  return `"${escaped}"`;
}

export function yesno(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

/**
 * Render a route's discard type as the argument RouterOS v7 actually accepts.
 *
 * v6's `/ip route ... type=blackhole` no longer exists — v7 rejects it with
 * "bad parameter type". The type is a BARE keyword argument instead
 * (`/ip route add dst-address=0.0.0.0/0 blackhole`); even `blackhole=yes` fails
 * ("expected end of command"), and on `set` the negated form `!blackhole` turns
 * it back into a unicast route. v6's `unreachable`/`prohibit` types are gone
 * from v7 entirely, which is why the tool schemas only offer unicast/blackhole.
 *
 * `forSet` picks the `set` form: on `add`, unicast is the default and needs no
 * argument at all; on `set` it must be spelled `!blackhole` to clear the flag.
 */
export function routeTypeArg(
  type: "unicast" | "blackhole" | undefined,
  forSet = false,
): string | undefined {
  if (type === undefined) return undefined;
  if (type === "blackhole") return "blackhole";
  return forSet ? "!blackhole" : undefined;
}

/**
 * Split a `host:port` string into its host and numeric port. Several RouterOS
 * menus (e.g. `/interface sstp-client`) take the server address and the port as
 * SEPARATE parameters and reject a `connect-to` that embeds `:port` with "bad
 * address or dns name" — so a caller-supplied `host:port` must be split.
 *
 * IPv6-aware: a bare IPv6 literal (`2001:db8::1`) has no port and is returned
 * as-is; a bracketed `[2001:db8::1]:443` yields the inner address and the port.
 * When there is no port, `port` is undefined and `host` is the input unchanged.
 */
export function splitHostPort(value: string): { host: string; port?: number } {
  const v = value.trim();
  // Bracketed IPv6 with optional port: [::1] or [::1]:443
  const bracket = v.match(/^\[(.+)\](?::(\d+))?$/);
  if (bracket) {
    return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : undefined };
  }
  // A bare IPv6 literal (two or more colons, no brackets) has no port to split.
  if ((v.match(/:/g)?.length ?? 0) > 1) return { host: v };
  // host:port — host is an IPv4 or hostname (no colons of its own).
  const hostPort = v.match(/^([^:]+):(\d+)$/);
  if (hostPort) return { host: hostPort[1], port: Number(hostPort[2]) };
  return { host: v };
}

/**
 * Fluent builder for RouterOS `add` / `set` style commands.
 *
 * ```ts
 * new Cmd("/interface vlan add")
 *   .set("name", name)
 *   .set("vlan-id", vlanId)
 *   .opt("comment", comment)          // appended only if defined
 *   .flag("disabled", disabled)       // appended only when true -> disabled=yes
 *   .bool("use-service-tag", useTag)  // appended as yes/no when not null
 *   .build();
 * ```
 */
export class Cmd {
  private parts: string[];

  constructor(base: string) {
    this.parts = [base];
  }

  /** Always append `key=value` (value is quoted/escaped as needed). */
  set(key: string, value: string | number | boolean): this {
    this.parts.push(`${key}=${quoteValue(value)}`);
    return this;
  }

  /** Append `key=value` only when `value` is neither undefined nor null. */
  opt(key: string, value: string | number | null | undefined): this {
    if (value !== undefined && value !== null && value !== "") {
      this.parts.push(`${key}=${quoteValue(value)}`);
    }
    return this;
  }

  /** Append `key=yes` only when `value` is true (the "if x: cmd += ' x=yes'" idiom). */
  flag(key: string, value: boolean | undefined | null): this {
    if (value) this.parts.push(`${key}=yes`);
    return this;
  }

  /** Append `key=yes|no` when `value` is defined (for explicit tri-state updates). */
  bool(key: string, value: boolean | undefined | null): this {
    if (value !== undefined && value !== null) {
      this.parts.push(`${key}=${yesno(value)}`);
    }
    return this;
  }

  /** Append a pre-formatted fragment verbatim (escape hatch). */
  raw(fragment: string | undefined | null): this {
    if (fragment) this.parts.push(fragment);
    return this;
  }

  build(): string {
    return this.parts.join(" ");
  }

  toString(): string {
    return this.build();
  }
}

/** Build a `where` clause from `field~value` / `field=value` fragments. */
export function whereClause(filters: string[]): string {
  return filters.length ? ` where ${filters.join(" ")}` : "";
}

/** True when RouterOS returned nothing meaningful for a query. */
export function isEmpty(result: string): boolean {
  const t = result.trim();
  return t === "" || t === "no such item" || t === "no such item (4)";
}

/**
 * Collapse the carriage-return "live redraw" that interactive RouterOS tools
 * (`/ping`, `/tool bandwidth-test`, `/tool speed-test`, `/tool flood-ping`)
 * stream — they overwrite the same line with `\r` to show a running counter, so
 * captured over a non-interactive channel it becomes one giant overwritten blob.
 * Keeping the final segment of each line yields a readable result (the last,
 * settled counter value plus the summary lines).
 */
export function flattenLiveOutput(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const segs = line.split("\r").filter((s) => s.trim() !== "");
      return segs.length ? segs[segs.length - 1] : "";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the internal `.id` RouterOS echoes after a successful `add`. ROS prints
 * the new item's id — a `*` followed by hex (e.g. `*1A`), or a bare ordinal — but
 * it may append a trailing warning or stray whitespace, so the raw `add` output
 * must NOT be used verbatim as a `print … where .id=<x>` key (a polluted key
 * yields "no such item"). Returns the first id token, or undefined when none.
 */
export function extractCreatedId(output: string): string | undefined {
  const star = output.match(/\*[0-9A-Fa-f]+/);
  if (star) return star[0];
  const num = output.trim().match(/^\d+$/);
  return num ? num[0] : undefined;
}

/**
 * True when a post-create read-back didn't return a usable record — so a handler
 * reports success from the `add`-echoed `.id` instead of splicing a device error
 * into a "created successfully" message. Covers an empty result, every "no such
 * item" variant (incl. the `no such item (…; line N)` form `isEmpty` misses), and
 * any parser/value error.
 */
export function readBackUnavailable(details: string): boolean {
  return isEmpty(details) || /no such item/i.test(details) || looksLikeError(details);
}

/**
 * Heuristic: did the device reject the command? Covers RouterOS console parser
 * and value errors that would otherwise be wrapped in a success message — value
 * failures (`failure:`), parser errors (`syntax error`, `bad command`,
 * `bad parameter`, `expected end of command`), and argument errors
 * (`invalid value`, `input does not match …`, `ambiguous value`).
 */
export function looksLikeError(result: string): boolean {
  const t = result.toLowerCase();
  return (
    t.includes("failure:") ||
    t.includes("syntax error") ||
    t.includes("bad command") ||
    t.includes("bad parameter") ||
    t.includes("expected end of command") ||
    t.includes("invalid value") ||
    t.includes("input does not match") ||
    t.includes("ambiguous value") ||
    t.startsWith("error")
  );
}

/**
 * When an ordered-rule `add` failed because its `place-before` referenced an
 * item that does not exist, return actionable guidance; otherwise `undefined`.
 *
 * RouterOS rejects `place-before` with "item referred by 'place-before' does not
 * exist" when the value is an internal `.id` (`*N`) that isn't present. This is a
 * very common confusion: the `*N` `.id` values are HEX, assigned internally and
 * reassigned over time — they are NOT the row/ordinal number shown by `print`.
 * So `place-before=*13` is not "before the 13th rule"; it's "before the rule
 * whose .id is *13", which may not exist. The guidance steers the caller to use
 * a bare ordinal (e.g. `13`) for a position, or a CURRENT `.id` from a list call.
 */
export function placeBeforeError(result: string, placeBefore?: string): string | undefined {
  if (!placeBefore) return undefined;
  const t = result.toLowerCase();
  if (!t.includes("place-before") || !(t.includes("does not exist") || t.includes("not found"))) {
    return undefined;
  }
  const detail = placeBefore.startsWith("*")
    ? `A '*N' value is an internal .id (hexadecimal, reassigned over time), NOT the row number — list the rules first and use a CURRENT .id, or pass a bare ordinal position instead (e.g. '${placeBefore.slice(1)}').`
    : "Pass a bare ordinal position (e.g. '0') or a current internal .id ('*N') from a list call.";
  return `place_before '${placeBefore}' does not exist on the device. ${detail}`;
}

/**
 * When a change failed because a port is already used by another item, return
 * actionable guidance naming the conflicting item; otherwise `undefined`.
 *
 * RouterOS rejects e.g. `/ip service set [find name=ssh] port=1996` with
 * "failure: this is configured elsewhere (/ip/service/set *0 = telnet)" when port
 * 1996 is already assigned to another service (here telnet) — two services can't
 * share a port. The raw message is cryptic, so this extracts the conflicting
 * item's name and explains the fix.
 */
export function portConflictError(result: string, port?: number): string | undefined {
  if (!/configured elsewhere/i.test(result)) return undefined;
  const other = result.match(/\*\d+\s*=\s*([A-Za-z][\w-]*)/)?.[1];
  const which = port != null ? `port ${port}` : "that port";
  return other
    ? `${which} is already used by the '${other}' service — two services can't share a port. Pick a different port, or change/disable '${other}' first (disable_ip_service / set_ip_service).`
    : `${which} is already in use elsewhere — two items can't share it. Pick a different port, or free it on the conflicting item first.`;
}

/**
 * True when RouterOS rejected the command *word* itself — i.e. the command path
 * does not exist on this RouterOS version (e.g. `/ip route cache`, removed in
 * v7) or was mistyped. Distinct from a value-level `failure:`; lets a tool give
 * a version-aware message instead of surfacing a raw parser error.
 *
 * Note: this deliberately does NOT match "expected end of command". That error
 * means the parser *recognized* the command path but found unexpected trailing
 * tokens — an argument-level syntax error, not a missing command. Treating it as
 * "unsupported" would mask real bugs in a generated command as a false
 * "feature not available on this device" (it is caught by `looksLikeError`).
 */
export function commandUnsupported(result: string): boolean {
  const t = result.toLowerCase();
  return (
    t.includes("bad command name") ||
    t.includes("no such command") ||
    t.includes("no such command prefix") ||
    t.includes("invalid command name")
  );
}

const PARSER_ERROR_HEAD =
  /^(?:bad command name|no such command|expected end of command|bad parameter|syntax error|ambiguous (?:command|value)|invalid value|input does not match)/i;

/**
 * Detects a RAW RouterOS console parser error left in a tool's output — e.g. a
 * read tool that printed "bad command name poe (line 1 column 21)" under a
 * success header. Used by the registry as a backstop so such results are marked
 * `isError` instead of looking like success.
 *
 * False-positive safe by design: RouterOS parser errors *begin* with the error
 * phrase AND carry a "(line N column M)" suffix. Neither appears that way in
 * print output or log lines (which begin with timestamps/flags), so legitimate
 * data containing the word "error" is never flagged.
 */
export function containsRawParserError(text: string): boolean {
  // Strip a leading "HEADER:\n\n" that tools prepend to raw device output.
  const body = text.includes("\n\n") ? text.slice(text.indexOf("\n\n") + 2) : text;
  const firstLine = body.trimStart().split("\n", 1)[0] ?? "";
  return PARSER_ERROR_HEAD.test(firstLine) && /\(line \d+ column \d+\)/.test(firstLine);
}

/**
 * True when a tool's text output represents a FAILED operation that should be
 * reported as `isError` to the host and the observability dashboard — even
 * though the handler flattened the device error into a plain string. Catches:
 *   • this codebase's handler error convention — text whose first line begins
 *     with "Failed" (e.g. "Failed to add route: bad parameter routing-mark …"),
 *     used exclusively for errors across the tool modules, and
 *   • a RouterOS parser-error coordinate "(line N column M)" appearing anywhere
 *     in the output (a device rejection embedded after a "Failed to …:" prefix,
 *     which `containsRawParserError` misses because the phrase isn't at the
 *     start of the line).
 *
 * Deliberately narrow: the "Failed" check is anchored to the first line only,
 * and the coordinate format is unique to RouterOS parser errors — so successful
 * print/export output is never flagged.
 */
export function indicatesFailure(text: string): boolean {
  const firstLine = text.trimStart().split("\n", 1)[0] ?? "";
  return /^Failed\b/.test(firstLine) || /\(line \d+ column \d+\)/.test(text);
}
