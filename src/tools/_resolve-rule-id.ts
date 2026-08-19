/**
 * Shared item-ID resolver for RouterOS list menus (firewall, mangle, routes,
 * WireGuard peers, …).
 *
 * A bare number like `"3"` is the positional row index shown in `print` output,
 * NOT an internal `.id` — RouterOS `.id` values are always `*`-prefixed hex
 * (`*3`, `*1F`), so a bare decimal can only mean a row.  We resolve it by
 * listing all `.id`s in order and picking by index.  (Trying `.id=*N` first
 * would wrongly match whichever stale item happens to carry that internal id.)
 *
 * Resolving matters beyond convenience: RouterOS `set`/`remove` accept a bare
 * number as an ordinal, while `print … where .id=` treats it as a literal that
 * matches nothing. A tool that passes the caller's string straight to both ends
 * up EDITING one item and REPORTING another. Everything goes through here so
 * both halves of an operation address the same, single, resolved `.id`.
 *
 * Returns `null` when the position is out of range, the id does not exist, or
 * the value is not a syntactically valid RouterOS id.
 */
import { executeMikrotikCommand } from "../core/connector";
import { isEmpty } from "../core/routeros";
import type { ToolContext } from "../core/context";

/**
 * A syntactically valid RouterOS item reference: an internal `.id` (`*` +
 * hex) or a bare decimal row position.
 *
 * Enforced because these values are interpolated into a command: `.id` is not a
 * quotable value position, so `quoteValue` cannot help here and a shape check is
 * what keeps a crafted string from carrying a `;` into the console. Anything
 * that is not one of the two legitimate forms is rejected before it reaches the
 * device.
 */
const VALID_ID = /^(?:\*[0-9a-fA-F]+|\d+)$/;

/** True when `id` is a well-formed RouterOS `.id` or row position. */
export function isValidItemId(id: string): boolean {
  return VALID_ID.test(id.trim());
}

/**
 * Every `.id` in a menu, in the order `print` shows them.
 *
 * `:foreach` + `:put` lists one id per line, which is both how a row position is
 * resolved and how a reorder is verified after the fact.
 */
export async function listItemIds(scope: string, ctx: ToolContext): Promise<string[]> {
  const idsRaw = await executeMikrotikCommand(`:foreach i in=[${scope} find] do={:put $i}`, ctx);
  if (isEmpty(idsRaw)) return [];
  return idsRaw
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Build a resolver for the `.id` of an item in a RouterOS list menu.
 *
 * @param scope  The RouterOS menu path, e.g. `/ip firewall nat`.
 * @returns An async function `(itemId, ctx) => resolvedId | null`.
 */
export function ruleResolver(scope: string) {
  return async function resolveRuleId(ruleId: string, ctx: ToolContext): Promise<string | null> {
    const id = ruleId.trim();
    if (!isValidItemId(id)) return null;

    if (/^\d+$/.test(id)) {
      // Positional row index: pick by index from the ordered id list.
      const ids = await listItemIds(scope, ctx);
      if (ids.length === 0) return null;
      const pos = Number.parseInt(id, 10);
      return pos >= 0 && pos < ids.length ? ids[pos] : null;
    }

    // Already prefixed (e.g. `*1F`) — verify it exists.
    const count = await executeMikrotikCommand(`${scope} print count-only where .id=${id}`, ctx);
    return count.trim() !== "0" ? id : null;
  };
}

/**
 * The "not found" message for an unresolvable id, naming the two accepted forms.
 *
 * A rejected value is far more often a malformed reference (a name, a comment,
 * an `*`-less hex string) than a genuinely missing item, so the message says
 * what a valid reference looks like instead of only "not found".
 */
export function notFoundMessage(what: string, id: string, listTool: string): string {
  const shape = isValidItemId(id)
    ? ""
    : ` '${id}' is not a valid reference — pass the \`.id\` from ${listTool} (e.g. "*1F") or a bare row position (e.g. "3").`;
  return `${what} '${id}' not found.${shape}`;
}
