/**
 * End to end with the real mcp-remote proxy (the one Claude Desktop runs): after
 * the HTTP server restarts, the proxy's session id is unknown. The server must
 * answer 404 so the proxy initializes again by itself and the call succeeds.
 *
 * No router is involved: the only device is an RFC 5737 documentation address
 * and the tool called (`find_tools`) searches the catalog without device I/O.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";

const root = resolve(import.meta.dirname, "..");
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const probe = createServer().on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });

async function startServer(port: number, home: string) {
  const child = spawn(
    "bun",
    [
      "--no-env-file",
      "src/cli.ts",
      "serve",
      "--transport=streamable-http",
      "--mcp-host=127.0.0.1",
      `--mcp-port=${port}`,
      "--dashboard=false",
      "--host=192.0.2.1",
    ],
    // A clean environment and an empty HOME: no real device config can load.
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: home, MIKROTIK_DISABLE_UPDATE_CHECK: "true" },
    },
  );
  children.push(child);
  let log = "";
  child.stderr.on("data", (chunk) => (log += chunk));
  for (let i = 0; i < 150; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return { child, log: () => log };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}

const stopped = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((done) => {
    child.once("exit", () => done());
    child.kill("SIGKILL");
  });

test("mcp-remote 0.14.3 initializes again by itself after the server restarts", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-session-e2e-"));
  const port = await freePort();
  const first = await startServer(port, home);

  const proxy = spawn(
    "node",
    [
      join(root, "node_modules/mcp-remote/dist/proxy.js"),
      `http://127.0.0.1:${port}/mcp`,
      "--transport",
      "http-only",
      "--keep-alive",
    ],
    { env: { PATH: process.env.PATH, HOME: home, MCP_REMOTE_CONFIG_DIR: home } },
  );
  children.push(proxy);
  let proxyLog = "";
  proxy.stderr.on("data", (chunk) => (proxyLog += chunk));

  // Newline-delimited JSON-RPC over the proxy's stdio, as Claude Desktop does.
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  proxy.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const call = (method: string, params: unknown) => {
    const id = nextId++;
    return new Promise<Record<string, any>>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`${method} timed out. Proxy log:\n${proxyLog}`)),
        30_000,
      );
      waiting.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const findTools = () =>
    call("tools/call", { name: "find_tools", arguments: { query: "list interfaces" } });

  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "session-recovery-test", version: "1" },
  });
  expect(init.result.serverInfo).toBeDefined();
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const before = await findTools();
  expect(before.error).toBeUndefined();
  expect(first.log()).toMatch(/MCP session \S+ created/);

  // The restart: every session the proxy knows is gone.
  await stopped(first.child);
  const second = await startServer(port, home);

  const after = await findTools();
  expect(after.error, proxyLog).toBeUndefined();
  expect(after.result.content[0].text).toContain("Found");
  // The new server process saw a new initialize, sent by the proxy alone.
  expect(second.log()).toMatch(/MCP session \S+ created/);
}, 90_000);
