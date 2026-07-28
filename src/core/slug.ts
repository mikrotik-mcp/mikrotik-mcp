/**
 * Filename/key-safe slugs for device names.
 *
 * Device names are free-form (`"Ali Home"`, `"core_rtr.lab"`, `"DC1/edge"`), but
 * they end up inside backup filenames (`<device>_<stamp>.rsc`) and S3 object
 * keys (`<prefix>/<device>/<file>`). A raw space or underscore there either
 * breaks the vault's `safeName()` guard (which only permits `[A-Za-z0-9._-]`) or
 * produces awkward, hard-to-URL-encode S3 keys. `deviceSlug` normalises any
 * device name into a safe fragment: every run of characters outside
 * `[A-Za-z0-9-]` (spaces, underscores, dots, slashes, …) collapses to a single
 * dash, leading/trailing dashes are trimmed, and an all-symbol name falls back
 * to `"device"` so the result is never empty.
 *
 * Pure (no imports) so it's trivially unit-testable and free of import cycles.
 */
export function deviceSlug(name: string | undefined): string {
  // The trailing `-+$` carries a negative look-behind so it can only start at
  // the first dash of a run; without it the engine retries from every dash in a
  // run that isn't at the end, making the trim quadratic in name length (ReDoS).
  const s = (name ?? "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|(?<!-)-+$/g, "");
  return s || "device";
}
