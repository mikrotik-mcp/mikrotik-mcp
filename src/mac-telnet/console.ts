/**
 * RouterOS interactive-console reader over a MAC-Telnet session.
 *
 * MAC-Telnet (see `protocol.ts`) gives a raw, bidirectional terminal stream —
 * not a request/response API. To run a command and capture clean output, this
 * layer drives the RouterOS console the way a terminal would and reconstructs
 * the "screen", then strips the echoed command and the trailing prompt. This is
 * what lets the existing one-shot tools run unchanged over a MAC transport.
 *
 * Behavior grounded on stock CHR 7.23.1 (via the `tikoci/centrs` reference):
 *
 *   - **Terminal-size probe at login.** The console emits an ANSI cursor probe
 *     (`ESC[6n` DSR, `ESC Z` DECID). Answering DSR with `ESC[<rows>;<cols>R`
 *     makes the console use that width; otherwise it falls back to 80 cols and
 *     *wraps* the echo, which breaks output extraction. We report a tall/wide
 *      screen, so the console neither paginates nor wraps in capture mode.
 *   - **~10s login stall.** The prompt does not appear until ~10s after login on
 *     every login. This is a latency cost, not a correctness problem;
 *     `primeTimeoutMs` budgets for it.
 *   - **First-login license gate.** A fresh device prints
 *     `Do you want to see the software license? [Y/n]:` and blocks; `open()`
 *     auto-answers `n` (mac-telnet's whole point is reaching fresh gear).
 *   - **Prompt.** `[user@identity] > ` / `[user@identity] /path> `, redrawn with
 *     CR + space-padding + CR. {@link ROUTEROS_PROMPT_RE}.
 *   - **Response shape.** Line 0 is the echoed `[prompt] > <command>`, the middle
 *     lines are the output, the last line is the trailing prompt. A successful
 *     writing (add/set/remove) prints nothing — the same silent-write behavior SSH
 *     sees.
 */

import { MacTelnetSession } from "@tikoci/centrs/protocols";
import type {
  MacAddress,
  MacTelnetDatagramSink,
  MacTelnetSessionOptions,
} from "@tikoci/centrs/protocols";

const ESC = "\x1B";
const enc = new TextEncoder();

// ANSI strippers, built from the ESC constant so no literal control char sits in
// a regex source. CSI: `ESC [ <params> <inter> final`; ESC2: a two-byte escape.
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANSI_ESC2 = new RegExp(`${ESC}[@-_]`, "g");

/** RouterOS readline prompt: `[user@identity] > ` / `[user@identity] /ip/address> `. */
export const ROUTEROS_PROMPT_RE = /\[[^\]@\r\n]+@[^\]\r\n]*\][^\r\n]*>\s*$/;

/** How often the console drives {@link MacTelnetSession.tick} (retransmit/keepalive). */
const TICK_INTERVAL_MS = 15;

/** The first-login one-time license question. */
const LICENSE_RE = /do you want to see the software license/i;

/**
 * The slice of {@link MacTelnetSession} this console drives. Declaring it as an
 * interface lets a test inject a scripted session to exercise the live
 * login/prompt/command orchestration with no L2 network.
 */
export interface MacTelnetSessionLike {
  start(): void;
  handlePacket(bytes: Uint8Array): void;
  sendInput(bytes: Uint8Array): void;
  tick(nowMs: number): void;
  end(): void;
}

/** Builds the session from its init options (defaults to a real {@link MacTelnetSession}). */
export type MacTelnetSessionFactory = (init: MacTelnetSessionOptions) => MacTelnetSessionLike;

