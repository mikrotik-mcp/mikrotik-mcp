/**
 * The single choke point through which every tool talks to the device.
 *
 * Centralising command execution here means all 169 tools inherit the same
 * connection handling, error surfacing, and — crucially — Safe Mode routing:
 * when Safe Mode is active, the command is sent through the persistent
 * interactive session so it runs inside that transactional context; otherwise a
 * fresh one-shot SSH channel is opened, used, and closed.
 */
import type { ToolContext } from "./context";
import { isPoolEnabled, runPooled } from "./connection-pool";
import { resolveDeviceName, getDevice } from "./runtime";
import {
  connectErrorMessage,
  createDeviceClient,
  createRestClient,
  isMacTelnetDevice,
  isRestDevice,
  resolveJump,
  sshOptionsOf,
} from "./transport";
import { getSafeModeManager } from "../ssh/safe-mode";
import { MikroTikSSHClient } from "../ssh/client";
import { toRequest } from "../rest/bridge";
import { parseRecords } from "./routeros-parse";
import type { ParsedRecords } from "./routeros-parse";
import { RestHttpError, shouldFallbackToSsh } from "../rest/client";
import type { DeviceConfig } from "../config";
import { logger } from "../logger";

/**
 * Try the command over REST, returning null when the caller should fall back to
 * SSH. Never throws for a fallback-worthy condition; DOES throw for a genuine
 * device-side rejection.
 *
 * The distinction is the whole point. Falling back on a 400 ("bad parameter")
 * would re-run a malformed command over SSH and surface a second, differently
 * worded failure — the operator then debugs the wrong transport. Falling back on
 * a 404 is right, because that means the menu does not exist on this RouterOS
 * version and SSH may well handle it.
 */
async function tryRest(
  command: string,
  dc: DeviceConfig,
  name: string,
  ctx?: ToolContext,
): Promise<string | null> {
  // Every fallback records WHY on the context. A silent fallback is
  // indistinguishable from REST never being enabled, which makes an
  // enabled-but-never-used transport impossible to diagnose.
  const fallback = (reason: string): null => {
    if (ctx) ctx.restFallback = reason;
    logger.debug(`[rest] falling back to SSH for '${command}' on '${name}': ${reason}`);
    return null;
  };

  // Cheap check first: an unmappable command never opens a connection.
  if (!toRequest(command)) return fallback("no REST mapping for this command");

  const client = createRestClient(dc);
  if (!(await client.connect())) return fallback(client.lastError ?? "REST probe failed");

  try {
    const out = await client.run(command);
    if (ctx) {
      ctx.transport = "rest";
      ctx.restFallback = undefined;
    }
    return out;
  } catch (e) {
    if (!shouldFallbackToSsh(e)) {
      // The device answered with a rejection. Surface it rather than masking it
      // behind a second attempt over a different transport.
      if (ctx) ctx.transport = "rest";
      throw e instanceof RestHttpError
        ? new Error(`REST ${e.status} on '${name}': ${e.detail}`)
        : e;
    }
    return fallback(e instanceof Error ? e.message : String(e));
  } finally {
    client.disconnect();
  }
}

async function runOnce(
  command: string,
  deviceName?: string,
  opts?: { maxMs?: number },
  ctx?: ToolContext,
): Promise<string> {
  const name = resolveDeviceName(deviceName);
  const dc = getDevice(deviceName);

  // REST first when the device opts in. Reached only outside Safe Mode: an
  // active Safe Mode session is routed by executeMikrotikCommand before this
  // function is called, which is what keeps Safe Mode SSH-only.
  if (isRestDevice(dc)) {
    const out = await tryRest(command, dc, name, ctx);
    if (out !== null) return out;
  }
  if (ctx) ctx.transport = isMacTelnetDevice(dc) ? "mac-telnet" : "ssh";

  // Use the persistent connection pool for SSH devices when pooling is enabled.
  // MAC-Telnet has no SSH transport to pool; the one-shot path handles it.
  if (!isMacTelnetDevice(dc) && isPoolEnabled()) {
    return runPooled(command, name, opts);
  }

  // One-shot: create, connect, run, disconnect. Used for MAC-Telnet devices and
  // when connection pooling is disabled.
  const client = createDeviceClient(dc);
  try {
    if (!(await client.connect())) {
      throw new Error(connectErrorMessage(name, dc, client.lastError));
    }
    return await client.run(command, opts);
  } finally {
    client.disconnect();
  }
}

