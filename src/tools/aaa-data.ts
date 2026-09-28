/**
 * AAA (RADIUS + User Manager) data layer — structured fetch + mutation helpers
 * shared by the observability dashboard's `/api/aaa/*` routes and the AAA MCP
 * App view. The MCP tools in `radius.ts` / `user-manager.ts` return human text;
 * a UI needs rows + a stable id, so this module parses `print detail` into
 * records, attaches RouterOS's stable `.id` (via `[find]`, zipped in print
 * order), and redacts secrets — one implementation both surfaces call.
 *
 * Mutations are keyed by a STABLE identifier, never the volatile print index:
 *   • RADIUS / user-profiles / sessions → RouterOS `.id` (e.g. `*1`)
 *   • User Manager users/profiles/routers/limitations → their unique `name`
 * Allowed attribute keys are whitelisted per entity so a request can only set
 * the fields the matching tool exposes (never an arbitrary RouterOS option).
 */
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { commandUnsupported, isEmpty, looksLikeError, quoteValue, Cmd } from "../core/routeros";
import { parseKeyValues, parseRecords } from "../core/routeros-parse";

export const UM_NOT_AVAILABLE =
  "User Manager is not available on this device (the user-manager package is not installed).";

/** A parsed RouterOS record (string values), with secrets already redacted. */
export type AaaRow = Record<string, string>;

/** Result of a mutation, shared by the dashboard (JSON) and the view. */
export interface OpResult {
  ok: boolean;
  message: string;
}

/** A read returning rows plus whether the backing package/menu is available. */
export interface AaaList {
  available: boolean;
  rows: AaaRow[];
}

/** RouterOS attribute keys whose values must never be shown to a UI. */
const SECRET_KEYS = new Set(["secret", "password", "shared-secret", "otp-secret"]);
const REDACTED = "••••••";

/** The AAA entities this layer manages — menu path, stable id key, capabilities. */
export interface AaaEntity {
  /** RouterOS menu path, e.g. `user-manager user`. */
  menu: string;
  /** Stable identifier column used to locate a row for mutation. */
  key: ".id" | "name";
  /** Whitelisted attribute keys settable via add/update. */
  fields: string[];
  /** Whether enable/disable (a `disabled` toggle) applies. */
  toggle?: boolean;
  /** Read-only entities (e.g. accounting sessions) reject mutations. */
  readonly?: boolean;
  /** True for User Manager menus (so a missing package is reported nicely). */
  um?: boolean;
}

const RADIUS_FIELDS = [
  "address",
  "secret",
  "service",
  "authentication-port",
  "accounting-port",
  "timeout",
  "src-address",
  "realm",
  "called-id",
  "domain",
  "protocol",
  "certificate",
  "accounting-backup",
  "comment",
  "disabled",
];

const UM_USER_FIELDS = [
  "name",
  "password",
  "group",
  "shared-users",
  "attributes",
  "caller-id",
  "otp-secret",
  "comment",
  "disabled",
];

const UM_PROFILE_FIELDS = [
  "name",
  "name-for-users",
  "validity",
  "price",
  "starts-when",
  "override-shared-users",
  "comment",
];

const UM_ROUTER_FIELDS = [
  "name",
  "address",
  "shared-secret",
  "coa-port",
  "protocol",
  "comment",
  "disabled",
];

const UM_LIMITATION_FIELDS = [
  "name",
  "rate-limit-rx",
  "rate-limit-tx",
  "rate-limit-min-rx",
  "rate-limit-min-tx",
  "rate-limit-burst-rx",
  "rate-limit-burst-tx",
  "rate-limit-burst-threshold-rx",
  "rate-limit-burst-threshold-tx",
  "rate-limit-burst-time-rx",
  "rate-limit-burst-time-tx",
  "rate-limit-priority",
  "download-limit",
  "upload-limit",
  "transfer-limit",
  "uptime-limit",
  "reset-counters-interval",
  "reset-counters-start-time",
  "comment",
];

/** Registry of every manageable AAA entity, keyed by the REST/UI slug. */
export const AAA_ENTITIES: Record<string, AaaEntity> = {
  radius: { menu: "radius", key: ".id", fields: RADIUS_FIELDS, toggle: true },
  "um-users": {
    menu: "user-manager user",
    key: "name",
    fields: UM_USER_FIELDS,
    toggle: true,
    um: true,
  },
  "um-profiles": { menu: "user-manager profile", key: "name", fields: UM_PROFILE_FIELDS, um: true },
  "um-user-profiles": {
    menu: "user-manager user-profile",
    key: ".id",
    fields: ["user", "profile"],
    um: true,
  },
  "um-routers": {
    menu: "user-manager router",
    key: "name",
    fields: UM_ROUTER_FIELDS,
    toggle: true,
    um: true,
  },
  "um-limitations": {
    menu: "user-manager limitation",
    key: "name",
    fields: UM_LIMITATION_FIELDS,
    um: true,
  },
  "um-sessions": { menu: "user-manager session", key: ".id", fields: [], readonly: true, um: true },
};

