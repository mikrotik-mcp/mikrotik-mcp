/**
 * ToolContext is the lightweight per-call logging surface handed to every tool
 * handler
 *
 * Diagnostic messages are written to stderr (never stdout, which the stdio
 * transport reserves for JSON-RPC) and, when the MCP client has opted into
 * logging notifications, forwarded over the protocol too.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatLogMessage, logger } from "../logger";
import { redactAuditText } from "../observability/event";

export interface ToolContext {
  /** Correlates this invocation with its result and saved activity record. */
  callId?: string;
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
  /**
   * Risk preset of the tool that owns this call (set by the registry). The
   * connector uses it to keep READ tools out of an open Safe Mode shell.
   * Unset for internal callers (samplers, dashboard routes).
   */
  risk?: "READ" | "WRITE" | "WRITE_IDEMPOTENT" | "DESTRUCTIVE" | "DANGEROUS";
  /**
   * The tools bound to the MCP server this call arrived on (set by the
   * registry). The tool gateway uses it to run, describe and point at other
   * tools without a second code path. Unset for internal callers.
   */
  tools?: ToolAccess;
  /** Set by the registry when this call returned another tool's finished result. */
  delegated?: boolean;
  /** Set by the registry when the handler opted out of the reachability hint line. */
  noHint?: boolean;
}

/** Access to the other tools of the same MCP server, for the tool gateway. */
export interface ToolAccess {
  /**
   * Run a tool through the SAME pipeline as a direct `tools/call`: device and
   * `reason` handling, access policy, guards, audit record. `undefined` when
   * the tool is not available on this server (unknown, read-only mode,
   * filtered out).
   */
  run(name: string, args: Record<string, unknown>): Promise<CallToolResult> | undefined;
  /** The Zod shape a direct call is validated against (with `device` / `reason`). */
  shape(name: string): Record<string, unknown> | undefined;
  /** The JSON Schema exactly as `tools/list` publishes it for this tool. */
  schema(name: string): Record<string, unknown> | undefined;
  /**
   * True when a hint may tell the client to call the tool by name. In `core`
   * surface mode that is every listed tool. In `full` mode only the pinned
   * core set: the rest is listed too, but a host with a large catalog may not
   * have loaded it, so hints must give an `invoke_tool` call for those.
   */
  direct(name: string): boolean;
}

/** How a device command was actually carried. */
export type DeviceTransport = "ssh" | "rest" | "mac-telnet";

export type SendLog = (level: "info" | "error", message: string) => void;

/**
 * Build a context. `sendLog`, when provided, forwards messages to the connected
 * MCP client as logging notifications in addition to the local stderr log.
 * `device` is the target device name selected for this tool call.
 */
export function createContext(sendLog?: SendLog, device?: string, callId?: string): ToolContext {
  return {
    device,
    callId,
    info(message: string) {
      const safe = redactAuditText(message);
      logger.info(callId ? `[${callId}] ${safe}` : safe);
      sendLog?.("info", formatLogMessage(safe));
    },
    error(message: string) {
      const safe = redactAuditText(message);
      logger.error(callId ? `[${callId}] ${safe}` : safe);
      sendLog?.("error", formatLogMessage(safe));
    },
  };
}
