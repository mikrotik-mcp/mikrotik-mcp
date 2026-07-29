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
async function tryRest(command: string, dc: DeviceConfig, name: string): Promise<string | null> {
  // Cheap check first: an unmappable command never opens a connection.
  if (!toRequest(command)) {
    logger.debug(`[rest] no mapping for '${command}' on '${name}' — using SSH`);
    return null;
  }

  const client = createRestClient(dc);
  if (!(await client.connect())) {
    logger.debug(`[rest] probe failed on '${name}' (${client.lastError}) — using SSH`);
    return null;
  }
  try {
    return await client.run(command);
  } catch (e) {
    if (!shouldFallbackToSsh(e)) {
      // The device answered with a rejection. Surface it rather than masking it
      // behind a second attempt over a different transport.
      throw e instanceof RestHttpError
        ? new Error(`REST ${e.status} on '${name}': ${e.detail}`)
        : e;
    }
    logger.debug(
      `[rest] falling back to SSH for '${command}' on '${name}': ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  } finally {
    client.disconnect();
  }
}

async function runOnce(
  command: string,
  deviceName?: string,
  opts?: { maxMs?: number },
): Promise<string> {
  const name = resolveDeviceName(deviceName);
  const dc = getDevice(deviceName);

  // REST first when the device opts in. Reached only outside Safe Mode: an
  // active Safe Mode session is routed by executeMikrotikCommand before this
  // function is called, which is what keeps Safe Mode SSH-only.
  if (isRestDevice(dc)) {
    const out = await tryRest(command, dc, name);
    if (out !== null) return out;
  }

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
    return safe.execute(command);
  }
  ctx.info(`[${deviceName}] Executing MikroTik command: ${command}`);
  return runOnce(command, ctx.device, opts);
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
