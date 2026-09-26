/**
 * Persistence helpers for the dashboard's Config Studio — turning an edited,
 * redacted config object back into a file on disk, safely.
 *
 * The browser only ever sees a **redacted** config (secrets shown as the
 * {@link REDACTED} sentinel — see `src/observability/event.ts`). So before we
 * write, {@link mergeSecrets} walks the incoming object and restores every
 * untouched sentinel from the real in-memory config; a value the user actually
 * typed (anything other than the sentinel) is taken as a deliberate change.
 * This lets the config round-trip through the browser without ever exposing or
 * losing a secret.
 *
 * The `mergeSecrets`/`serializeConfig`/`backupName` helpers are pure and unit
 * tested; `atomicWrite` is the only side-effecting one (temp file + rename).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REDACTED } from "./observability/event";
import { CREDENTIAL_SOURCE } from "./config-device-draft";

/** Relative path used as the `$schema` pointer in written config files. */
const SCHEMA_REF = "./schemas/config.schema.json";

type Json = unknown;

/**
 * Deep-merge `incoming` over `current`, but only to **restore secrets**: wherever
 * `incoming` still holds the redaction sentinel, substitute the real value from
 * `current` at the same path. Every other value in `incoming` wins verbatim, so
 * structural edits (added/removed devices, changed ports, new typed secrets) are
 * preserved exactly. Returns a fresh object; neither input is mutated.
 */
export function mergeSecrets(incoming: Json, current: Json): Json {
  if (incoming === REDACTED) {
    // The user left a secret untouched → restore the real one (or drop the
    // sentinel entirely if we have nothing to restore).
    return typeof current === "string" ? current : undefined;
  }
  if (Array.isArray(incoming)) {
    const cur = Array.isArray(current) ? current : [];
    return incoming.map((v, i) => mergeSecrets(v, cur[i]));
  }
  if (incoming && typeof incoming === "object") {
    const curObj =
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, Json>)
        : {};
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, Json>)) {
      const merged = mergeSecrets(v, curObj[k]);
      // Drop keys that resolved to `undefined` (a sentinel with nothing behind
      // it) so we never persist a literal "«redacted»" or a stray undefined.
      if (merged !== undefined) out[k] = merged;
    }
    return out;
  }
  return incoming;
}

/** Restore copied/renamed device secrets without sending plaintext credentials to the browser. */
export function mergeDeviceDraft(
  incoming: unknown,
  name: string,
  devices: Record<string, unknown>,
): unknown {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const { [CREDENTIAL_SOURCE]: source, ...draft } = incoming as Record<string, unknown>;
  if (source !== undefined && (typeof source !== "string" || !Object.hasOwn(devices, source)))
    throw new Error(
      "Credential source is unavailable. Reopen the editor or enter new credentials.",
    );
  const key = typeof source === "string" ? source : name;
  return mergeSecrets(draft, Object.hasOwn(devices, key) ? devices[key] : undefined);
}

/** Same resolver for validation, preview and saving, preserving incoming device order. */
export function mergeConfigDraft(incoming: unknown, current: unknown): unknown {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const draft = incoming as Record<string, unknown>;
  if (!draft.devices || typeof draft.devices !== "object" || Array.isArray(draft.devices))
    return mergeSecrets(incoming, current);
  const { devices: _devices, ...rest } = draft;
  const currentDevices = (current as { devices?: Record<string, unknown> } | null)?.devices ?? {};
  return {
    ...(mergeSecrets(rest, current) as Record<string, unknown>),
    devices: Object.fromEntries(
      Object.entries(draft.devices).map(([name, device]) => [
        name,
        mergeDeviceDraft(device, name, currentDevices),
      ]),
    ),
  };
}

/**
 * Pretty-print a config object as the bytes to write, prefixed with a `$schema`
 * pointer so the file also gets IDE autocomplete when edited by hand later. A
 * pre-existing `$schema` key is replaced (not duplicated).
 */
export function serializeConfig(config: Json): string {
  const body =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, Json>)
      : {};
  const { $schema: _drop, ...rest } = body;
  return `${JSON.stringify({ $schema: SCHEMA_REF, ...rest }, null, 2)}\n`;
}

/** Backup file name for `path` at epoch-ms `ts`, e.g. `config.json.bak-1700000000000`. */
export function backupName(path: string, ts: number): string {
  return `${path}.bak-${ts}`;
}

/**
 * Write `text` to `path` atomically: write a sibling temp file then `rename` it
 * over the target (rename is atomic on the same filesystem), so a crash mid-write
 * never leaves a half-written config. Creates the parent directory if needed.
 */
export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
