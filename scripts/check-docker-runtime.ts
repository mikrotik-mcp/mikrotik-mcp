/**
 * Run inside an isolated test container, never against a production service.
 * No SDK, host Bun, credentials or router access needed. The workflow supplies
 * a disposable writable JSON and disables container networking.
 */
import { strict as assert } from "node:assert";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const expectedArch = process.argv[2];
assert(["x64", "arm64"].includes(expectedArch), "Pass the native runner architecture");
assert.equal(process.platform, "linux");
assert.equal(process.arch, expectedArch);
assert.equal(process.getuid?.(), 1000, "The service must run as bun, not root");
const pkg = JSON.parse(readFileSync("/app/package.json", "utf8"));
assert.equal(globalThis.Bun.version, pkg.packageManager.replace("bun@", ""));

const configPath = process.env.MIKROTIK_CONFIG_FILE;
assert(configPath, "The mounted configuration must be selected");
const original = readFileSync(configPath, "utf8");
const config = JSON.parse(original);
assert.equal(config.defaultDevice, "offline", "Only use the disposable smoke fixture");
assert.deepEqual(Object.keys(config.devices), ["offline"]);
assert.equal(config.devices.offline.host, "127.0.0.1");
assert.equal(config.devices.offline.port, 1);
assert.equal(config.devices.offline.disabled, true);
assert.equal(statSync("/home/bun/.mikrotik-mcp").uid, 1000);
writeFileSync(configPath, original);
assert.equal(readFileSync(configPath, "utf8"), original, "Mounted JSON must remain writable");

const base = `http://127.0.0.1:${config.mcp.port}`;
assert.equal((await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).status, 200);
const dashboard = await fetch(`http://127.0.0.1:${config.dashboard.port}/`, {
  signal: AbortSignal.timeout(5000),
});
assert.equal(dashboard.status, 200);
assert.match(dashboard.headers.get("content-type") ?? "", /text\/html/);
assert.match(await dashboard.text(), /<html/i);

let session: string | undefined;
let protocol: string | undefined;
let nextId = 0;

/** Read either JSON or the server's finite JSON-RPC SSE response. */
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
      ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `${method} failed`);
  session ??= response.headers.get("mcp-session-id") ?? undefined;
  const text = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
    : [JSON.parse(text)];
  const message = messages.find((entry) => entry.id === id);
  assert(message, `${method} returned no matching JSON-RPC result`);
  assert.equal(message.error, undefined, `${method}: ${JSON.stringify(message.error)}`);
  return message.result;
}

try {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "docker-native-smoke", version: "1" },
  });
  assert.equal(initialized.serverInfo.version, pkg.version);
  protocol = initialized.protocolVersion;
  const ready = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
      "MCP-Protocol-Version": protocol!,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(ready.status, 202);
  await ready.body?.cancel();
  const names: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await rpc("tools/list", cursor ? { cursor } : {});
    names.push(...page.tools.map((tool: { name: string }) => tool.name));
    cursor = page.nextCursor;
    if (cursor) {
      assert(!cursors.has(cursor), "MCP pagination must make progress");
      cursors.add(cursor);
      assert(cursors.size < 100, "MCP pagination must finish");
    }
  } while (cursor);
  assert(
    names.includes("list_mikrotik_devices"),
    "The built catalog must include device discovery",
  );
  assert.equal(new Set(names).size, names.length, "Tool names must be unique");
  process.stdout.write(
    `Native ${process.platform}/${process.arch}: Bun ${globalThis.Bun.version}, MCP ${pkg.version}, ${names.length} tools, health, dashboard and writable JSON passed.\n`,
  );
} finally {
  if (session) {
    const response = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": session,
        ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
  }
}
