/**
 * Interactive shell sessions for the dashboard terminal — a real RouterOS
 * console (PTY), as in WinBox: menus you can enter, y/n prompts, live monitors.
 *
 * Each session has its own SSH connection, apart from the pool, because an
 * interactive channel is long-lived. The browser reads the output as one
 * streamed HTTP response and sends keys with small POSTs, so this works through
 * the remote-dashboard proxy too.
 *
 * Keys are not recorded: only the opening and closing of a session reach the
 * audit feed. The block terminal records every command.
 */
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
      output: `Interactive shell closed (${reason}). Keys typed in a shell are not recorded.`,
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