/** Redact secret-bearing columns in a parsed row for safe display. */
function redactRow(r: AaaRow): AaaRow {
  const out: AaaRow = {};
  for (const [k, v] of Object.entries(r)) out[k] = SECRET_KEYS.has(k) && v ? REDACTED : v;
  return out;
}

/**
 * The ordered list of stable `.id`s for a menu (matches `print` order), via
 * `:put [/<menu> find]`. RouterOS `print detail` doesn't surface `.id`, so we
 * fetch it separately and zip by position — `find` and `print` iterate the same
 * internal list in the same order.
 */
async function idsFor(menu: string, ctx: ToolContext): Promise<string[]> {
  const out = await executeMikrotikCommand(`:put [/${menu} find]`, ctx);
  if (looksLikeError(out) || commandUnsupported(out)) return [];
  return out
    .trim()
    .split(/[;\s]+/)
    .filter(Boolean);
}

/** Build a `[find <key>=<value>]` selector with the value safely quoted. */
function findClause(entity: AaaEntity, id: string): string {
  return `[find ${entity.key}=${quoteValue(id)}]`;
}

/** Reject a slug we don't manage (defence-in-depth for the REST layer). */
function entityFor(slug: string): AaaEntity {
  const e = AAA_ENTITIES[slug];
  if (!e) throw new Error(`Unknown AAA entity '${slug}'.`);
  return e;
}

/** List an entity's rows (with stable `.id` + redacted secrets). */
export async function listAaaEntity(ctx: ToolContext, slug: string): Promise<AaaList> {
  const entity = entityFor(slug);
  const out = await executeMikrotikCommand(`/${entity.menu} print detail`, ctx);
  if (commandUnsupported(out)) return { available: false, rows: [] };
  if (looksLikeError(out))
    throw new Error("Router rejected the AAA read. Check permissions and connectivity.");
  if (isEmpty(out)) return { available: true, rows: [] };
  const rows = parseRecords(out).rows;
  // Attach the stable `.id` (zipped by print order) unless the parser already
  // captured one, then redact any secret columns.
  const ids = await idsFor(entity.menu, ctx);
  return {
    available: true,
    rows: rows.map((r, i) => redactRow({ ...r, ".id": r[".id"] ?? ids[i] ?? "" })),
  };
}

/** Keep only whitelisted, non-empty attribute keys for an entity. */
function pickFields(entity: AaaEntity, fields: AaaRow): [string, string][] {
  return entity.fields
    .filter((k) => fields[k] !== undefined && fields[k] !== "")
    .map((k) => [k, fields[k]] as [string, string]);
}

function applyFields(cmd: Cmd, pairs: [string, string][]): Cmd {
  for (const [k, v] of pairs) cmd.set(k, v);
  return cmd;
}

/** Create a row from whitelisted fields. */
export async function addAaaEntity(
  ctx: ToolContext,
  slug: string,
  fields: AaaRow,
): Promise<OpResult> {
  const entity = entityFor(slug);
  if (entity.readonly) return { ok: false, message: `${slug} is read-only.` };
  const pairs = pickFields(entity, fields);
  if (pairs.length === 0) return { ok: false, message: "No fields supplied." };
  const cmd = applyFields(new Cmd(`/${entity.menu} add`), pairs).build();
  const out = await executeMikrotikCommand(cmd, ctx);
  if (commandUnsupported(out)) return { ok: false, message: UM_NOT_AVAILABLE };
  if (looksLikeError(out)) return { ok: false, message: out.trim() };
  return { ok: true, message: "Created." };
}

/** Update a row located by its stable id. */
export async function updateAaaEntity(
  ctx: ToolContext,
  slug: string,
  id: string,
  fields: AaaRow,
): Promise<OpResult> {
  const entity = entityFor(slug);
  if (entity.readonly) return { ok: false, message: `${slug} is read-only.` };
  const pairs = pickFields(entity, fields);
  if (pairs.length === 0) return { ok: false, message: "No updates supplied." };
  const cmd = applyFields(new Cmd(`/${entity.menu} set ${findClause(entity, id)}`), pairs).build();
  const out = await executeMikrotikCommand(cmd, ctx);
  if (commandUnsupported(out)) return { ok: false, message: UM_NOT_AVAILABLE };
  if (looksLikeError(out)) return { ok: false, message: out.trim() };
  return { ok: true, message: "Updated." };
}

