/**
 * Interactive shell sessions for the dashboard terminal — a real RouterOS
 * console (PTY), as in WinBox: menus you can enter, y/n prompts, live monitors.
 *
 * Each session has its own SSH connection, apart from the pool, because an
 * interactive channel is long-lived. The browser reads the output as one
 * streamed HTTP response and sends keys with small POSTs, so this works through
 * the remote-dashboard proxy too.
 *
 * What the router prints is recorded to a file per session (asciicast v2), so
 * a session can be played back and searched. Typed keys are NOT recorded: the
 * router echoes commands, and it does not echo what is typed at a password
 * prompt, so the recording holds no hidden input. The opening and closing of a
 * session reach the audit feed.
 */
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import type { ClientChannel } from "ssh2";
import { isMacTelnetDevice, resolveJump, sshOptionsOf } from "../core/transport";
import { getDevice } from "../core/runtime";
import { logger } from "../logger";
import { MikroTikSSHClient } from "../ssh/client";
import { recordToolCall } from "./recorder";

interface ShellSession {
  device: string;
  client: MikroTikSSHClient;
  channel: ClientChannel;
  opened: number;
  /** Closed after this long without a key or output. */
  idle: ReturnType<typeof setTimeout> | undefined;
  close: (reason: string) => void;
}

const sessions = new Map<string, ShellSession>();

// ── recordings ────────────────────────────────────────────────────────────
let recordingDir: string | undefined;
/** A recording stops growing here; the session itself continues. */
export const MAX_RECORDING_BYTES = 5 * 1024 * 1024;
const MAX_RECORDINGS = 200;
const RECORDING_ID = /^[\w.-]+\.cast$/;

/** Where session recordings are kept; `undefined` turns recording off. */
export function setRecordingDir(dir: string | undefined): void {
  recordingDir = dir;
}

export interface ShellRecording {
  id: string;
  device: string;
  started: number;
  bytes: number;
}

/** Newest first. The device and the start time are read from the file name. */
export function listRecordings(): ShellRecording[] {
  if (!recordingDir) return [];
  let names: string[];
  try {
    names = readdirSync(recordingDir).filter((name) => RECORDING_ID.test(name));
  } catch {
    return [];
  }
  const dir = recordingDir;
  return names
    .map((id) => {
      const [stamp = "0", ...rest] = id.replace(/\.cast$/, "").split("_");
      return {
        id,
        device: rest.slice(0, -1).join("_"),
        started: Number(stamp),
        bytes: statSync(join(dir, id)).size,
      };
    })
    .sort((a, b) => b.started - a.started);
}

/** The asciicast text of one recording, or undefined when there is none. */
export function readRecording(id: string): string | undefined {
  if (!recordingDir || !RECORDING_ID.test(id)) return undefined;
  try {
    return readFileSync(join(recordingDir, id), "utf8");
  } catch {
    return undefined;
  }
}

export function deleteRecording(id: string): boolean {
  if (!recordingDir || !RECORDING_ID.test(id)) return false;
  try {
    unlinkSync(join(recordingDir, id));
    return true;
  } catch {
    return false;
  }
}

/** Start a recording file; returns how to add output and how to finish. */
function startRecording(
  device: string,
  cols: number,
  rows: number,
): { write: (data: Buffer) => void; end: () => void } | undefined {
  if (!recordingDir) return undefined;
  let file: WriteStream;
  const started = Date.now();
  try {
    mkdirSync(recordingDir, { recursive: true });
    // Keep the newest recordings only.
    for (const old of listRecordings().slice(MAX_RECORDINGS - 1)) deleteRecording(old.id);
    const safe = device.replace(/[^\w.-]+/g, "-");
    file = createWriteStream(
      join(recordingDir, `${started}_${safe}_${crypto.randomUUID().slice(0, 8)}.cast`),
    );
  } catch {
    return undefined;
  }
  file.on("error", () => {});
  file.write(
    `${JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(started / 1000), title: device })}\n`,
  );
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  return {
    write(data) {
      if (bytes > MAX_RECORDING_BYTES) return;
      bytes += data.length;
      const text = decoder.decode(data, { stream: true });
      if (text) file.write(`${JSON.stringify([(Date.now() - started) / 1000, "o", text])}\n`);
    },
    end: () => file.end(),
  };
}
export const MAX_SHELLS = 12;
const IDLE_MS = 30 * 60_000;

