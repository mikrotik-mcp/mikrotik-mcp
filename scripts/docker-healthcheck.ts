/** Container process liveness only; deliberately does not probe any router. */
import { readFileSync } from "node:fs";

try {
  const path = process.env.MIKROTIK_CONFIG_FILE;
  const config = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  const port = String(process.env.MIKROTIK_MCP__PORT ?? config.mcp?.port ?? 8000);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) process.exit(1);
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
