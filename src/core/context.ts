/**
 * ToolContext is the lightweight per-call logging surface handed to every tool
 * handler
 *
 * Diagnostic messages are written to stderr (never stdout, which the stdio
 * transport reserves for JSON-RPC) and, when the MCP client has opted into
 * logging notifications, forwarded over the protocol too.
 */
import { logger } from "../logger";

export interface ToolContext {
  /** Informational progress message. */
  info: (message: string) => void;
  /** Error / failure message. */
  error: (message: string) => void;
  /**
   * Name of the device this call targets, when the client selected one.
   * `undefined` means "use the configured default device".
   */
  device?: string;
  /**
   * Which transport actually carried the last device command of this call.
   *
   * Recorded here rather than in a module-level global because tool calls run
   * concurrently — a shared "last transport used" would be overwritten by
   * whichever device answered most recently. One context per call makes this
   * safe for free.
   *
   * A tool that issues several commands reports the LAST one; that is exact for
   * the single-command majority and representative otherwise.
   */
  transport?: DeviceTransport;
  /**
   * Why REST fell back to SSH on the last command, when it did. Present only
   * for a device with `api: true` that could not use REST — the reason is the
   * whole diagnostic value, since a silent fallback otherwise looks like REST
   * simply never being enabled.
   */
  restFallback?: string;
}

/** How a device command was actually carried. */
export type DeviceTransport = "ssh" | "rest" | "mac-telnet";

export type SendLog = (level: "info" | "error", message: string) => void;

/**
 * Build a context. `sendLog`, when provided, forwards messages to the connected
 * MCP client as logging notifications in addition to the local stderr log.
 * `device` is the target device name selected for this tool call.
 */
export function createContext(sendLog?: SendLog, device?: string): ToolContext {
  return {
    device,
    info(message: string) {
      logger.info(message);
      sendLog?.("info", message);
    },
    error(message: string) {
      logger.error(message);
      sendLog?.("error", message);
    },
  };
}
