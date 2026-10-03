/**
 * Shared safe-apply state machine for Config Studio and MCP host settings tools.
 *
 * Saving a config is risky: one bad device entry or a typo in the dashboard's
 * own bind address can lock you out with the server none the wiser. So writes go
 * through a RouterOS-Safe-Mode-style ritual: back up the current file, write the
 * new one, hot-swap the in-memory config, and **arm a rollback timer**. The
 * dashboard must confirm ("keep") within `rollbackMs`; if it doesn't — because
 * you locked yourself out, or the browser lost the server — the timer fires and
 * everything reverts to the backup.
 *
 * All I/O (filesystem, clock, timers, the runtime config) is injected, so the
 * machine is unit-tested with fakes — no real files, no real `setTimeout`.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getConfigSource, MikrotikConfigSchema } from "../config";
import type { ConfigSource, MikrotikConfig } from "../config";
import { atomicWrite, backupName, serializeConfig } from "../config-write";
import { getConfig, setConfig } from "../core/runtime";
import { logger } from "../logger";

/** A single validation problem, addressed by its dotted JSON path. */
export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ConfigIssue[];
  /** The parsed, default-applied config when `ok`. */
  value?: MikrotikConfig;
}

/**
 * Validate an arbitrary object against the authoritative Zod config schema,
 * flattening any issues to `{ path, message }`. This is the SAME schema
 * `loadConfig` uses, so the editor can never accept something the server would
 * later reject.
 */
export function validateConfig(raw: unknown): ValidationResult {
  const r = MikrotikConfigSchema.safeParse(raw);
  if (r.success) return { ok: true, errors: [], value: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    })),
  };
}

/** Injected side-effecting dependencies (real ones in prod, fakes in tests). */
export interface AdminDeps {
  getConfig: () => MikrotikConfig;
  setConfig: (c: MikrotikConfig) => void;
  source: () => ConfigSource;
  /** Read a file's text, or null when it doesn't exist. Other errors must throw. */
  readFile: (path: string) => string | null;
  /** Persist text to a path (atomic rename, or backed-up in-place for a file mount). */
  writeText: (path: string, text: string) => void;
  now: () => number;
  /** Schedule `fn` after `ms`; returns an opaque handle for {@link AdminDeps.cancel}. */
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface ApplyResult {
  pendingId: string;
  rollbackMs: number;
  path: string;
  fromFile: boolean;
  backupPath: string;
  expiresAt: number | null;
}

interface Pending {
  id: string;
  backupPath: string;
  /** In-memory config to restore on rollback. */
  previous: MikrotikConfig;
  timer: unknown;
  rollbackMs: number;
  path: string;
  revision: string;
}

export interface ConfigAdmin {
  /** Back up, write `parsed`, hot-swap, and arm rollback (0 ⇒ no timer). */
  applyConfig: (parsed: MikrotikConfig, rollbackMs: number) => ApplyResult;
  /** Confirm a pending apply, cancelling its rollback timer. */
  keepConfig: (id: string) => boolean;
  /** Revert a pending apply to its backup now. Also fired automatically on timeout. */
  rollback: (id: string) => boolean;
  /** A timed change requiring confirmation; immediate saves do not block later edits. */
  pendingId: () => string | null;
  /** Opaque revision of both runtime settings and the source file. */
  revision: () => string;
}

/** Build a config-admin bound to the given dependencies. */
export function createConfigAdmin(deps: AdminDeps): ConfigAdmin {
  // ponytail: coordination is process-local; use a file lock if multiple MCP processes must write concurrently.
  let pending: Pending | null = null;
  let lastTimestamp = 0;
  const salt = randomUUID();
  const fingerprint = (
    config: MikrotikConfig,
    source: ConfigSource,
    contents: string | null,
  ): string =>
    createHash("sha256")
      .update(salt)
      .update(JSON.stringify([config, source, contents]))
      .digest("hex");
  const revision = (): string => {
    const source = deps.source();
    return fingerprint(deps.getConfig(), source, deps.readFile(source.path));
  };

  const currentPending = (): Pending | null => {
    if (pending && pending.revision !== revision()) {
      deps.cancel(pending.timer);
      pending = null;
      logger.warn(
        "Config changed outside its pending transaction; preserved newer settings. Backup retained.",
      );
    }
    return pending;
  };

  const rollback = (id: string): boolean => {
    const active = currentPending();
    if (!active || active.id !== id) return false;
    const { backupPath, previous, timer, path } = active;
    const backup = deps.readFile(backupPath);
    if (backup == null)
      throw new Error("Configuration backup is unavailable; rollback was not applied.");
    deps.writeText(path, backup);
    deps.setConfig(previous);
    deps.cancel(timer);
    pending = null;
    return true;
  };

  const applyConfig = (parsed: MikrotikConfig, rollbackMs: number): ApplyResult => {
    if ((currentPending()?.rollbackMs ?? 0) > 0)
      throw new Error(
        "Another configuration change awaits confirmation. Keep or roll it back first.",
      );

    const src = deps.source();
    const previous = deps.getConfig();
    const ts = Math.max(deps.now(), lastTimestamp + 1);
    lastTimestamp = ts;
    const id = `cfg_${ts}`;

    // Back up whatever is on disk now (or the serialized in-memory config when
    // no file exists yet), then write the new config and hot-swap it live.
    const backupPath = backupName(src.path, ts);
    const existing = deps.readFile(src.path) ?? serializeConfig(previous);
    const contents = serializeConfig(parsed);
    const nextRevision = fingerprint(parsed, src, contents);
    deps.writeText(backupPath, existing);
    deps.writeText(src.path, contents);
    deps.setConfig(parsed);

    const timer =
      rollbackMs > 0
        ? deps.schedule(() => {
            try {
              rollback(id);
            } catch {
              logger.error(
                "Configuration auto-rollback failed; backup retained. Retry rollback or restore it manually.",
              );
            }
          }, rollbackMs)
        : null;
    pending = {
      id,
      backupPath,
      previous,
      timer,
      rollbackMs,
      path: src.path,
      revision: nextRevision,
    };
    return {
      pendingId: id,
      rollbackMs,
      path: src.path,
      fromFile: src.fromFile,
      backupPath,
      expiresAt: rollbackMs > 0 ? deps.now() + rollbackMs : null,
    };
  };

  const keepConfig = (id: string): boolean => {
    const active = currentPending();
    if (!active || active.id !== id) return false;
    deps.cancel(active.timer);
    pending = null;
    return true;
  };

  return {
    applyConfig,
    keepConfig,
    rollback,
    pendingId: () => {
      const active = currentPending();
      return active && active.rollbackMs > 0 ? active.id : null;
    },
    revision,
  };
}

let sharedAdmin: ConfigAdmin | undefined;

/** One host-side transaction coordinator, shared by dashboard and MCP tools (also without a dashboard). */
export function getConfigAdmin(): ConfigAdmin {
  return (sharedAdmin ??= createConfigAdmin({
    getConfig,
    setConfig,
    source: getConfigSource,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(
          "Cannot read the MCP configuration file; check host-side file permissions.",
        );
      }
    },
    writeText: atomicWrite,
    now: Date.now,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (timer) => {
      if (timer) clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
  }));
}
