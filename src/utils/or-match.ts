/**
 * Build a parenthesised OR-match clause for a RouterOS `where` expression, e.g.
 *
 *   orMatch("topics", ["system", "firewall"])
 *   // => (topics~"system" or topics~"firewall")
 *
 * RouterOS only accepts double-quoted strings in `where` clauses — single quotes
 * are a console syntax error — so each value is wrapped in `"` and any embedded
 * `\` or `"` is escaped. The backslash MUST be escaped too: a value ending in a
 * lone `\` would otherwise escape the closing quote and let the rest of the
 * clause be read as string content. Use this instead of a single
 * `field~"a,b,c"`, which would try to regex-match the literal comma-joined
 * string rather than any one value.
 *
 * `op` is the comparison operator (default `~`, regex match; pass `=` for exact).
 * An empty `values` array returns `""` so callers can omit the clause entirely.
 */
export function orMatch(field: string, values: string[], op: "~" | "=" = "~"): string {
  if (values.length === 0) return "";
  const terms = values.map((v) => `${field}${op}"${v.replace(/[\\"]/g, "\\$&")}"`);
  return `(${terms.join(" or ")})`;
}