/**
 * Execute a RouterOS command and return its raw text output.
 *
 * The target device is taken from `ctx.device` (set by the registry from the
 * tool call's `device` argument); when unset, the configured default is used.
 * Safe Mode is tracked per device, so each router has its own session.
 *
 * @param command  Fully-formed RouterOS CLI command (e.g. `/ip address print`).
 * @param ctx      Per-call context carrying the target device.
 * @param opts     `maxMs` caps the one-shot read for interactive/streaming
 *                 commands (ping, bandwidth-test) so they can't hang the tool.
 */
export async function executeMikrotikCommand(
  command: string,
  ctx: ToolContext,
  opts?: { maxMs?: number },
): Promise<string> {
  const deviceName = resolveDeviceName(ctx.device);
  const safe = getSafeModeManager(deviceName);

  // Transport/connection failures throw here and propagate to the registry,
  // which turns them into a proper `isError` tool result. Device-reported
  // command errors (syntax/failure) come back as normal output and are handled
  // by each tool via looksLikeError().
  if (safe.isActive) {
    ctx.info(`[${deviceName}] Executing (safe mode): ${command}`);
    // Safe Mode holds a persistent interactive SSH session — never REST.
    ctx.transport = "ssh";
    return safe.execute(command);
  }
  ctx.info(`[${deviceName}] Executing MikroTik command: ${command}`);
  return runOnce(command, ctx.device, opts, ctx);
}

/**
 * Execute a command and return it as **records** rather than console text.
 *
 * This is the structured entry point for tools written against typed data
 * instead of scraped output. It is transport-independent by construction:
 *
 * - Over **REST**, the JSON reply is used directly (values coerced to strings,
 *   so a tool cannot accidentally depend on `5` vs `"5"` and behave differently
 *   per transport).
 * - Over **SSH / MAC-Telnet**, the console text goes through the existing
 *   `parseRecords`, exactly as the auto-records MCP App view already does.
 *
 * The point is that a tool built on this renders the same output either way —
 * which is the property `tests/rest/parity.spec.ts` asserts.
 *
 * Prefer this for NEW read tools. Existing handlers keep using
 * `executeMikrotikCommand`; there is no reason to churn 819 of them.
 */
export async function executeMikrotikJson(
  command: string,
  ctx: ToolContext,
  opts?: { maxMs?: number },
): Promise<ParsedRecords> {
  const deviceName = resolveDeviceName(ctx.device);
  const dc = getDevice(deviceName);
  const safe = getSafeModeManager(deviceName);

  // Safe Mode and non-REST devices have no JSON to offer — parse the text.
  if (!safe.isActive && isRestDevice(dc)) {
    const req = toRequest(command);
    if (req) {
      const json = await tryRestJson(command, dc, deviceName, ctx);
      if (json !== null) return json;
    }
  }
  return parseRecords(await executeMikrotikCommand(command, ctx, opts));
}

/**
 * The REST half of {@link executeMikrotikJson} — returns records straight from
 * JSON, or null to fall back. Mirrors {@link tryRest}'s fallback contract
 * exactly, so the two entry points can never disagree about when REST is used.
 */
