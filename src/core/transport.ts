/**
 * Transport selection for a device — the single place that decides SSH vs.
 * MAC-Telnet.
 *
 * A device reached by `mac` (Layer-2, no IP) uses {@link MikroTikMacTelnetClient};
 * everything else uses {@link MikroTikSSHClient}. Both expose the same
 * `connect/run/disconnect/lastError` shape ({@link DeviceClient}), so every
 * caller — the command choke point, the CLI auth probe, the dashboard health
 * check — selects a transport here rather than re-deciding (and defaulting a
 * MAC device to `127.0.0.1:22`).
 */
import type { DeviceConfig } from "../config";
import { MikroTikMacTelnetClient } from "../mac-telnet/client";
import { MikroTikRestClient } from "../rest/client";
import { MikroTikSSHClient } from "../ssh/client";
import type { SSHClientOptions } from "../ssh/client";
import { getDevice } from "./runtime";

/** The minimal client surface shared by the SSH and MAC-Telnet transports. */
export interface DeviceClient {
  /** Establish the connection. Resolves true on success, false on failure. */
  connect(): Promise<boolean>;
  /**
   * Run one command and return its decoded output. `opts.maxMs` caps how long to
   * wait for the channel to close before stopping the command and returning
   * whatever streamed — needed for interactive tools (`/ping`, bandwidth-test)
   * that never emit a clean close over a non-interactive channel.
   */
  run(command: string, opts?: { maxMs?: number }): Promise<string>;
  /** Close the connection. Safe to call multiple times. */
  disconnect(): void;
  /** Human-readable reason the last `connect()` failed, if it did. */
  lastError?: string;
}

/** True when this device config selects the MAC-Telnet transport. */
export function isMacTelnetDevice(dc: DeviceConfig): dc is DeviceConfig & { mac: string } {
  return Boolean(dc.mac);
}

/**
 * True when this device opts into the REST API.
 *
 * MAC-Telnet wins: a device addressed by MAC has no routable IP for HTTPS to
 * reach, so `mac` and `api` together can only mean MAC-Telnet.
 */
export function isRestDevice(dc: DeviceConfig): boolean {
  return Boolean(dc.api) && !dc.mac;
}

/** A REST client for a device, for the one-shot REST attempt in `runOnce`. */
export function createRestClient(dc: DeviceConfig): MikroTikRestClient {
  return new MikroTikRestClient({
    host: dc.host,
    username: dc.username,
    password: dc.password,
    port: dc.apiPort,
    insecureTls: dc.apiInsecureTls,
    timeoutMs: dc.timeoutMs,
  });
}

/** The SSH connection options for a device (no jump), used as one chain hop. */
export function sshOptionsOf(dc: DeviceConfig): SSHClientOptions {
  return {
    host: dc.host,
    username: dc.username,
    password: dc.password,
    keyFilename: dc.keyFilename,
    privateKey: dc.privateKey,
    keyPassphrase: dc.keyPassphrase,
    port: dc.port,
    timeoutMs: dc.timeoutMs,
  };
}

/**
 * Resolve a device's bastion into the SSH client's `jump` option, recursively
 * so a chain (`jumpVia` → `jumpVia` → …) is followed. An inline `jumpHost`
 * wins; otherwise `jumpVia` references another configured device by name. Guards
 * against a cycle and against using a MAC-Telnet device as a bastion (a jump
 * needs SSH TCP forwarding, which Layer-2 MAC-Telnet has no notion of).
 */
export function resolveJump(
  dc: DeviceConfig,
  seen: Set<string> = new Set(),
): SSHClientOptions | undefined {
  if (dc.jumpHost) {
    return {
      host: dc.jumpHost.host,
      port: dc.jumpHost.port,
      username: dc.jumpHost.username,
      password: dc.jumpHost.password,
      keyFilename: dc.jumpHost.keyFilename,
      privateKey: dc.jumpHost.privateKey,
      keyPassphrase: dc.jumpHost.keyPassphrase,
      timeoutMs: dc.jumpHost.timeoutMs,
    };
  }
  if (!dc.jumpVia) return undefined;
  if (seen.has(dc.jumpVia)) {
    throw new Error(
      `SSH jump-host cycle detected at '${dc.jumpVia}' (a device can't jump through itself).`,
    );
  }
  seen.add(dc.jumpVia);
  const bastion = getDevice(dc.jumpVia);
  if (isMacTelnetDevice(bastion)) {
    throw new Error(
      `Jump host '${dc.jumpVia}' is a MAC-Telnet device; an SSH bastion must be reachable over SSH.`,
    );
  }
  return { ...sshOptionsOf(bastion), jump: resolveJump(bastion, seen) };
}

/** Build the right transport client for a device config. */
export function createDeviceClient(dc: DeviceConfig): DeviceClient {
  if (isMacTelnetDevice(dc)) {
    return new MikroTikMacTelnetClient({
      mac: dc.mac,
      username: dc.username,
      password: dc.password,
      sourceMac: dc.sourceMac,
      host: dc.macHost,
      port: dc.macPort,
      timeoutMs: dc.timeoutMs,
    });
  }

  return new MikroTikSSHClient({ ...sshOptionsOf(dc), jump: resolveJump(dc) });
}

/** How a device is addressed, for logs/errors (e.g. `MAC 48:…` or `1.2.3.4:22`). */
export function describeTransport(dc: DeviceConfig): string {
  return dc.mac ? `MAC ${dc.mac} (mac-telnet)` : `${dc.host}:${dc.port}`;
}

/** A connection-failure message tailored to the transport. */
export function connectErrorMessage(name: string, dc: DeviceConfig, lastError?: string): string {
  const reason = lastError ? ` — ${lastError}` : "";
  if (dc.mac) {
    return (
      `Failed to connect to MikroTik device '${name}' over MAC-Telnet at ${dc.mac}${reason}. ` +
      "Check you are on the same Layer-2 segment, MAC-Telnet is enabled (/tool mac-server) on a reachable interface, and the credentials are correct."
    );
  }
  const authMode =
    dc.keyFilename || dc.privateKey ? "SSH key" : dc.password ? "password" : "no credentials";
  return (
    `Failed to connect to MikroTik device '${name}' at ${dc.host}:${dc.port} (auth: ${authMode})${reason}. ` +
    "Check the host/port are reachable, the SSH service is enabled (/ip service), and the credentials are correct."
  );
}