export interface MacTelnetConsoleOptions {
  /** Datagram sink the underlying session writes to (UDP socket, or a test bridge). */
  sink: MacTelnetDatagramSink;
  sourceMac: MacAddress;
  destinationMac: MacAddress;
  username: string;
  password: string;
  sessionKey?: number;
  /** Override the session implementation (tests only). */
  createSession?: MacTelnetSessionFactory;
  /**
   * Rows/cols reported to the console's DSR probe. Defaults are deliberately
   * huge so the console never paginates (rows) or wraps the echo (cols) in
   * capture mode.
   */
  rows?: number;
  cols?: number;
  /** Budget to reach the first prompt (covers banner/license + the ~10s stall). */
  primeTimeoutMs?: number;
  /** Per-command response budget. */
  commandTimeoutMs?: number;
  /** Quiescence after a prompt is seen before a response is considered complete. */
  settleMs?: number;
  /** Auto-answer the first-login software-license prompt with `n`. Default true. */
  acceptLicense?: boolean;
}

export interface ConsoleCommandResult {
  /** Clean output: echoed command and trailing prompt stripped, CRLF→\n. */
  output: string;
  /** The raw console bytes captured for this command (debugging). */
  raw: string;
}

type Waiter = {
  predicate: (buffer: string) => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  settle?: ReturnType<typeof setTimeout>;
};

/**
 * Emulate a CR/LF terminal: CR → column 0 (overwrite), LF → next line,
 * BS → back one column, printable → write at the cursor. ANSI/CSI escapes are
 * stripped (they appear only in the login probe). Returns the displayed lines,
 * right-trimmed. This collapses the console's CR-based prompt redraws and
 * space-padding into the single line a user would see.
 */
export function emulateScreen(text: string): string[] {
  const clean = text.replace(ANSI_CSI, "").replace(ANSI_ESC2, "");
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  for (const ch of clean) {
    const code = ch.charCodeAt(0);
    if (ch === "\n") {
      row += 1;
      if (!lines[row]) lines[row] = [];
      col = 0;
    } else if (ch === "\r") {
      col = 0;
    } else if (code === 8) {
      col = Math.max(0, col - 1);
    } else if (code >= 32 && code !== 0x7f) {
      const line = lines[row] as string[];
      line[col] = ch;
      col += 1;
    }
  }
  return lines.map((line) =>
    Array.from(line, (c) => c ?? " ")
      .join("")
      .replace(/\s+$/, ""),
  );
}

/**
 * Extract the command's clean output from its raw console response: drop the
 * echoed-command line(s) and any trailing prompt / blank lines.
 *
 * The echo is `[prompt] > <command>`. A command longer than the terminal width
 * wraps onto further lines; when `command` is supplied, consume exactly as many
 * echoed lines as the command spans (so a wrapped echo does not leak into the
 * output); otherwise drop the single first line.
 */
export function extractCommandOutput(raw: string, command?: string): string {
  // Submission terminators are not echoed command text and must not consume output.
  command = command?.replace(/[\r\n]+$/, "");
  const lines = emulateScreen(raw);
  let start = 1;
  if (command !== undefined && lines.length > 0) {
    const first = lines[0] ?? "";
    const promptMatch = first.match(/^\[[^\]\r\n]*\][^\r\n]*?>\s?/);
    const echoedOnFirst = promptMatch ? first.slice(promptMatch[0].length) : first;
    let consumed = echoedOnFirst.length;
    while (consumed < command.length && start < lines.length) {
      consumed += (lines[start] ?? "").length;
      start += 1;
    }
  }
  const body = lines.slice(start);
  while (body.length > 0) {
    const last = body[body.length - 1] as string;
    if (last.length === 0 || ROUTEROS_PROMPT_RE.test(last)) {
      body.pop();
      continue;
    }
    break;
  }
  return body.join("\n");
}

/**
 * Drives one MAC-Telnet console session: login, terminal-probe negotiation,
 * license, prompt sync, and command run/capture. The owner feeds inbound
 * datagrams via {@link handlePacket} and provides the outbound {@link sink}.
 */
export class MacTelnetConsole {
  private readonly options: Required<
    Omit<MacTelnetConsoleOptions, "sink" | "sessionKey" | "createSession">
  > &
    Pick<MacTelnetConsoleOptions, "sink" | "sessionKey" | "createSession">;
  private readonly session: MacTelnetSessionLike;
  private buffer = "";
  private ready = false;
  private closed = false;
  private closeError?: Error;
  private waiter?: Waiter;
  private tickTimer?: ReturnType<typeof setInterval>;
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  private readonly decoder = new TextDecoder();
  /** Rolling tail across chunks so a terminal probe split across packets is still matched. */
  private probeTail = "";

