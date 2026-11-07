/**
 * Offline integration test for the MAC-Telnet console orchestration.
 *
 * The codec/crypto live in `@tikoci/centrs` and are exercised in
 * `mac-telnet.spec.ts`. What was previously UNTESTED is the live console
 * sequence our code owns: login → terminal-size probe answer → first-login
 * license gate → prompt sync → command run/capture. This drives the *real*
 * `MacTelnetConsole` against a scripted in-memory session that emulates a
 * RouterOS console — no UDP, no L2 — so that orchestration is verified end to
 * end (and regressions are caught) without a device.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parseMac } from "@tikoci/centrs/protocols";
import type { MacTelnetDatagramSink, MacTelnetSessionOptions } from "@tikoci/centrs/protocols";
import { MacTelnetConsole } from "../src/mac-telnet/console";
import type { MacTelnetSessionLike } from "../src/mac-telnet/console";

const ESC = String.fromCharCode(27);
const PROMPT = "[admin@MikroTik] > ";
/** The DSR cursor-position answer the console sends back to a `ESC[6n` probe. */
const DSR_ANSWER = new RegExp(`${ESC}\\[[0-9;]*R`);
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Script {
  /** Emitted once after onReady (banner + optional probe / license / prompt). */
  banner: string;
  /** Maps a submitted command (CR stripped) to the console bytes it produces. */
  respond: (cmd: string) => string;
}

/**
 * A scripted stand-in for `MacTelnetSession` that plays a RouterOS console:
 * fires onReady then the banner, records every byte the console sends, and
 * answers submitted commands. Emissions are deferred so the console's
 * waiter-registration ordering is exercised realistically.
 */
class ScriptedSession implements MacTelnetSessionLike {
  readonly sent: string[] = [];
  private readonly onReady?: () => void;
  private readonly onData?: (bytes: Uint8Array) => void;
  private readonly onClose?: (error?: Error) => void;

  constructor(
    init: MacTelnetSessionOptions,
    private readonly script: Script,
  ) {
    this.onReady = init.onReady;
    this.onData = init.onData;
    this.onClose = init.onClose as (error?: Error) => void;
  }

  private emit(text: string): void {
    setTimeout(() => this.onData?.(enc.encode(text)), 0);
  }

  start(): void {
    setTimeout(() => {
      this.onReady?.();
      this.emit(this.script.banner);
    }, 0);
  }

  sendInput(bytes: Uint8Array): void {
    const text = dec.decode(bytes);
    this.sent.push(text);
    // The terminal-size answer (ESC[<rows>;<cols>R) is consumed by the device, not echoed.
    if (DSR_ANSWER.test(text)) return;
    this.emit(this.script.respond(text.replace(/\r$/, "")));
  }

  handlePacket(): void {}
  tick(): void {}
  end(): void {
    this.onClose?.();
  }
}

const sink: MacTelnetDatagramSink = { send() {}, close() {} };
let live: MacTelnetConsole | null = null;

function makeConsole(script: Script): {
  console: MacTelnetConsole;
  session: () => ScriptedSession;
} {
  let session: ScriptedSession | undefined;
  const console = new MacTelnetConsole({
    sink,
    sourceMac: parseMac("02:00:00:00:00:01"),
    destinationMac: parseMac("48:a9:8a:c6:42:f6"),
    username: "admin",
    password: "",
    settleMs: 5,
    primeTimeoutMs: 1500,
    commandTimeoutMs: 1500,
    createSession: (init) => {
      session = new ScriptedSession(init, script);
      return session;
    },
  });
  live = console;
  return { console, session: () => session as ScriptedSession };
}

afterEach(() => {
  live?.close();
  live = null;
});

describe("MacTelnetConsole orchestration", () => {
  it("submits newline-terminated commands once and preserves multiline output", async () => {
    const command = ':put "ok"';
    const { console, session } = makeConsole({
      banner: PROMPT,
      respond: (cmd) =>
        cmd === command ? `${PROMPT}${cmd}\r\nok\r\nsecond line\r\n${PROMPT}` : PROMPT,
    });
    await console.open();
    for (const suffix of ["\n", "\r\n", "\n\n"]) {
      expect((await console.run(command + suffix)).output).toBe("ok\nsecond line");
      expect(session().sent.at(-1)).toBe(`${command}\r`);
    }
  });

  it("logs in, answers the size probe, and captures command output", async () => {
    const { console, session } = makeConsole({
      // Banner carries a cursor-position probe (ESC[6n) and lands on a prompt.
      banner: `\r\n\r\nMikroTik RouterOS 7.16\r\n${ESC}[6n${PROMPT}`,
      respond: (cmd) => {
        if (cmd === "" || cmd === "n") return PROMPT;
        if (cmd === "/system identity print") {
          return `${PROMPT}${cmd}\r\n  name: MikroTik\r\n${PROMPT}`;
        }
        return `${PROMPT}${cmd}\r\n${PROMPT}`; // silent write
      },
    });

    await console.open();
    expect(console.isReady).toBe(true);
    // The console answered the device's terminal-size probe.
    expect(session().sent.some((s) => DSR_ANSWER.test(s))).toBe(true);

    const { output } = await console.run("/system identity print");
    expect(output).toBe("  name: MikroTik");

    const silent = await console.run("/ip address add address=10.0.0.1/24");
    expect(silent.output).toBe("");
  });

  it("auto-answers the first-login software-license gate", async () => {
    const { console, session } = makeConsole({
      banner: `\r\n\r\nDo you want to see the software license? [Y/n]: `,
      respond: (cmd) => {
        if (cmd === "n" || cmd === "") return PROMPT;
        return `${PROMPT}${cmd}\r\n${PROMPT}`;
      },
    });

    await console.open();
    expect(console.isReady).toBe(true);
    // The console declined the license with "n".
    expect(session().sent.some((s) => s.startsWith("n"))).toBe(true);
  });

  it("times out with a clear error when the device never returns a prompt", async () => {
    const { console } = makeConsole({
      // Ready fires but no prompt ever appears.
      banner: "\r\n(booting, no console yet)\r\n",
      respond: () => "(still nothing)",
    });
    await expect(console.open()).rejects.toThrow(/prompt|Timed out/i);
  });
});
