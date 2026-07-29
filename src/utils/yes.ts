/**
 * Read a RouterOS boolean field.
 *
 * RouterOS is inconsistent about how it spells a true value: a console print
 * shows `yes`/`no`, while `print as-value`, the REST API and several `:put`
 * paths emit `true`/`false`. Both spellings reach parsers here, so field tests
 * must accept either — and both arrive with surrounding whitespace often enough
 * that trimming is not optional.
 *
 * This is the read direction. `yesno()` in `src/core/routeros.ts` is the write
 * direction (boolean → `yes`/`no`) for building commands.
 */

/** True when a `key: value` / `key=value` field reads as enabled. */
export function isYes(value: string | undefined | null): boolean {
  if (!value) return false;
  const t = value.trim().toLowerCase();
  return t === "yes" || t === "true";
}

/**
 * Like {@link isYes}, but for fields where **absent means enabled**.
 *
 * Several RouterOS menus omit a property entirely when it holds its default, and
 * for permission-style fields that default is permissive — `/system device-mode`
 * before a restriction is applied, for instance. Defaulting those to `false`
 * would report a capability as denied when the device never restricted it.
 */
export function isYesDefaultTrue(value: string | undefined | null): boolean {
  if (value === undefined || value === null || value.trim() === "") return true;
  const t = value.trim().toLowerCase();
  if (t === "no" || t === "false") return false;
  return t === "yes" || t === "true";
}
