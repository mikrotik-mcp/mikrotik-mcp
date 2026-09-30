/**
 * Minimal leveled logger that always writes to **stderr**.
 *
 * This is critical for the stdio transport: stdout is the JSON-RPC channel
 * between the MCP client and this server, so a stray `console.log` would corrupt
 * the protocol stream. Everything diagnostic therefore goes to stderr, which the
 * client treats as a side-channel it can surface in its logs.
 */
import { stderr } from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ENV_LEVEL = (process.env.MIKROTIK_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
const THRESHOLD = LEVELS[ENV_LEVEL] ?? LEVELS.info;

const COLORS: Record<LogLevel, string> = {
  debug: "\x1B[90m", // gray
  info: "\x1B[36m", // cyan
  warn: "\x1B[33m", // yellow
  error: "\x1B[31m", // red
};
const RESET = "\x1B[0m";
const useColor = stderr.isTTY ?? false;

/** Bound diagnostics only; never use this for device commands or tool results. */
export function formatLogMessage(message: string): string {
  const compact = message.replace(
    /\bfrom=\*[\da-f]+(?:,\*[\da-f]+)+/gi,
    (list) => `from=<${list.split(",").length} IDs omitted>`,
  );
  const maxLength = 1024;
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength)}… [${compact.length - maxLength} chars omitted]`;
}

function emit(level: LogLevel, message: string): void {
  if (LEVELS[level] < THRESHOLD) return;
  const tag = useColor ? `${COLORS[level]}${level.toUpperCase()}${RESET}` : level.toUpperCase();
  stderr.write(`[mikrotik-mcp] ${tag} ${formatLogMessage(message)}\n`);
}

export const logger = {
  debug: (m: string) => emit("debug", m),
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m),
  error: (m: string) => emit("error", m),
};