async function tryRestJson(
  command: string,
  dc: DeviceConfig,
  name: string,
  ctx: ToolContext,
): Promise<ParsedRecords | null> {
  const req = toRequest(command);
  if (!req) {
    ctx.restFallback = "no REST mapping for this command";
    return null;
  }
  const client = createRestClient(dc);
  if (!(await client.connect())) {
    ctx.restFallback = client.lastError ?? "REST probe failed";
    return null;
  }
  try {
    const rows = await client.runJson(command);
    ctx.transport = "rest";
    ctx.restFallback = undefined;
    return toRecords(rows);
  } catch (e) {
    if (!shouldFallbackToSsh(e)) {
      ctx.transport = "rest";
      throw e instanceof RestHttpError
        ? new Error(`REST ${e.status} on '${name}': ${e.detail}`)
        : e;
    }
    ctx.restFallback = e instanceof Error ? e.message : String(e);
    return null;
  } finally {
    client.disconnect();
  }
}

/**
 * JSON rows → {@link ParsedRecords}. Every value becomes a string so the shape
 * matches `parseRecords` exactly; a tool that switched on `typeof` would
 * otherwise behave differently per transport, which is the whole class of bug
 * this entry point exists to prevent.
 */
export function toRecords(rows: unknown): ParsedRecords {
  const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : [];
  const out = list.map((r, i) =>
    Object.fromEntries([
      // The console prints a row index and `parseRecords` surfaces it as `#`.
      // REST has no equivalent, so synthesise it from position — without this a
      // tool sees a different key set depending on the transport, which is
      // precisely the divergence this entry point exists to prevent.
      ["#", String(i)],
      ...Object.entries(r as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, typeof v === "string" ? v : String(v)] as const),
    ]),
  );
  const columns: string[] = [];
  for (const row of out)
    for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  return { format: out.length === 0 ? "empty" : "detail", columns, rows: out };
}

/**
 * Push a file's bytes onto the device filesystem over SFTP (RouterOS's SSH file
 * subsystem). Opens a dedicated SSH connection (file transfer is a separate
 * channel, not a CLI command, so it bypasses the command choke point above).
 * Throws a clear error for a MAC-Telnet device, which has no file transport.
 */
export async function uploadFileToDevice(
  deviceName: string | undefined,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  const name = resolveDeviceName(deviceName);
  const dc = getDevice(deviceName);
  if (isMacTelnetDevice(dc)) {
    throw new Error(
      `Cannot transfer a file to '${name}': it is reached over Layer-2 MAC-Telnet, which has no file ` +
        "transfer. Configure SSH (host + credentials) for this device, or have the router pull the file " +
        "itself with /tool fetch from a URL it can reach.",
    );
  }
  const ssh = new MikroTikSSHClient({ ...sshOptionsOf(dc), jump: resolveJump(dc) });
  if (!(await ssh.connect())) {
    throw new Error(connectErrorMessage(name, dc, ssh.lastError));
  }
  try {
    await ssh.uploadFile(remotePath, data);
  } finally {
    ssh.disconnect();
  }
}

/**
 * Pull a file's bytes from the device filesystem over SFTP. Opens a dedicated
 * SSH connection (like {@link uploadFileToDevice}, the transfer is its own
 * channel). Throws a clear error for a MAC-Telnet device, which has no SFTP.
 */
export async function downloadFileFromDevice(
  deviceName: string | undefined,
  remotePath: string,
): Promise<Buffer> {
  const name = resolveDeviceName(deviceName);
  const dc = getDevice(deviceName);
  if (isMacTelnetDevice(dc)) {
    throw new Error(
      `Cannot download a file from '${name}': it is reached over Layer-2 MAC-Telnet, which has no ` +
        "file transfer. Configure SSH (host + credentials) for this device, or use a text export " +
        "(stdout mode) instead of a binary backup.",
    );
  }
  const ssh = new MikroTikSSHClient({ ...sshOptionsOf(dc), jump: resolveJump(dc) });
  if (!(await ssh.connect())) {
    throw new Error(connectErrorMessage(name, dc, ssh.lastError));
  }
  try {
    return await ssh.downloadFile(remotePath);
  } finally {
    ssh.disconnect();
  }
}
