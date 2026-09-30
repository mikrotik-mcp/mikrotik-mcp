/**
 * Automatic memory recording — bridges tool execution to the knowledge graph.
 *
 * Called from the registry's `finally` block after every tool call. When memory
 * is enabled it:
 *   1. Auto-creates a device entity on first contact (idempotent).
 *   2. Logs the tool call in `memory_activity` so the dashboard and
 *      `memory_read_graph` reflect real activity without explicit AI action.
 *
 * Entirely fire-and-forget — never throws, never slows the tool path.
 */
import { getMemoryStore, isMemoryEnabled } from "./accessor";

export interface ToolMemoryRecord {
  tool: string;
  device?: string;
  isError: boolean;
  durationMs: number;
}

/**
 * Record a tool call to the knowledge graph. Safe to call on every invocation —
 * returns immediately when memory is disabled, and swallows all errors.
 */
export function recordToolToMemory(record: ToolMemoryRecord): void {
  if (!isMemoryEnabled() || record.tool.startsWith("memory_")) return;
  void (async () => {
    try {
      const store = await getMemoryStore();

      // Auto-create a device entity on first contact (INSERT OR IGNORE).
      if (record.device && !record.isError) {
        store.createEntities([{ name: record.device, entityType: "device" }]);
      }

      // Log the tool call in the activity table.
      store.logActivity("tool_call", record.tool, {
        device: record.device,
        durationMs: record.durationMs,
        isError: record.isError,
      });
    } catch {
      // Observability must never disrupt the tool path.
    }
  })();
}
