/**
 * Read-back for writes: what the router itself recorded for a tool call.
 *
 * RouterOS keeps a change log (`/system history`): one line for each
 * configuration change, newest first. The registry reads it before and after a
 * tool that can change the router, and appends the new lines to the result. A
 * tool that says "enabled successfully" for an item that does not exist then
 * shows "no change recorded" next to it, from the router and not from the tool.
 *
 * The log is evidence, not proof:
 * - Some actions change no configuration and leave no line (a reboot, a file
 *   upload, a script run, a cache flush). "No change recorded" is then normal.
 * - A busy router (failover scripts, other administrators) adds lines of its
 *   own in the same seconds. They are shown too, because they cannot be told
 *   apart.
 *
 * A probe that fails or is slow is skipped. It never fails or delays the call
 * beyond {@link PROBE_TIMEOUT_MS}.
 */
import { executeMikrotikCommand } from "./connector";
import type { ToolContext } from "./context";
import { looksLikeError } from "./routeros";

export const PROBE_TIMEOUT_MS = 8000;
const MAX_SHOWN = 12;

/** The entries of `/system history print`, newest first, without flags and header. */
export function parseHistory(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && !/^(?:Flags:|Columns:)/.test(line))
    .filter((line) => !/^\s*ACTION\b/.test(line))
    .map((line) =>
      line
        .replace(/^[A-Z ]{0,3}\s/, "")
        .replace(/\s{2,}/g, "  ")
        .trim(),
    );
}

/**
 * The entries that are in `after` and were not in `before`. `null` when the old
 * top of the log is no longer there (the log rolled over), so the count is unknown.
 */
export function newEntries(before: string[], after: string[]): string[] | null {
  if (before.length === 0) return after;
  // The old newest lines must appear again, in order, lower in the new list.
  const anchor = before.slice(0, Math.min(3, before.length));
  for (let i = 0; i + anchor.length <= after.length; i += 1) {
    if (anchor.every((line, at) => after[i + at] === line)) return after.slice(0, i);
  }
  return null;
}

/** The sentence added to the tool result. */
export function describeChange(entries: string[] | null): string {
  if (entries === null)
    return "Router change log: it rolled over during this call, so the changes cannot be listed.";
  if (entries.length === 0)
    return (
      "Router change log: no change recorded for this call. If you expected a configuration " +
      "change, it did not happen (for example, the item was not found). Actions that change " +
      "no configuration (a reboot, a file transfer, a script run) leave no entry."
    );
  const shown = entries.slice(0, MAX_SHOWN).map((line) => `  - ${line}`);
  const more = entries.length > MAX_SHOWN ? [`  - … and ${entries.length - MAX_SHOWN} more`] : [];
  return [
    `Router change log: ${entries.length} new ${entries.length === 1 ? "entry" : "entries"} (newest first):`,
    ...shown,
    ...more,
  ].join("\n");
}

/** Read the change log, or `null` when it cannot be read in time. */
export async function readHistory(ctx: ToolContext): Promise<string[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A READ context: the probe never enters an open Safe Mode session.
    const probe = executeMikrotikCommand("/system history print", { ...ctx, risk: "READ" });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
    });
    const output = await Promise.race([probe, timeout]);
    // The probe may still finish later; its result is not needed any more.
    void probe.catch(() => {});
    if (output === null || looksLikeError(output)) return null;
    return parseHistory(output);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
