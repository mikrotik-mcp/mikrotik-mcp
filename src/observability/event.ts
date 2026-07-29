/**
 * Observability event model — the shape recorded for every MCP tool call the
 * LLM makes against this server, and the helpers that build one safely.
 *
 * The dashboard's interceptor sits at the registry choke point: every tool
 * invocation (input args → output text) becomes one {@link ToolEvent}. Because
 * tool inputs can carry secrets (passwords, private keys, pre-shared keys), we
 * **redact** sensitive fields before anything is persisted or streamed, and we
 * **truncate** large bodies to a configured byte budget.
 *
 * Pure and dependency-free (no `bun:sqlite`, no I/O) so it loads under the Node
 * test runner and is trivially unit-testable.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Coarse risk class derived from a tool's MCP annotations. */
export type Risk = "READ" | "WRITE" | "WRITE_IDEMPOTENT" | "DESTRUCTIVE" | "DANGEROUS";

/** One recorded tool call: the unit the dashboard streams, stores and charts. */
export interface ToolEvent {
  /** Monotonic-ish unique id (epoch-ms + counter), assigned by the recorder. */
  id: string;
  /** Epoch milliseconds when the call started. */
  ts: number;
  /** Tool name (e.g. `list_interfaces`). */
  tool: string;
  /** Tool display title. */
  title: string;
  /** Risk class derived from the tool's annotations. */
  risk: Risk;
  /** Target device name, when resolvable. */
  device?: string;
  /** Transport the call arrived on (`stdio` / `http`). */
  transport?: string;
  /**
   * Which transport carried the DEVICE command — distinct from `transport`
   * above, which is how the MCP client reached this server. A REST-enabled
   * device that fell back reports `ssh` here, with the reason in
   * `restFallback`.
   */
  deviceTransport?: "ssh" | "rest" | "mac-telnet";
  /** Why REST fell back to SSH, when a REST-enabled device did not use it. */
  restFallback?: string;
  /** Wall-clock duration of the handler, in milliseconds. */
  durationMs: number;
  /** True when the result was an error (`isError`) or the handler threw. */
  isError: boolean;
  /** Error message when `isError`, else undefined. */
  error?: string;
  /** JSON of the input arguments — redacted unless `redactInput` is off — possibly truncated. */
  input: string;
  /** Possibly-truncated text output returned to the model. */
  output: string;
  /** Byte length of the full (pre-truncation) output. */
  outputBytes: number;
  /** True when the tool also returned `structuredContent` (drives an MCP App view). */
  hasStructured: boolean;
  /** True when either body was truncated to the byte budget. */
  truncated: boolean;
  /** LLM-provided rationale for dangerous actions (auto-injected audit field). */
  reason?: string;
}

/** Map MCP annotations to a coarse risk class (mirrors the registry presets). */
export function riskOf(a: ToolAnnotations | undefined): Risk {
  if (!a) return "WRITE";
  if (a.readOnlyHint) return "READ";
  if (a.destructiveHint) return a.idempotentHint ? "DESTRUCTIVE" : "DANGEROUS";
  return a.idempotentHint ? "WRITE_IDEMPOTENT" : "WRITE";
}

/** Keys whose values are secrets and must never be stored verbatim. */
const SENSITIVE_KEY = /pass|secret|private[-_]?key|passphrase|psk|preshared|token|credential/i;
/** The marker {@link redact} substitutes for any secret value. */
export const REDACTED = "«redacted»";

/**
 * Deep-clone `value`, replacing any string under a sensitive key with a marker.
 * Arrays and nested objects are walked; non-objects pass through unchanged.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && v != null && v !== "" ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

/** Truncate `text` to `maxBytes` (UTF-16 length proxy), flagging if it was cut. */
export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0 || text.length <= maxBytes) return { text, truncated: false };
  return { text: `${text.slice(0, maxBytes)}…`, truncated: true };
}

/** Options controlling how bodies are captured. */
export interface CaptureOptions {
  /** When false, input/output bodies are dropped (only metadata kept). */
  captureBody: boolean;
  /** Per-body truncation budget. */
  maxBodyBytes: number;
  /**
   * Mask secret-looking input fields (password / key / psk / token / …) before
   * storing. Omitted or `true` → redact (the safe default). Set `false` to store
   * inputs verbatim — convenient for debugging, but secrets then hit disk and the
   * dashboard.
   */
  redactInput?: boolean;
}

/** Raw inputs the recorder has on hand when a call finishes. */
export interface RawCall {
  tool: string;
  title: string;
  risk: Risk;
  device?: string;
  transport?: string;
  deviceTransport?: "ssh" | "rest" | "mac-telnet";
  restFallback?: string;
  ts: number;
  durationMs: number;
  isError: boolean;
  error?: string;
  args: unknown;
  output: string;
  hasStructured: boolean;
  reason?: string;
}

/** Build a sanitised {@link ToolEvent} (sans id) from a finished call. */
export function buildEvent(raw: RawCall, id: string, opts: CaptureOptions): ToolEvent {
  const outputBytes = raw.output.length;
  let input = "";
  let output = "";
  let truncated = false;
  if (opts.captureBody) {
    const args = opts.redactInput === false ? raw.args : redact(raw.args);
    const rin = truncate(JSON.stringify(args ?? {}), opts.maxBodyBytes);
    const rout = truncate(raw.output, opts.maxBodyBytes);
    input = rin.text;
    output = rout.text;
    truncated = rin.truncated || rout.truncated;
  }
  return {
    id,
    ts: raw.ts,
    tool: raw.tool,
    title: raw.title,
    risk: raw.risk,
    device: raw.device,
    transport: raw.transport,
    deviceTransport: raw.deviceTransport,
    restFallback: raw.restFallback,
    durationMs: raw.durationMs,
    isError: raw.isError,
    error: raw.error,
    input,
    output,
    outputBytes,
    hasStructured: raw.hasStructured,
    truncated,
    reason: raw.reason,
  };
}
