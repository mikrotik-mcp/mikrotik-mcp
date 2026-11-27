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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { Client } from "ssh2";
import type { ConnectConfig, ClientChannel, SFTPWrapper } from "ssh2";
import { logger } from "../logger";
import type { EndpointOptions } from "../core/device-endpoints";
import { commandUnsupported } from "../core/routeros";
import { connectAddress } from "../core/connect-address";

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

export interface SSHClientOptions extends EndpointOptions {
  host: string;
  username: string;
  password?: string;
  port?: number;
  keyFilename?: string;
  privateKey?: string;
  /** Passphrase for an encrypted private key. */
  keyPassphrase?: string;
  /** Sign in with an SSH agent: `true` uses `SSH_AUTH_SOCK`, a string is the socket. */
  agent?: boolean | string;
  /** The pinned SHA-256 fingerprint of the host key (`SHA256:…`). */
  hostKeySha256?: string;
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

/** Options for one command. `onData` and `signal` serve a live terminal. */
export interface RunOptions {
  /** Stop the command after this long and return what it printed. */
  maxMs?: number;
  /** Receives stdout as it arrives. The full output is still returned. */
  onData?: (text: string) => void;
  /** Aborting stops the command and returns what it printed so far. */
  signal?: AbortSignal;
}

/**
 * Connection-loss listeners, shared by every command in flight on a connection.
 * A pooled connection runs many commands at once; one listener set per command
 * passed Node's 10-listener limit at 8 concurrent commands.
 */
interface ConnectionWatch {
  waiters: Set<(lost: string) => void>;
  onError: (error: Error) => void;
  onClose: () => void;
}
const watches = new WeakMap<Client, ConnectionWatch>();

/** Call `waiter` if `connection` is lost. Returns the function that stops watching. */
function watchConnection(connection: Client, waiter: (lost: string) => void): () => void {
  let watch = watches.get(connection);
  if (!watch) {
    const waiters = new Set<(lost: string) => void>();
    const notify = (lost: string): void => {
      for (const each of Array.from(waiters)) each(lost);
    };
    watch = {
      waiters,
      onError: (error) => notify(`SSH connection lost: ${error.message}.`),
      onClose: () => notify("SSH connection closed before command completion."),
    };
    watches.set(connection, watch);
    connection.on("error", watch.onError);
    connection.on("end", watch.onClose);
    connection.on("close", watch.onClose);
  }
  const current = watch;
  current.waiters.add(waiter);
  return () => {
    current.waiters.delete(waiter);
    if (current.waiters.size > 0 || watches.get(connection) !== current) return;
    watches.delete(connection);
    connection.off("error", current.onError);
    connection.off("end", current.onClose);
    connection.off("close", current.onClose);
  };
}

/**
 * How long one SFTP transfer may take. An upload from a tool call must answer
 * before the MCP host drops the call (about 60 s). A download can be a backup of
 * several megabytes for a scheduled job, so it gets longer.
 */
const SFTP_UPLOAD_LIMIT_MS = 45_000;
const SFTP_DOWNLOAD_LIMIT_MS = 120_000;

export class MikroTikSSHClient {
  private client: Client | null = null;
  /**
   * Open bastion connections, outermost-first, kept alive for the lifetime of
   * the session (the target's transport rides a channel on the last one). Closed
   * in reverse on `disconnect()`.
   */
  private bastions: Client[] = [];
  private releases: Array<() => void> = [];
  private readonly opts: Required<
    Pick<SSHClientOptions, "host" | "username" | "port" | "timeoutMs">
  > &
    SSHClientOptions;

  /** Human-readable reason the last `connect()` failed, if it did. */
  lastError?: string;
  connectedHost?: string;

  get isConnected(): boolean {
    return this.client !== null;
  }

  constructor(opts: SSHClientOptions) {
    this.opts = { port: 22, timeoutMs: 10_000, ...opts };
  }