/** Permanently remove a row located by its stable id (existence-checked). */
export async function removeAaaEntity(
  ctx: ToolContext,
  slug: string,
  id: string,
): Promise<OpResult> {
  const entity = entityFor(slug);
  if (entity.readonly) return { ok: false, message: `${slug} is read-only.` };
  const count = await executeMikrotikCommand(
    `/${entity.menu} print count-only where ${entity.key}=${quoteValue(id)}`,
    ctx,
  );
  if (commandUnsupported(count)) return { ok: false, message: UM_NOT_AVAILABLE };
  if (count.trim() === "0") return { ok: false, message: `${slug} '${id}' not found.` };
  const out = await executeMikrotikCommand(`/${entity.menu} remove ${findClause(entity, id)}`, ctx);
  if (looksLikeError(out)) return { ok: false, message: out.trim() };
  return { ok: true, message: "Removed." };
}

/** Enable/disable a row via its `disabled` flag (works for every togglable menu). */
export async function toggleAaaEntity(
  ctx: ToolContext,
  slug: string,
  id: string,
  enable: boolean,
): Promise<OpResult> {
  const entity = entityFor(slug);
  if (!entity.toggle) return { ok: false, message: `${slug} cannot be enabled/disabled.` };
  const cmd = new Cmd(`/${entity.menu} set ${findClause(entity, id)}`)
    .set("disabled", enable ? "no" : "yes")
    .build();
  const out = await executeMikrotikCommand(cmd, ctx);
  if (commandUnsupported(out)) return { ok: false, message: UM_NOT_AVAILABLE };
  if (looksLikeError(out)) return { ok: false, message: out.trim() };
  return { ok: true, message: enable ? "Enabled." : "Disabled." };
}

// ── Singletons: RADIUS incoming (CoA) + User Manager settings ────────────────

/** Parse RouterOS singleton settings (`key: value`) into one redacted row. */
function parseSingleton(out: string): AaaRow {
  return redactRow(parseKeyValues(out));
}

export async function getRadiusIncoming(ctx: ToolContext): Promise<AaaRow> {
  const out = await executeMikrotikCommand("/radius incoming print", ctx);
  if (looksLikeError(out)) throw new Error("Unable to read RADIUS incoming settings.");
  return parseSingleton(out);
}

export async function setRadiusIncoming(ctx: ToolContext, fields: AaaRow): Promise<OpResult> {
  const cmd = new Cmd("/radius incoming set");
  if (fields.accept !== undefined && fields.accept !== "") cmd.set("accept", fields.accept);
  if (fields.port !== undefined && fields.port !== "") cmd.set("port", fields.port);
  const built = cmd.build();
  if (!built.includes("=")) return { ok: false, message: "No updates supplied." };
  const out = await executeMikrotikCommand(built, ctx);
  if (looksLikeError(out)) return { ok: false, message: out.trim() };
  return { ok: true, message: "RADIUS incoming (CoA) updated." };
}

export async function resetRadiusCounters(ctx: ToolContext): Promise<OpResult> {
  const out = await executeMikrotikCommand("/radius reset-counters", ctx);
  if (looksLikeError(out)) return { ok: false, message: out.trim() };
  return { ok: true, message: "RADIUS counters reset." };
}

export async function getUmSettings(
  ctx: ToolContext,
): Promise<{ available: boolean; settings: AaaRow }> {
  const out = await executeMikrotikCommand("/user-manager print", ctx);
  if (commandUnsupported(out)) return { available: false, settings: {} };
  if (looksLikeError(out)) throw new Error("Unable to read User Manager settings.");
  return { available: true, settings: parseSingleton(out) };
}

const UM_SETTINGS_FIELDS = [
  "enabled",
  "certificate",
  "radsec-certificate",
  "accounting-port",
  "authentication-port",
  "use-profiles",
];

export async function setUmSettings(ctx: ToolContext, fields: AaaRow): Promise<OpResult> {
  const cmd = new Cmd("/user-manager set");
  let any = false;
  for (const k of UM_SETTINGS_FIELDS) {
    if (fields[k] !== undefined && fields[k] !== "") {
      cmd.set(k, fields[k]);
      any = true;
    }
  }
  if (!any) return { ok: false, message: "No updates supplied." };
  const out = await executeMikrotikCommand(cmd.build(), ctx);
  if (commandUnsupported(out)) return { ok: false, message: UM_NOT_AVAILABLE };
  if (looksLikeError(out)) return { ok: false, message: out.trim() };
  return { ok: true, message: "User Manager settings updated." };
}
