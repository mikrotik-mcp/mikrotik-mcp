#!/usr/bin/env bun
/**
 * One command for local development: the MCP server with the observability
 * API (port 9091) plus the dashboard's Vite dev server (port 9191, which
 * proxies /api and the live stream to 9091).
 *
 *   bun run dev:all
 *
 * Extra arguments go to the backend, e.g. `bun run dev:all --config devices.json`.
 * Ctrl+C stops both; if either process exits, the other is stopped too.
 */

import { spawn } from "bun";

const BACKEND_PORT = "9091";

type Proc = { name: string; color: string; cmd: string[] };

const procs: Proc[] = [
  {
    name: "backend",
    color: "\x1B[36m",
    cmd: [
      "bun",
      "run",
      "--watch",
      "--bun",
      "src/cli.ts",
      "serve",
      "--transport",
      "streamable-http",
      "--dashboard",
      "--dashboard-host",
      "127.0.0.1",
      "--dashboard-port",
      BACKEND_PORT,
      ...process.argv.slice(2),
    ],
  },
  {
    name: "dashboard",
    color: "\x1B[35m",
    cmd: ["bun", "run", "dev:dashboard"],
  },
];

const RESET = "\x1B[0m";

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) out.write(`${prefix}${line}\n`);
  }
  if (buffer) out.write(`${prefix}${buffer}\n`);
}

const width = Math.max(...procs.map((p) => p.name.length));
const children = procs.map((p) => {
  const child = spawn(p.cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const prefix = `${p.color}${p.name.padEnd(width)} │${RESET} `;
  void pipe(child.stdout, prefix, process.stdout);
  void pipe(child.stderr, prefix, process.stderr);
  return { ...p, child };
});

process.stdout.write(
  `\n  Dashboard: http://localhost:9191   API: http://127.0.0.1:${BACKEND_PORT}   MCP: http://localhost:8000/mcp\n  Press Ctrl+C to stop both.\n`,
);

let stopping = false;
function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

const first = await Promise.race(
  children.map(({ name, child }) => child.exited.then((code) => ({ name, code }))),
);
if (!stopping) {
  console.error(`\n${first.name} exited with code ${first.code}; stopping the rest.`);
  stopAll(first.code ?? 1);
}