  /**
   * Establish the SSH connection — directly, or through one or more jump hosts
   * when `opts.jump` is set. Resolves `true` on success, `false` on failure
   * (with the reason on `lastError`).
   */
  async connect(): Promise<boolean> {
    if (this.client) return true;
    this.lastError = undefined;
    try {
      // Flatten the jump chain to the order it must be dialled: outermost
      // bastion first, then inner bastions, then the target itself.
      const hops: SSHClientOptions[] = [];
      for (let j = this.opts.jump; j; j = j.jump) hops.unshift(j);
      let via: Client | undefined;
      for (const hop of hops) {
        const { client } = await this.connectEndpoint(hop, via);
        this.bastions.push(client);
        via = client;
      }

      // Finally open the real session to the target (over the last hop's channel
      // when jumping, or directly when there were no hops).
      const { client, host } = await this.connectEndpoint(this.opts, via);
      this.client = client;
      this.connectedHost = host;
      client.once("close", () => {
        if (this.client === client) this.disconnect();
      });
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to connect to MikroTik: ${this.lastError}`);
      this.disconnect();
      return false;
    }
  }

  /** Retry addresses only during connection setup, never after dispatching a command. */
  private async connectEndpoint(
    o: SSHClientOptions,
    via?: Client,
  ): Promise<{ client: Client; host: string }> {
    const port = o.port ?? 22;
    const { host, value: client } = await connectAddress(
      o.hosts?.() ?? [o.host],
      port,
      async (address, signal) => {
        const sock = via
          ? await this.forwardOut(via, address, port, o.timeoutMs ?? 10_000, signal)
          : undefined;
        try {
          signal.throwIfAborted();
          return await this.openClient({ ...o, host: address }, signal, sock);
        } catch (error) {
          sock?.destroy();
          throw error;
        }
      },
      (message) =>
        /authentication|auth methods|private\s*key|key file|passphrase|host key|SSH agent/i.test(
          message,
        ),
      o.onAttempt,
    );
    let release = o.onConnected?.(host);
    const releaseSession = () => {
      release?.();
      release = undefined;
    };
    let lost = false;
    const onError = (error: Error) => {
      lost = true;
      o.onAttempt?.(host, `session lost: ${error.message}`);
    };
    const onClose = () => {
      if (!lost) o.onAttempt?.(host, "SSH session closed unexpectedly");
      releaseSession();
    };
    client.on("error", onError);
    client.once("close", onClose);
    this.releases.push(() => {
      client.off("error", onError);
      client.off("close", onClose);
      releaseSession();
    });
    return { client, host };
  }

  /**
   * Open one ssh2 connection. When `sock` is given the connection rides that
   * stream (a forwarded channel from a jump host) instead of dialling the
   * network directly. Resolves the ready `Client`; rejects with a clear reason.
   */
  private openClient(o: SSHClientOptions, signal: AbortSignal, sock?: Readable): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let ready = false;
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
      if (o.agent) {
        const socket = o.agent === true ? process.env.SSH_AUTH_SOCK : o.agent;
        if (!socket) {
          reject(new Error("SSH agent is set, but SSH_AUTH_SOCK is not: no agent is running"));
          return;
        }
        cfg.agent = socket;
      }
      // A pinned host key: a router that shows another key is not the router
      // that was configured (a replaced device, or someone in the middle).
      let seenKey = "";
      if (o.hostKeySha256) {
        const pinned = o.hostKeySha256.replace(/^SHA256:/, "").replace(/=+$/, "");
        cfg.hostVerifier = (key: Buffer): boolean => {
          seenKey = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
          return seenKey === pinned;
        };
      }

      client
        .on("ready", () => {
          ready = true;
          resolve(client);
        })
        .on("error", (err) => {
          if (!ready)
            reject(
              o.hostKeySha256 && seenKey && /verification failed|host denied/i.test(err.message)
                ? new Error(
                    `host key does not match the pinned fingerprint: the router shows SHA256:${seenKey}. ` +
                      "Nothing was sent. If the router was replaced or reset, update hostKeySha256.",
                  )
                : err,
            );
          client.destroy();
        })
        .on("close", () => {
          if (!ready) reject(new Error("SSH connection closed during handshake"));
        });
      const cancel = () => {
        reject(signal.reason);
        client.destroy();
      };
      signal.addEventListener("abort", cancel, { once: true });
      client.once("close", () => signal.removeEventListener("abort", cancel));
      try {
        client.connect(cfg);
      } catch (error) {
        reject(error);
        client.destroy();
      }
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
    signal: AbortSignal,
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
      const cancel = () => {
        settled = true;
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      via.forwardOut("127.0.0.1", 0, host, port, (err, stream) => {
        signal.removeEventListener("abort", cancel);
        if (settled) {
          stream?.destroy();
          return;
        }
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
  run(command: string, opts: RunOptions = {}): Promise<string> {
    if (!this.client) {
      return Promise.reject(new Error("Not connected to MikroTik device"));
    }
    // Bind the ssh2 channel opener to a local reference to keep this call site
    // free of the OS-shell pattern that static scanners flag.
    const connection = this.client;
    const openChannel = connection.exec.bind(connection);
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderrBuf: Buffer[] = [];
      let stream: ClientChannel | undefined;
      let settled = false;
      let openTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let unwatch = (): void => {};
      const live = opts.onData ? new TextDecoder("utf-8") : undefined;
      const clearTimers = (): void => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (openTimer) clearTimeout(openTimer);
        if (timer) clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        unwatch();
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
          stream?.signal("INT");
        } catch {
          /* RouterOS may not honour signals */
        }
        try {
          stream?.close();
        } catch {
          /* channel already closing */
        }
        reject(e);
      };
      const uncertain =
        "Command outcome is unknown; do not retry a write blindly. Reconnect and read back the target state first.";
      unwatch = watchConnection(connection, (lost) => fail(new Error(`${lost} ${uncertain}`)));
      // exec() includes channel-open and command-request acknowledgement. Its
      // callback can stall before any stream/watchdog exists.
      openTimer = setTimeout(() => {
        fail(
          new Error(`SSH channel request timed out after ${this.opts.timeoutMs}ms. ${uncertain}`),
        );
        // There is no channel to cancel yet. Retire this connection so a late
        // exec acknowledgement cannot contaminate subsequent pooled calls.
        if (this.client === connection) this.disconnect();
      }, this.opts.timeoutMs);
      const onChannel = (err: Error | undefined, channel: ClientChannel): void => {
        if (settled) {
          try {
            channel?.close();
          } catch {
            /* request already cancelled by disconnect */
          }
          return;
        }
        if (openTimer) clearTimeout(openTimer);
        if (err) return fail(err);
        stream = channel;
        // Idle watchdog: if the channel goes silent AND never closes, the command
        // is wedged — e.g. RouterOS waiting for more input from a malformed/
        // unbalanced command, which would otherwise pin this connection (and the
        // tool call) until the MCP client gives up minutes later. Abort fast.
        // Re-armed on every chunk, so a slow-but-streaming command (a large
        // `/export`) is never cut off while it is actively producing output.
        const armIdle = (): void => {
          if (settled) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            fail(
              new Error(
                `MikroTik command produced no output for ${RUN_IDLE_TIMEOUT_MS / 1000}s and the SSH ` +
                  "channel never closed — it appears wedged (often a malformed or unbalanced command). " +
                  `${uncertain} Command: ${command.slice(0, 120)}`,
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
            finish();
            try {
              channel.signal("INT");
            } catch {
              /* RouterOS may not honour signals */
            }
            try {
              channel.close();
            } catch {
              /* channel already closing */
            }
          }, opts.maxMs);
        } else {
          // No caller-supplied cap: enforce the absolute deadline. Unlike the
          // idle watchdog this is armed ONCE and never re-armed, so a command
          // that trickles output forever still terminates. It FAILS rather than
          // resolving with whatever arrived — a partial `print` that looks like a
          // complete one is worse than an error, because the model would go on
          // to make decisions from a truncated view of the device.
          hardTimer = setTimeout(() => {
            const got = Buffer.concat(stdout).length;
            fail(
              new Error(
                `MikroTik command exceeded the ${RUN_HARD_TIMEOUT_MS / 1000}s hard timeout and was ` +
                  `aborted (${got} bytes received, output discarded as incomplete). ` +
                  `${uncertain} Command: ${command.slice(0, 120)}`,
              ),
            );
          }, RUN_HARD_TIMEOUT_MS);
        }
        channel
          .on("error", (error: Error) =>
            fail(new Error(`SSH channel error: ${error.message}. ${uncertain}`)),
          )
          .on("close", (code?: number | null, signal?: string) => {
            if (settled) return;
            // Exit status is optional in SSH; a normal close without it is valid.
            if ((typeof code === "number" && code !== 0) || signal) {
              const text =
                decodeOutput(Buffer.concat(stderrBuf)) || decodeOutput(Buffer.concat(stdout));
              // Newer RouterOS exits non-zero when the parser does not know the
              // menu ("bad command name"). Callers test for that text with
              // commandUnsupported() to learn that a feature is absent, so it is
              // an answer, not a failure: return it as older versions did.
              if (!signal && commandUnsupported(text)) {
                settled = true;
                clearTimers();
                resolve(text);
                return;
              }
              fail(
                new Error(
                  `MikroTik command failed (${signal ? `signal ${signal}` : `exit code ${code}`}): ${text}`,
                ),
              );
            } else finish();
          })
          .on("data", (d: Buffer) => {
            if (settled) return;
            stdout.push(d);
            if (live) opts.onData?.(live.decode(d, { stream: true }));
            armIdle();
          })
          .stderr.on("data", (d: Buffer) => {
            if (settled) return;
            stderrBuf.push(d);
            armIdle();
          });
      };
      function onAbort(): void {
        const channel = stream;
        finish();
        try {
          channel?.signal("INT");
        } catch {
          /* RouterOS may not honour signals */
        }
        try {
          channel?.close();
        } catch {
          /* channel already closing */
        }
      }
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        openChannel(command, onChannel);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Upload a file's bytes to the device over SFTP — the file-transfer subsystem
   * RouterOS exposes on its SSH server. `remotePath` is relative to the SFTP
   * default directory (the flash root), so `config.rsc` lands at the root and
   * appears in `/file`; a path like `disk1/config.rsc` targets external disk.
   * Resolves on success; rejects with a clear reason on failure.
   */
  uploadFile(remotePath: string, data: Buffer, limitMs = SFTP_UPLOAD_LIMIT_MS): Promise<void> {
    return this.transfer<void>("write", limitMs, (sftp, done) =>
      sftp.writeFile(remotePath, data, (error) => done(error)),
    );
  }

  /**
   * Download a file's bytes from the device over SFTP. `remotePath` is relative
   * to the SFTP default directory (the flash root). Resolves with the raw file
   * contents; rejects with a clear reason on failure.
   */
  downloadFile(remotePath: string, limitMs = SFTP_DOWNLOAD_LIMIT_MS): Promise<Buffer> {
    return this.transfer<Buffer>("read", limitMs, (sftp, done) =>
      sftp.readFile(remotePath, (error, data) => done(error, data)),
    );
  }

  /**
   * One SFTP transfer that always ends: with its result, when the connection
   * closes or fails, or after `limitMs`.
   *
   * Before this, a transfer waited only for the SFTP callback. A channel that
   * stalled, or a connection that dropped during the transfer, never called it:
   * the tool call had no answer and the caller waited until its own host gave up.
   */
  private transfer<T>(
    what: "read" | "write",
    limitMs: number,
    run: (sftp: SFTPWrapper, done: (error?: Error | null, value?: T) => void) => void,
  ): Promise<T> {
    const client = this.client;
    if (!client) return Promise.reject(new Error("Not connected to MikroTik device"));
    return new Promise<T>((resolve, reject) => {
      let channel: SFTPWrapper | undefined;
      let settled = false;
      // What to take away when the transfer ends: the timer and the two listeners.
      const cleanup: (() => void)[] = [];
      const finish = (error?: Error | null, value?: T): void => {
        if (settled) return;
        settled = true;
        for (const undo of cleanup) undo();
        try {
          channel?.end();
        } catch {
          /* already closed */
        }
        if (error) reject(error);
        else resolve(value as T);
      };
      const unknown =
        what === "write"
          ? " The file may be missing or partly written: read it back before you send it again."
          : "";
      const onClose = (): void =>
        finish(new Error(`SFTP ${what} stopped: the SSH connection closed.${unknown}`));
      const onError = (error: Error): void =>
        finish(new Error(`SFTP ${what} stopped: ${error.message}.${unknown}`));
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `SFTP ${what} did not finish in ${Math.round(limitMs / 1000)} s and was stopped.${unknown}`,
            ),
          ),
        limitMs,
      );
      client.once("close", onClose);
      client.once("error", onError);
      cleanup.push(
        () => clearTimeout(timer),
        () => client.off("close", onClose),
        () => client.off("error", onError),
      );
      client.sftp((error, sftp) => {
        if (error) {
          finish(new Error(`SFTP subsystem unavailable: ${error.message}`));
          return;
        }
        if (settled) {
          sftp.end();
          return;
        }
        channel = sftp;
        run(sftp, (failure, value) =>
          failure
            ? finish(new Error(`SFTP ${what} failed: ${failure.message}`))
            : finish(null, value),
        );
      });
    });
  }

  /**
   * Open the SFTP subsystem and keep it open, for callers that list, stream or
   * rename files (the dashboard Files page). The caller ends it.
   */
  sftp(): Promise<SFTPWrapper> {
    if (!this.client) {
      return Promise.reject(new Error("Not connected to MikroTik device"));
    }
    const openSftp = this.client.sftp.bind(this.client);
    return new Promise((resolve, reject) => {
      openSftp((err, sftp) =>
        err ? reject(new Error(`SFTP subsystem unavailable: ${err.message}`)) : resolve(sftp),
      );
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
    for (const release of this.releases) release();
    this.releases = [];
    if (this.client) {
      const client = this.client;
      this.client = null;
      try {
        client.end();
      } catch {
        /* already closed */
      }
    }
    this.connectedHost = undefined;
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
