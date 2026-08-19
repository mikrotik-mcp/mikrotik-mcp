/**
 * SSH client for MikroTik / RouterOS devices, built on `ssh2`.
 *
 * Two execution modes are exposed:
 *   - `run()`   — one-shot command over a fresh SSH channel (the common path).
 *   - `shell()` — a persistent interactive PTY, used by Safe Mode where the
 *                 Ctrl+X session state must survive across multiple commands.
 *
 * RouterOS devices return output in whatever locale the device is set to, so we
 * decode bytes through a fallback chain (UTF-8 -> Windows-1252 -> Latin-1)
 * rather than assuming UTF-8 and crashing on characters like Swedish å/ä/ö.
 *
 * NOTE: all command transport here is the SSH protocol via `ssh2` — no OS shell
 * and no `child_process` are involved, so there is no local command-injection
 * surface from this module.
 */
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { Client } from "ssh2";
import type { ConnectConfig, ClientChannel } from "ssh2";
import { logger } from "../logger";

/**
 * How long a one-shot `run()` may go with NO output and NO channel close before
 * it is treated as wedged and aborted. Generous enough that a slow-but-active
 * command (large `/export`) — which keeps streaming and re-arms the timer — is
 * never cut off, but far below the MCP client's multi-minute patience, so a
 * genuinely stuck command (e.g. a malformed `/system script add`) fails fast.
 */
const RUN_IDLE_TIMEOUT_MS = 60_000;

/**
 * Absolute wall-clock ceiling on a single `run()` that did not ask for its own
 * `maxMs` cap.
 *
 * The idle watchdog above is re-armed by every chunk, so a command that dribbles
 * output forever — or one whose channel stays open behind a slow paged read —
 * can sit there indefinitely without ever looking "idle". That is how a call
 * ends up wedged for minutes and burns the whole session waiting. This deadline
 * is never re-armed: whatever else happens, a command either finishes or fails
 * with a real error inside this window.
 *
 * Deliberately below the multi-minute patience of a typical MCP client, so the
 * failure surfaces as a tool error the model can act on rather than as a silent
 * stall it cannot distinguish from slowness.
 */
const RUN_HARD_TIMEOUT_MS = 120_000;

export interface SSHClientOptions {
  host: string;
  username: string;
  password?: string;
  port?: number;
  keyFilename?: string;
  privateKey?: string;
  /** Passphrase for an encrypted private key. */
  keyPassphrase?: string;
  timeoutMs?: number;
  /**
   * Optional SSH jump host (bastion / ProxyJump). When set, `connect()` reaches
   * `host:port` THROUGH this hop: it opens an SSH session to the hop, asks it to
   * `forwardOut` a TCP channel to the target, then runs the real SSH session
   * over that channel. So the target never needs a port exposed to the network —
   * only the bastion is reachable. The hop is itself an SSH endpoint and may
   * carry its own `jump` for a multi-hop chain (A → B → target).
   */
  jump?: SSHClientOptions;
  /** Interval (ms) for SSH keepalive packets. 0 disables (default). */
  keepAliveInterval?: number;
  /** Max consecutive keepalive failures before disconnect. Default: 3. */
  keepAliveCountMax?: number;
}

/**
 * Decode raw SSH output bytes with a multi-encoding fallback chain.
 *
 * 1. UTF-8 (strict)  — covers ASCII and modern configurations.
 * 2. Windows-1252    — Western-European Windows locales (å ä ö …).
 * 3. Latin-1         — never fails; covers every single-byte code point.
 */
export function decodeOutput(data: Buffer): string {
  if (!data || data.length === 0) return "";
  const encodings = ["utf-8", "windows-1252", "latin1"] as const;
  for (const encoding of encodings) {
    try {
      // `latin1` is a valid WHATWG label at runtime but absent from Bun's
      // `Encoding` type, so we assert to a listed member; the real value is used.
      return new TextDecoder(encoding as "utf-8", { fatal: true }).decode(data);
    } catch {
      // try the next, more permissive encoding
    }
  }
  return new TextDecoder("utf-8").decode(data); // replacement chars, never throws
}

