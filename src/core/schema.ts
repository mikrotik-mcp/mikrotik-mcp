/**
 * Shared Zod field schemas for tool inputs.
 *
 * These encode RouterOS-side naming rules that every relevant tool must enforce
 * the same way, so a bad value is rejected once at the input boundary with an
 * actionable message rather than being quoted faithfully by `quoteValue` and then
 * failing device-side with a cryptic parser error.
 */
import { z } from "zod";

/** RouterOS object names may not contain whitespace. */
const NO_WHITESPACE = /^\S+$/;

const INTERFACE_NAME_MESSAGE =
  "RouterOS interface names cannot contain spaces or whitespace — use a dash instead, " +
  "e.g. 'wireguard-internal' not 'wireguard internal'.";

/**
 * The name of an interface (or interface-like named object) being CREATED or
 * RENAMED. RouterOS silently fails an `add`/rename whose name carries a space, so
 * reject any whitespace up front. Non-empty by construction (`^\S+$` requires at
 * least one non-space character). Pass a `description` to document the field.
 */
export function interfaceName(description?: string): z.ZodString {
  const s = z.string().regex(NO_WHITESPACE, INTERFACE_NAME_MESSAGE);
  return description ? s.describe(description) : s;
}

/**
 * `unset` input for `update_*` tools: properties to clear (RouterOS `!prop`),
 * as opposed to setting them to a value. Names are validated here and again by
 * `unsetFragments`, which builds the command fragment.
 */
export const unsetProperties = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]*$/, "Use a bare property name, e.g. 'dst-address'."))
  .optional()
  .describe(
    "Properties to UNSET (RouterOS `!prop`), so they no longer apply — e.g. ['dst-address'] " +
      "removes the destination-address match. snake_case or kebab-case. Not for setting a value.",
  );