const clampSize = (value: unknown, fallback: number, max: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 2 ? Math.min(n, max) : fallback;
};

/**
 * Open a shell on `device`. The response body is the terminal output; its
 * `x-shell-id` header names the session for {@link shellInput} and
 * {@link shellResize}. Cancelling the response closes the session.
 */
export async function openShell(
  device: string,
  size: { cols?: unknown; rows?: unknown },
  signal: AbortSignal,
): Promise<Response> {
  const fail = (status: number, error: string): Response => Response.json({ error }, { status });
  if (sessions.size >= MAX_SHELLS)
    return fail(429, `Too many interactive shells are open (${MAX_SHELLS}). Close one first.`);
  const dc = getDevice(device);
  if (isMacTelnetDevice(dc))
    return fail(400, "The interactive shell needs SSH. This router is reached over MAC-Telnet.");

  const client = new MikroTikSSHClient({
    ...sshOptionsOf(dc),
    jump: resolveJump(dc),
    keepAliveInterval: 15_000,
    keepAliveCountMax: 3,
  });
  if (!(await client.connect()))
    return fail(502, `Could not connect to ${device}: ${client.lastError ?? "unknown error"}`);
  let channel: ClientChannel;
  try {
    channel = await client.shell({
      term: "xterm-256color",
      cols: clampSize(size.cols, 120, 500),
      rows: clampSize(size.rows, 30, 200),
    });
  } catch (e) {
    client.disconnect();
    return fail(502, `Could not open a shell on ${device}: ${e instanceof Error ? e.message : e}`);
  }

  const id = crypto.randomUUID();
  const opened = Date.now();
  const recording = startRecording(
    device,
    clampSize(size.cols, 120, 500),
    clampSize(size.rows, 30, 200),
  );
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const close = (reason: string): void => {
    if (closed) return;
    closed = true;
    const session = sessions.get(id);
    if (session?.idle) clearTimeout(session.idle);
    sessions.delete(id);
    try {
      channel.close();
    } catch {
      /* channel already closed */
    }
    client.disconnect();
    recording?.end();
    try {
      controller?.close();
    } catch {
      /* the viewer already left */
    }
    logger.info(`Terminal shell ${id} on '${device}' closed (${reason}); ${sessions.size} open`);
    recordToolCall({
      tool: "dashboard_terminal",
      title: "Dashboard Terminal",
      risk: "WRITE",
      device,
      deviceTransport: "ssh",
      ts: opened,
      durationMs: Date.now() - opened,
      isError: false,
      args: { shell: "interactive session" },
      output: `Interactive shell closed (${reason}). ${recording ? "The router's output was recorded; typed keys are not." : "This session was not recorded."}`,
      hasStructured: false,
    });
  };
  const touch = (): void => {
    const session = sessions.get(id);
    if (!session) return;
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => close("idle for 30 minutes"), IDLE_MS);
  };
  sessions.set(id, { device, client, channel, opened, idle: undefined, close });
  touch();
  logger.info(`Terminal shell ${id} on '${device}' opened; ${sessions.size} open`);

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      const push = (data: Buffer): void => {
        if (closed) return;
        recording?.write(data);
        try {
          streamController.enqueue(new Uint8Array(data));
        } catch {
          close("viewer left");
        }
      };
      channel.on("data", push);
      channel.stderr.on("data", push);
      channel.on("close", () => close("router closed the session"));
      channel.on("error", () => close("channel error"));
    },
    cancel() {
      close("viewer left");
    },
  });
  signal.addEventListener("abort", () => close("viewer left"), { once: true });
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-shell-id": id,
      "x-shell-host": client.connectedHost ?? "",
    },
  });
}

/** Send typed keys to a session. False when the session no longer exists. */
export function shellInput(id: string, data: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.channel.write(data);
  if (session.idle) clearTimeout(session.idle);
  session.idle = setTimeout(() => session.close("idle for 30 minutes"), IDLE_MS);
  return true;
}

/** Tell the router the new window size. */
export function shellResize(id: string, cols: unknown, rows: unknown): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.channel.setWindow(clampSize(rows, 30, 200), clampSize(cols, 120, 500), 0, 0);
  return true;
}

export function closeShell(id: string): boolean {
  const session = sessions.get(id);
  session?.close("closed by the viewer");
  return Boolean(session);
}

/** Close every session (dashboard shutdown). */
export function closeAllShells(): void {
  for (const session of Array.from(sessions.values())) session.close("dashboard stopped");
}