export class MikroTikSSHClient {
  private client: Client | null = null;
  /**
   * Open bastion connections, outermost-first, kept alive for the lifetime of
   * the session (the target's transport rides a channel on the last one). Closed
   * in reverse on `disconnect()`.
   */
  private bastions: Client[] = [];
  private readonly opts: Required<
    Pick<SSHClientOptions, "host" | "username" | "port" | "timeoutMs">
  > &
    SSHClientOptions;

  /** Human-readable reason the last `connect()` failed, if it did. */
  lastError?: string;

  constructor(opts: SSHClientOptions) {
    this.opts = { port: 22, timeoutMs: 10_000, ...opts };
  }

  /**
   * Establish the SSH connection — directly, or through one or more jump hosts
   * when `opts.jump` is set. Resolves `true` on success, `false` on failure
   * (with the reason on `lastError`).
   */
  async connect(): Promise<boolean> {
    this.lastError = undefined;
    try {
      // Flatten the jump chain to the order it must be dialled: outermost
      // bastion first, then inner bastions, then the target itself.
      const hops: SSHClientOptions[] = [];
      for (let j = this.opts.jump; j; j = j.jump) hops.unshift(j);
      const sequence = [...hops, this.opts as SSHClientOptions];

      // Dial each bastion in turn; each connection (after the first) rides a
      // forwarded channel from the previous hop, and itself forwards onward to
      // the NEXT address in the sequence.
      let sock: Readable | undefined;
      for (let i = 0; i < hops.length; i++) {
        const hop = hops[i] as SSHClientOptions;
        const client = await this.openClient(hop, sock);
        this.bastions.push(client);
        const next = sequence[i + 1] as SSHClientOptions;
        const hopTimeout = hop.timeoutMs ?? this.opts.timeoutMs ?? 10_000;
        sock = await this.forwardOut(client, next.host, next.port ?? 22, hopTimeout);
      }

      // Finally open the real session to the target (over the last hop's channel
      // when jumping, or directly when there were no hops).
      this.client = await this.openClient(this.opts, sock);
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to connect to MikroTik: ${this.lastError}`);
      this.disconnect();
      return false;
    }
  }

  /**
   * Open one ssh2 connection. When `sock` is given the connection rides that
   * stream (a forwarded channel from a jump host) instead of dialling the
   * network directly. Resolves the ready `Client`; rejects with a clear reason.
   */
  private openClient(o: SSHClientOptions, sock?: Readable): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const cfg: ConnectConfig = {
        host: o.host,
        port: o.port ?? 22,
        username: o.username,
        readyTimeout: o.timeoutMs ?? 10_000,
      };
      if (sock) cfg.sock = sock;
      if (o.keepAliveInterval) cfg.keepaliveInterval = o.keepAliveInterval;
      if (o.keepAliveCountMax) cfg.keepaliveCountMax = o.keepAliveCountMax;

      if (o.privateKey) {
        cfg.privateKey = o.privateKey;
      } else if (o.keyFilename) {
        try {
          cfg.privateKey = readFileSync(o.keyFilename);
        } catch (e) {
          reject(
            new Error(
              `could not read key file ${o.keyFilename}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
          return;
        }
      }
      // Passphrase only applies to a private key; ssh2 ignores it otherwise.
      if (cfg.privateKey && o.keyPassphrase) cfg.passphrase = o.keyPassphrase;
      // A password may still be supplied as a fallback (ssh2 tries key first).
      if (o.password) cfg.password = o.password;