  constructor(options: MacTelnetConsoleOptions) {
    this.options = {
      rows: 9999,
      cols: 512,
      primeTimeoutMs: 30_000,
      commandTimeoutMs: 15_000,
      settleMs: 150,
      acceptLicense: true,
      ...options,
    };
    const createSession: MacTelnetSessionFactory =
      options.createSession ?? ((init) => new MacTelnetSession(init));
    this.session = createSession({
      sink: options.sink,
      sourceMac: options.sourceMac,
      destinationMac: options.destinationMac,
      username: options.username,
      password: options.password,
      sessionKey: options.sessionKey,
      terminalType: "vt102",
      terminalWidth: this.options.cols,
      terminalHeight: this.options.rows,
      onReady: () => this.onReady(),
      onData: (bytes) => this.onData(bytes),
      onClose: (error) => this.onClose(error),
    });
  }

  /** Feed an inbound datagram into the session. */
  handlePacket(bytes: Uint8Array): void {
    // Called from a socket `message` event — it must never throw back to the
    // emitter. An unexpected processing error closes the console (rejecting
    // waiters) rather than crashing the caller's event loop.
    try {
      this.session.handlePacket(bytes);
    } catch (error) {
      this.onClose(
        error instanceof Error ? error : new Error("Failed to process a MAC-Telnet datagram."),
      );
    }
  }

  /**
   * Log in, negotiate the terminal, clear the license, and synchronize on the
   * first prompt. Resolves once the console is ready to take commands.
   */
  async open(): Promise<void> {
    // Drive the session's retransmit + keepalive timers. The tick interval is
    // small enough to honor the reference retransmit backoff (15ms first step).
    // `unref` so a dangling console never keeps the process alive.
    this.tickTimer = setInterval(() => {
      try {
        this.session.tick(Date.now());
      } catch {
        /* timer callback must not throw to the event loop */
      }
    }, TICK_INTERVAL_MS);
    this.tickTimer.unref?.();
    this.session.start();
    await this.waitReady(this.options.primeTimeoutMs);
    // Wait for the banner / license / first prompt (covers the ~10s stall).
    await this.waitFor(
      (buffer) => this.endsWithPrompt(buffer) || LICENSE_RE.test(buffer),
      this.options.primeTimeoutMs,
      "waiting for the RouterOS console prompt",
    );
    if (this.options.acceptLicense && LICENSE_RE.test(this.buffer)) {
      this.buffer = "";
      this.session.sendInput(enc.encode("n\r"));
      await this.waitFor(
        (buffer) => this.endsWithPrompt(buffer),
        this.options.primeTimeoutMs,
        "waiting for the prompt after the license screen",
      );
    }
    // Land on a clean, empty prompt and discard the banner.
    this.buffer = "";
    this.session.sendInput(enc.encode("\r"));
    await this.waitFor(
      (buffer) => this.endsWithPrompt(buffer),
      this.options.commandTimeoutMs,
      "waiting for a clean prompt",
    );
    this.buffer = "";
  }

  /** Run one CLI command and return its clean output. */
  async run(cli: string): Promise<ConsoleCommandResult> {
    this.assertOpen();
    // Submit exactly once, even when callers provide a newline-terminated command.
    cli = cli.replace(/[\r\n]+$/, "");
    this.buffer = "";
    this.session.sendInput(enc.encode(`${cli}\r`));
    await this.waitFor(
      (buffer) => this.endsWithPrompt(buffer),
      this.options.commandTimeoutMs,
      `running over mac-telnet: ${cli}`,
    );
    const raw = this.buffer;
    return { output: extractCommandOutput(raw, cli), raw };
  }

