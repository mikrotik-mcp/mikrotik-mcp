/**
 * Audit export: every finished tool call as one RFC 5424 syslog message, for a
 * SIEM or a log collector.
 *
 * The message is built from the sanitised {@link ToolEvent}, so secrets are
 * already redacted. It carries who-did-what as structured data
 * (`[mcp@32473 tool="…" risk="…" device="…" …]`), which a collector can index
 * without parsing free text.
 *
 * Delivery is best-effort and never blocks or fails a tool call. UDP sends one
 * datagram for each message. TCP keeps one connection, frames each message
 * with its length (RFC 6587 octet counting) and reconnects on the next message
 * after an error. A message that cannot be sent is dropped.
 */
import { createSocket } from "node:dgram";
import type { Socket as UdpSocket } from "node:dgram";
import { connect } from "node:net";
import type { Socket as TcpSocket } from "node:net";
import { hostname } from "node:os";
import { logger } from "../logger";
import type { ToolEvent } from "./event";

export interface SyslogConfig {
  host: string;
  port?: number;
  protocol?: "udp" | "tcp";
  /** Syslog facility number. Default 13 (log audit). */
  facility?: number;
  appName?: string;
  /** Add the redacted arguments of the call to the message. Default false. */
  includeInput?: boolean;
  /** Send only calls that can change a router (not READ). Default false. */
  writesOnly?: boolean;
}

/** Private enterprise number reserved for examples and documentation (RFC 5612). */
const SD_ID = "mcp@32473";
/** One message stays inside a common UDP syslog limit. */
const MAX_MESSAGE = 2048;

/** Escape a structured-data value: `"`, `\` and `]` (RFC 5424 §6.3.3). */
const sd = (value: string): string => value.replace(/[\\"\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
/** A header field: printable ASCII with no space, or `-` when empty. */
const field = (value: string, max: number): string =>
  value.replace(/[^\x21-\x7E]/g, "_").slice(0, max) || "-";

/** Syslog severity: an error is 3, a dangerous or destructive call 5, others 6. */
function severityOf(event: ToolEvent): number {
  if (event.isError) return 3;
  return event.risk === "DANGEROUS" || event.risk === "DESTRUCTIVE" ? 5 : 6;
}

export function formatSyslog(event: ToolEvent, cfg: SyslogConfig, host = hostname()): string {
  const priority = (cfg.facility ?? 13) * 8 + severityOf(event);
  const data: [string, string | undefined][] = [
    ["callId", event.id],
    ["tool", event.tool],
    ["risk", event.risk],
    ["device", event.device],
    ["transport", event.transport],
    ["outcome", event.isError ? "error" : "ok"],
    ["durationMs", String(event.durationMs)],
    ["reason", event.reason],
  ];
  const structured = data
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([key, value]) => `${key}="${sd(value)}"`)
    .join(" ");
  const text = [
    `${event.tool}${event.device ? ` on ${event.device}` : ""}: ${event.isError ? `error: ${event.error ?? "failed"}` : "ok"}`,
    ...(cfg.includeInput && event.input ? [`input=${event.input}`] : []),
  ]
    .join(" ")
    .replace(/[\r\n]+/g, " ");
  const message =
    `<${priority}>1 ${new Date(event.ts).toISOString()} ${field(host, 255)} ` +
    `${field(cfg.appName ?? "mikrotik-mcp", 48)} ${process.pid} ${field(event.tool, 32)} ` +
    `[${SD_ID} ${structured}] ${text}`;
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
}

export interface AuditSink {
  send: (event: ToolEvent) => void;
  close: () => void;
}

export function createSyslogSink(cfg: SyslogConfig): AuditSink {
  const port = cfg.port ?? 514;
  let udp: UdpSocket | undefined;
  let tcp: TcpSocket | undefined;
  const failed = (error: Error): void => {
    logger.debug(`[audit] syslog ${cfg.host}:${port} failed: ${error.message}`);
  };

  const write = (line: string): void => {
    const bytes = Buffer.from(line, "utf8");
    if (cfg.protocol === "tcp") {
      if (!tcp || tcp.destroyed) {
        const socket = connect({ host: cfg.host, port });
        socket.unref();
        socket.on("error", (error) => {
          failed(error);
          socket.destroy();
        });
        tcp = socket;
      }
      // A collector that stopped reading must not grow this process's memory.
      if (tcp.writableLength > 1024 * 1024) return;
      tcp.write(Buffer.concat([Buffer.from(`${bytes.length} `), bytes]));
      return;
    }
    if (!udp) {
      udp = createSocket("udp4");
      udp.unref();
      udp.on("error", failed);
    }
    udp.send(bytes, port, cfg.host, (error) => {
      if (error) failed(error);
    });
  };

  return {
    send(event) {
      if (cfg.writesOnly && event.risk === "READ") return;
      try {
        write(formatSyslog(event, cfg));
      } catch (error) {
        failed(error as Error);
      }
    },
    close() {
      try {
        udp?.close();
      } catch {
        /* already closed */
      }
      tcp?.destroy();
      udp = undefined;
      tcp = undefined;
    },
  };
}
