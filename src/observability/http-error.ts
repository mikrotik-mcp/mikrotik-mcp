/**
 * One place that turns a caught error into text safe to put in an HTTP response
 * body served by the dashboard.
 *
 * A raw `Error` reaching the client leaks more than intended: `.message` can
 * carry a multi-line stack-like tail, the absolute path of a file on this
 * machine (`/Users/<name>/.mikrotik-mcp/…`, which exposes the OS account), or an
 * unbounded blob of device/S3 output. The dashboard binds to loopback and can be
 * exposed with a bearer token, so "it's only local" is not a guarantee.
 *
 * `clientError()` keeps the first line (which is what a user can actually act
 * on), replaces the home-directory prefix with `~`, and caps the length. Log the
 * unabridged error server-side instead — `logger` writes to stderr, which the
 * MCP host surfaces to the operator.
 */
import { homedir } from "node:os";

const HOME = homedir();
const MAX_LEN = 300;

/** Sanitised, single-line message for an unknown thrown value. */
export function clientError(e: unknown, fallback = "unknown error"): string {
  const raw = e instanceof Error ? e.message : String(e);
  // First line only: strips any appended stack frames ("\n    at fn (file:1:2)").
  const line = raw.split("\n", 1)[0].trim();
  // split/join, not replace — HOME is a literal path, not a pattern.
  const masked = HOME.length > 1 ? line.split(HOME).join("~") : line;
  if (!masked) return fallback;
  return masked.length > MAX_LEN ? `${masked.slice(0, MAX_LEN)}…` : masked;
}

/** The full error text (message + stack when present) for server-side logs. */
export function logError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}
