/**
 * SSH connection pool — keeps one persistent SSH connection per device and
 * reuses it across tool calls, opening a fresh exec channel for each command.
 *
 * Benefits:
 *   - Eliminates SSH handshake overhead (~200-500 ms per tool call).
 *   - Especially valuable through jump hosts (avoids double handshake).
 *   - SSH keepalive detects dead connections automatically.
 *
 * The pool is transparent: when disabled (`ssh.keepAlive = false`) or for
 * MAC-Telnet devices, the connector falls back to one-shot connections.
 *
 * Thread-safety: ssh2 multiplexes exec channels over a single TCP connection,
 * so concurrent `run()` calls on the same `MikroTikSSHClient` are safe — each
 * opens its own channel. The pool serialises `connect()` attempts per device
 * to avoid duplicate connections.
 */
import { MikroTikSSHClient } from "../ssh/client";
import type { DeviceConfig } from "../config";
import { logger } from "../logger";
import { getConfig, getDevice } from "./runtime";
import { DeviceConnectionError } from "./device-connection-error";
import { connectErrorMessage, resolveJump, sshOptionsOf } from "./transport";

// ── Pool entry ──────────────────────────────────────────────────────────────

interface PoolEntry {
  client: MikroTikSSHClient;
  config: DeviceConfig;
  jumpSignature: string;
  /** Number of exec channels currently running on this connection. */
  inflight: number;
  /** Fires after `idleTimeout` ms of inactivity to close the connection. */
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Marked true when the connection drops (keepalive failure, error, etc.). */
  dead: boolean;
}

// ── Module state ────────────────────────────────────────────────────────────

const entries = new Map<string, PoolEntry>();
/** Deduplicates concurrent `connect()` calls to the same device. */
const connecting = new Map<string, Promise<PoolEntry>>();

// ── Config helpers ──────────────────────────────────────────────────────────

/** Whether connection pooling is enabled in the current config. */
export function isPoolEnabled(): boolean {
  return getConfig().ssh.keepAlive;
}

function poolConfig(): {
  keepAliveInterval: number;
  keepAliveCountMax: number;
  idleTimeout: number;
} {
  const cfg = getConfig().ssh;
  return {
    keepAliveInterval: cfg.keepAliveInterval,
    keepAliveCountMax: 3,
    idleTimeout: cfg.idleTimeout,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function removeEntry(name: string): void {
  const entry = entries.get(name);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.dead = true;
  entry.client.disconnect();
  entries.delete(name);
  logger.info(`SSH pool: closed connection to '${name}'`);
}

function armIdle(name: string, entry: PoolEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (entry.inflight > 0 || entry.dead) return;
  const { idleTimeout } = poolConfig();
  entry.idleTimer = setTimeout(() => {
    logger.info(`SSH pool: closing idle connection to '${name}' (${idleTimeout / 1000}s idle)`);
    removeEntry(name);
  }, idleTimeout);
}

/** Whether an error message indicates a lost SSH connection. Never replay commands. */
function isConnectionError(msg: string): boolean {
  return /not connected|ECONNRESET|EPIPE|socket.*(close|end|destroy)|channel.*(close|open)|timed out.*handshake/i.test(
    msg,
  );
}

/** Open a fresh SSH connection for the given device and register it. */
async function doConnect(name: string): Promise<PoolEntry> {
  const dc = getDevice(name);
  const cfg = poolConfig();
  const jump = resolveJump(dc);
  const jumpSignature = JSON.stringify(jump);
  const client = new MikroTikSSHClient({
    ...sshOptionsOf(dc),
    jump,
    keepAliveInterval: cfg.keepAliveInterval,
    keepAliveCountMax: cfg.keepAliveCountMax,
  });

  if (!(await client.connect())) {
    throw new DeviceConnectionError(name, connectErrorMessage(name, dc, client.lastError));
  }
  try {
    if (dc !== getDevice(name) || jumpSignature !== JSON.stringify(resolveJump(dc))) {
      throw new Error(
        "Device configuration changed while connecting; retry with the current configuration.",
      );
    }
  } catch (error) {
    client.disconnect();
    throw error;
  }

  const entry: PoolEntry = {
    client,
    config: dc,
    jumpSignature,
    inflight: 0,
    idleTimer: undefined,
    dead: false,
  };
  entries.set(name, entry);
  logger.info(`SSH pool: opened persistent connection to '${name}'`);
  armIdle(name, entry);
  return entry;
}

/** Acquire a live pool entry for a device, connecting if necessary. */
async function acquire(name: string): Promise<PoolEntry> {
  // Return existing live entry.
  const existing = entries.get(name);
  const dc = getDevice(name);
  if (
    existing &&
    !existing.dead &&
    existing.client.isConnected !== false &&
    existing.config === dc &&
    existing.jumpSignature === JSON.stringify(resolveJump(dc))
  )
    return existing;

  // Remove dead entry.
  if (existing) removeEntry(name);

  // Dedup concurrent connect attempts to the same device.
  const pending = connecting.get(name);
  if (pending) return pending;

  const promise = doConnect(name);
  connecting.set(name, promise);
  try {
    return await promise;
  } catch (e) {
    removeEntry(name);
    throw e;
  } finally {
    connecting.delete(name);
  }
}

/** Run one command on a connected pool entry; manages inflight + idle. */
async function runOnEntry(
  name: string,
  command: string,
  opts?: { maxMs?: number },
): Promise<string> {
  const entry = await acquire(name);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  entry.inflight++;
  try {
    return await entry.client.run(command, opts);
  } finally {
    entry.inflight--;
    armIdle(name, entry);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a command on a pooled SSH connection. Opens a fresh exec channel on the
 * persistent connection. Dead sessions reconnect before dispatch; a failed
 * dispatched command is NEVER replayed (its result may be ambiguous).
 *
 * @param command    Fully-formed RouterOS CLI command.
 * @param deviceName Resolved device name (config key).
 * @param opts       `maxMs` caps the channel read for interactive commands.
 */
export async function runPooled(
  command: string,
  deviceName: string,
  opts?: { maxMs?: number },
): Promise<string> {
  try {
    return await runOnEntry(deviceName, command, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isConnectionError(msg)) throw e;

    // The next tool call can reconnect/fail over. This call may already have
    // executed on the router: an automatic retry could duplicate a mutation.
    logger.info(`SSH pool: connection to '${deviceName}' lost; command was not replayed`);
    removeEntry(deviceName);
    throw e;
  }
}

/** Close all pooled connections (call on process exit). */
export function closeAll(): void {
  for (const name of Array.from(entries.keys())) {
    removeEntry(name);
  }
}

/** Close a specific device's pooled connection. */
export function closeDevice(deviceName: string): void {
  removeEntry(deviceName);
}

/** Current pool status for debugging / observability. */
export function poolStatus(): Array<{
  device: string;
  inflight: number;
  idle: boolean;
  /** True when the connection dropped but the entry hasn't been cleaned up yet. */
  dead: boolean;
}> {
  return Array.from(entries, ([name, e]) => ({
    device: name,
    inflight: e.inflight,
    idle: e.inflight === 0 && !e.dead && e.client.isConnected !== false,
    dead: e.dead || e.client.isConnected === false,
  }));
}