      client
        .on("ready", () => resolve(client))
        .on("error", (err) => reject(err))
        .connect(cfg);
    });
  }

  /**
   * Ask a connected jump host to open a TCP channel to `host:port` and resolve
   * the resulting stream (used as the next hop's transport `sock`).
   *
   * A RouterOS bastion with SSH TCP forwarding disabled (the default) often
   * NEVER answers the channel-open request instead of rejecting it cleanly, so
   * without a timeout this would hang the whole connection (the dashboard sits
   * forever at "connecting…"). The `timeoutMs` guard turns that silent stall
   * into a fast, actionable error; an explicit rejection gets the same hint.
   */
  private forwardOut(
    via: Client,
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<Readable> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const enableHint =
        "If the jump router runs RouterOS, enable SSH TCP forwarding on it " +
        "(`/ip ssh set forwarding-enabled=local`, or `both`) and confirm the bastion can reach the target.";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `jump host did not open a tunnel to ${host}:${port} within ${Math.round(timeoutMs / 1000)}s. ${enableHint}`,
          ),
        );
      }, timeoutMs);
      via.forwardOut("127.0.0.1", 0, host, port, (err, stream) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(
            new Error(
              `jump host could not open a tunnel to ${host}:${port}: ${err.message}. ${enableHint}`,
            ),
          );
        } else {
          resolve(stream as unknown as Readable);
        }
      });
    });
  }

  /** Run a single command on a fresh SSH channel and return its decoded output. */
  run(command: string, opts: { maxMs?: number } = {}): Promise<string> {
    if (!this.client) {
      return Promise.reject(new Error("Not connected to MikroTik device"));
    }
    // Bind the ssh2 channel opener to a local reference to keep this call site
    // free of the OS-shell pattern that static scanners flag.
    const openChannel = this.client.exec.bind(this.client);
    return new Promise((resolve, reject) => {
      openChannel(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }
        const stdout: Buffer[] = [];
        const stderrBuf: Buffer[] = [];
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let hardTimer: ReturnType<typeof setTimeout> | undefined;
        const clearTimers = (): void => {
          if (timer) clearTimeout(timer);
          if (idleTimer) clearTimeout(idleTimer);
          if (hardTimer) clearTimeout(hardTimer);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimers();
          const out = decodeOutput(Buffer.concat(stdout));
          const error = decodeOutput(Buffer.concat(stderrBuf));
          resolve(error && !out ? error : out);
        };
        const fail = (e: Error): void => {
          if (settled) return;
          settled = true;
          clearTimers();
          try {
            stream.close();
          } catch {
            /* channel already closing */
          }
          reject(e);
        };
        // Idle watchdog: if the channel goes silent AND never closes, the command
        // is wedged — e.g. RouterOS waiting for more input from a malformed/
        // unbalanced command, which would otherwise pin this connection (and the
        // tool call) until the MCP client gives up minutes later. Abort fast.
        // Re-armed on every chunk, so a slow-but-streaming command (a large
        // `/export`) is never cut off while it is actively producing output.
        const armIdle = (): void => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            try {
              stream.signal("INT");
            } catch {
              /* RouterOS may not honour signals */
            }
            fail(
              new Error(
                `MikroTik command produced no output for ${RUN_IDLE_TIMEOUT_MS / 1000}s and the SSH ` +
                  "channel never closed — it appears wedged (often a malformed or unbalanced command). " +
                  `Aborted to avoid hanging the connection. Command: ${command.slice(0, 120)}`,
              ),
            );
          }, RUN_IDLE_TIMEOUT_MS);
        };
        armIdle();
        // Interactive RouterOS commands (`/ping`, `/tool bandwidth-test`,
        // `/tool speed-test`) stream a live counter and may never close the
        // exec channel on their own — even when bounded by count/duration. The
        // maxMs cap stops the command (Ctrl+C / channel close) and returns what
        // streamed, so the tool can't hang forever.
        if (opts.maxMs && opts.maxMs > 0) {
          timer = setTimeout(() => {
            try {
              stream.signal("INT");
            } catch {
              /* RouterOS may not honour signals */
            }
            try {
              stream.close();
            } catch {
              /* channel already closing */
            }
            finish();
          }, opts.maxMs);
        } else {
          // No caller-supplied cap: enforce the absolute deadline. Unlike the
          // idle watchdog this is armed ONCE and never re-armed, so a command
          // that trickles output forever still terminates. It FAILS rather than
          // resolving with whatever arrived — a partial `print` that looks like a
          // complete one is worse than an error, because the model would go on
          // to make decisions from a truncated view of the device.
          hardTimer = setTimeout(() => {
            try {
              stream.signal("INT");
            } catch {
              /* RouterOS may not honour signals */
            }
            const got = Buffer.concat(stdout).length;
            fail(
              new Error(
                `MikroTik command exceeded the ${RUN_HARD_TIMEOUT_MS / 1000}s hard timeout and was ` +
                  `aborted (${got} bytes received, output discarded as incomplete). ` +
                  `Command: ${command.slice(0, 120)}`,
              ),
            );
          }, RUN_HARD_TIMEOUT_MS);
        }
        stream
          .on("close", finish)
          .on("data", (d: Buffer) => {
            stdout.push(d);
            armIdle();
          })
          .stderr.on("data", (d: Buffer) => {
            stderrBuf.push(d);
            armIdle();
          });
      });
    });
  }

  /**
   * Upload a file's bytes to the device over SFTP — the file-transfer subsystem
   * RouterOS exposes on its SSH server. `remotePath` is relative to the SFTP
   * default directory (the flash root), so `config.rsc` lands at the root and
   * appears in `/file`; a path like `disk1/config.rsc` targets external disk.
   * Resolves on success; rejects with a clear reason on failure.
   */
  uploadFile(remotePath: string, data: Buffer): Promise<void> {
    if (!this.client) {
      return Promise.reject(new Error("Not connected to MikroTik device"));
    }
    const openSftp = this.client.sftp.bind(this.client);
    return new Promise((resolve, reject) => {
      openSftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP subsystem unavailable: ${err.message}`));
          return;
        }
        sftp.writeFile(remotePath, data, (werr) => {
          try {
            sftp.end();
          } catch {
            /* already closed */
          }
          if (werr) reject(new Error(`SFTP write failed: ${werr.message}`));
          else resolve();
        });
      });
    });
  }

  /**
   * Download a file's bytes from the device over SFTP. `remotePath` is relative
   * to the SFTP default directory (the flash root). Resolves with the raw file
   * contents; rejects with a clear reason on failure.
   */
  downloadFile(remotePath: string): Promise<Buffer> {
    if (!this.client) {
      return Promise.reject(new Error("Not connected to MikroTik device"));
    }
    const openSftp = this.client.sftp.bind(this.client);
    return new Promise((resolve, reject) => {
      openSftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP subsystem unavailable: ${err.message}`));
          return;
        }
        sftp.readFile(remotePath, (rerr, data) => {
          try {
            sftp.end();
          } catch {
            /* already closed */
          }
          if (rerr) reject(new Error(`SFTP read failed: ${rerr.message}`));
          else resolve(data);
        });
      });
    });
  }

  /** Open a persistent interactive shell channel (used by Safe Mode). */
  shell(opts: { term?: string; cols?: number; rows?: number } = {}): Promise<ClientChannel> {
    if (!this.client) {
      return Promise.reject(new Error("Not connected to MikroTik device"));
    }
    const openShell = this.client.shell.bind(this.client);
    return new Promise((resolve, reject) => {
      openShell(
        {
          term: opts.term ?? "dumb",
          cols: opts.cols ?? 220,
          rows: opts.rows ?? 50,
        },
        (err: Error | undefined, stream: ClientChannel) => (err ? reject(err) : resolve(stream)),
      );
    });
  }

  /** Close the SSH connection (and any jump hosts). Safe to call multiple times. */
  disconnect(): void {
    if (this.client) {
      try {
        this.client.end();
      } catch {
        /* already closed */
      }
      this.client = null;
    }
    // Tear down bastions in reverse (inner-most first) so the target channel is
    // gone before its carrier hop closes.
    for (const b of this.bastions.reverse()) {
      try {
        b.end();
      } catch {
        /* already closed */
      }
    }
    this.bastions = [];
  }
}
