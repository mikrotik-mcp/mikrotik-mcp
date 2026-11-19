/**
 * A small SMTP client for the email alert channel. It sends one plain-text
 * message and closes.
 *
 * - Port 465 (or `secure: true`) connects with TLS. Any other port starts in
 *   clear text and upgrades with STARTTLS when the server offers it.
 * - A password is **never** sent over a connection that is not encrypted: when
 *   credentials are set and the server offers no STARTTLS, the send fails.
 * - Addresses and the subject come from configuration and alert text. CR and LF
 *   are removed from every header value, so an alert title cannot add headers.
 *
 * `node:net` and `node:tls` (not `Bun.connect`) so the Vitest import graph,
 * which stubs the `bun` module, can load and test it.
 */
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface SmtpConfig {
  host: string;
  port?: number;
  /** TLS from the first byte (port 465). Default: true for 465, else STARTTLS. */
  secure?: boolean;
  username?: string;
  password?: string;
  from: string;
  /** One address, or several separated by commas. */
  to: string;
}

const ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+$/;

/** The recipients of a comma-separated list. Throws on an address that is not plain. */
export function recipients(to: string): string[] {
  const list = to
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error("email channel has no recipient");
  for (const address of list)
    if (!ADDRESS.test(address)) throw new Error(`"${address}" is not an email address`);
  return list;
}

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

/** The message as it goes after DATA: headers, a blank line, the dot-stuffed body. */
export function buildMessage(from: string, to: string[], subject: string, text: string): string {
  const body = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return [
    `From: ${oneLine(from)}`,
    `To: ${to.join(", ")}`,
    `Subject: =?UTF-8?B?${Buffer.from(oneLine(subject)).toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
}

/** Reads SMTP replies (one or more `250-…` lines closed by `250 …`) from a socket. */
function replies(socket: Socket): { next: () => Promise<{ code: number; text: string }> } {
  let buffer = "";
  let waiting: ((reply: { code: number; text: string }) => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const flush = (): void => {
    // A reply ends at the first line whose fourth character is a space.
    const end = buffer.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/);
    if (!end || !waiting) return;
    const text = end[0];
    buffer = buffer.slice(text.length);
    const done = waiting;
    waiting = undefined;
    done({ code: Number(end[1]), text: text.trim() });
  };
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    flush();
  });
  const stop = (error: Error): void => failed?.(error);
  socket.on("error", stop);
  socket.on("close", () => stop(new Error("the mail server closed the connection")));
  return {
    next: () =>
      new Promise((resolve, reject) => {
        waiting = resolve;
        failed = reject;
        flush();
      }),
  };
}

/** Send one message. Rejects with a short reason; never includes the password. */
export async function sendMail(
  cfg: SmtpConfig,
  subject: string,
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  const to = recipients(cfg.to);
  if (!ADDRESS.test(cfg.from.trim())) throw new Error("email channel has no valid sender");
  const port = cfg.port ?? 587;
  const secure = cfg.secure ?? port === 465;

  let socket: Socket = secure
    ? tlsConnect({ host: cfg.host, port, servername: cfg.host })
    : netConnect({ host: cfg.host, port });
  let encrypted = secure;
  const timer = setTimeout(
    () => socket.destroy(new Error(`mail server timed out (${timeoutMs}ms)`)),
    timeoutMs,
  );
  try {
    let reader = replies(socket);
    const expect = async (codes: number[], what: string): Promise<string> => {
      const reply = await reader.next();
      if (!codes.includes(reply.code))
        throw new Error(`mail server refused ${what}: ${reply.text.slice(0, 200)}`);
      return reply.text;
    };
    const send = (line: string, codes: number[], what: string): Promise<string> => {
      socket.write(`${line}\r\n`);
      return expect(codes, what);
    };

    await expect([220], "the connection");
    let hello = await send("EHLO mikrotik-mcp", [250], "EHLO");
    if (!encrypted && /^250[- ]STARTTLS\b/im.test(hello)) {
      await send("STARTTLS", [220], "STARTTLS");
      socket.removeAllListeners("data");
      socket = await new Promise<Socket>((resolve, reject) => {
        const upgraded = tlsConnect({ socket, servername: cfg.host }, () => resolve(upgraded));
        upgraded.once("error", reject);
      });
      encrypted = true;
      reader = replies(socket);
      hello = await send("EHLO mikrotik-mcp", [250], "EHLO");
    }
    if (cfg.username) {
      if (!encrypted)
        throw new Error(
          "the mail server offers no TLS: the password is not sent over a clear connection",
        );
      const token = Buffer.from(`\0${cfg.username}\0${cfg.password ?? ""}`).toString("base64");
      await send(`AUTH PLAIN ${token}`, [235], "the login");
    }
    await send(`MAIL FROM:<${cfg.from.trim()}>`, [250], "the sender");
    for (const address of to) await send(`RCPT TO:<${address}>`, [250, 251], "a recipient");
    await send("DATA", [354], "DATA");
    await send(`${buildMessage(cfg.from, to, subject, text)}\r\n.`, [250], "the message");
    socket.write("QUIT\r\n");
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