  /** Send END and close the session. */
  close(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (!this.closed) this.session.end();
  }

  /** True once login + prime completed and the console accepts commands. */
  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private onReady(): void {
    this.ready = true;
    for (const w of this.readyWaiters.splice(0)) w.resolve();
  }

  private onData(bytes: Uint8Array): void {
    // Stream-decode so a multi-byte char split across datagrams is not corrupted.
    const chunk = this.decoder.decode(bytes, { stream: true });
    // Match the size probe against `(prev tail) + chunk` so an `ESC[6n`
    // straddling a packet boundary is still answered exactly once.
    const combined = `${this.probeTail}${chunk}`;
    this.answerSizeProbe(combined);
    this.probeTail = combined.slice(-3);
    this.buffer += chunk;
    this.checkWaiter();
  }

  private onClose(error?: Error): void {
    this.closed = true;
    this.closeError = error;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    const failure = error ?? new Error("The MAC-Telnet console session closed.");
    for (const w of this.readyWaiters.splice(0)) w.reject(failure);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timeout);
      if (waiter.settle) clearTimeout(waiter.settle);
      waiter.reject(failure);
    }
  }

  /**
   * Answer the console's terminal-size probe. The operative query is DSR
   * (`ESC[6n`); replying with our reported rows/cols stops the console wrapping
   * at 80. We also answer DECID (`ESC Z`) / primary DA (`ESC[c`) with a VT102
   * identification. (This does not remove the ~10s negotiation stall.)
   */
  private answerSizeProbe(chunk: string): void {
    if (chunk.includes(`${ESC}[6n`)) {
      this.session.sendInput(enc.encode(`${ESC}[${this.options.rows};${this.options.cols}R`));
    }
    if (chunk.includes(`${ESC}Z`) || chunk.includes(`${ESC}[c`)) {
      this.session.sendInput(enc.encode(`${ESC}[?6c`));
    }
  }

  private endsWithPrompt(buffer: string): boolean {
    const lines = emulateScreen(buffer).filter((line) => line.length > 0);
    return ROUTEROS_PROMPT_RE.test(lines[lines.length - 1] ?? "");
  }

  private waitReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error("The MAC-Telnet session closed before login completed."),
      );
    }
    // Bound the wait: if the device never responds (or auth never completes
    // without closing), open() would otherwise hang forever, ignoring --timeout.
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== entry);
        reject(
          new Error(
            "MAC-Telnet login did not complete — no console response from the device. " +
              "Confirm the device is reachable over mac-telnet (mac-server interface list) and the credentials are correct.",
          ),
        );
      }, timeoutMs);
      this.readyWaiters.push(entry);
    });
  }

  /**
   * Resolve once `predicate(buffer)` holds and the stream has been quiet for
   * `settleMs` (so a prompt seen mid-redraw captures the full final prompt).
   */
  private waitFor(
    predicate: (buffer: string) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error(`MAC-Telnet session closed while ${label}.`),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiter = undefined;
        reject(
          new Error(
            `Timed out ${label}. The RouterOS console did not return a prompt in time; ` +
              "raise the timeout or confirm the device is responsive over mac-telnet.",
          ),
        );
      }, timeoutMs);
      this.waiter = { predicate, resolve, reject, timeout };
      this.checkWaiter();
    });
  }

  private checkWaiter(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    if (!waiter.predicate(this.buffer)) {
      // New data invalidated a pending settle (still mid-response).
      if (waiter.settle) {
        clearTimeout(waiter.settle);
        waiter.settle = undefined;
      }
      return;
    }
    // Predicate holds; (re)start the settle timer so trailing redraw lands.
    if (waiter.settle) clearTimeout(waiter.settle);
    waiter.settle = setTimeout(() => {
      if (this.waiter !== waiter) return;
      this.waiter = undefined;
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }, this.options.settleMs);
  }

  private assertOpen(): void {
    if (!this.ready || this.closed) {
      throw new Error(
        "The MAC-Telnet console is not open. Call open() and await it before running commands.",
      );
    }
  }
}
