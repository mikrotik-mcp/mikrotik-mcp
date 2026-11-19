/// <reference types="bun" />
/** Audit export: tool calls as RFC 5424 syslog messages. Loopback sockets only. */
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vite-plus/test";
import { createSyslogSink, formatSyslog } from "../../src/observability/audit-syslog";
import type { ToolEvent } from "../../src/observability/event";
import {
  configureRecorder,
  recordToolCall,
  setAuditSink,
  shutdownRecorder,
} from "../../src/observability/recorder";

const event = (over: Partial<ToolEvent> = {}): ToolEvent =>
  ({
    id: "call-1",
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    tool: "add_ip_address",
    title: "Add IP",
    risk: "WRITE",
    device: 'edge "a"]',
    transport: "stdio",
    durationMs: 42,
    isError: false,
    input: '{"address":"10.0.0.1/24"}',
    output: "",
    outputBytes: 0,
    hasStructured: false,
    truncated: false,
    ...over,
  }) as ToolEvent;

afterEach(() => {
  setAuditSink();
  shutdownRecorder();
});

test("a call becomes one RFC 5424 line with escaped structured data", () => {
  const line = formatSyslog(event(), { host: "x" }, "mcp host");
  // facility 13 (audit) * 8 + severity 6 (info)
  expect(line.startsWith("<110>1 2026-01-02T03:04:05.000Z mcp_host mikrotik-mcp ")).toBe(true);
  expect(line).toContain('[mcp@32473 callId="call-1" tool="add_ip_address" risk="WRITE"');
  expect(line).toContain('device="edge \\"a\\"\\]"');
  expect(line).toContain('outcome="ok" durationMs="42"]');
  expect(line).not.toContain("input=");

  const failed = formatSyslog(
    event({ isError: true, error: "bad\ncommand", risk: "DANGEROUS", reason: "maintenance" }),
    { host: "x", includeInput: true, facility: 4 },
    "h",
  );
  expect(failed.startsWith("<35>1 ")).toBe(true); // 4 * 8 + 3 (error)
  expect(failed).toContain('reason="maintenance"');
  expect(failed).toContain("error: bad command input={");
  expect(failed).not.toContain("\n");
  expect(formatSyslog(event({ risk: "DESTRUCTIVE" }), { host: "x" }).startsWith("<109>1 ")).toBe(
    true,
  );
  expect(
    formatSyslog(event({ input: "x".repeat(5000) }), { host: "x", includeInput: true }).length,
  ).toBe(2048);
});

test("udp sends one datagram for each call, and writesOnly skips reads", async () => {
  const server = createSocket("udp4");
  const got: string[] = [];
  server.on("message", (message) => got.push(message.toString()));
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  const sink = createSyslogSink({
    host: "127.0.0.1",
    port: server.address().port,
    writesOnly: true,
  });
  try {
    sink.send(event({ risk: "READ", tool: "list_routes" }));
    sink.send(event());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('tool="add_ip_address"');
  } finally {
    sink.close();
    server.close();
  }
});

test("tcp frames each message with its length", async () => {
  let received = "";
  const server = createServer((socket) =>
    socket.on("data", (chunk) => (received += chunk.toString())),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sink = createSyslogSink({
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    protocol: "tcp",
  });
  try {
    sink.send(event());
    sink.send(event({ id: "call-2" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const length = Number(received.slice(0, received.indexOf(" ")));
    const first = received.slice(received.indexOf(" ") + 1, received.indexOf(" ") + 1 + length);
    expect(first.startsWith("<110>1 ")).toBe(true);
    expect(Buffer.byteLength(first)).toBe(length);
    expect(received).toContain('callId="call-2"');
  } finally {
    sink.close();
    server.close();
  }
});

const raw = {
  tool: "create_ppp_secret",
  title: "t",
  risk: "WRITE" as const,
  ts: 1,
  durationMs: 1,
  isError: false,
  args: { name: "u", password: "hunter2" },
  output: "ok",
  hasStructured: false,
};

test("the sink gets redacted events with the dashboard off, and cannot break a call", () => {
  const seen: ToolEvent[] = [];
  setAuditSink((e) => seen.push(e));
  // No store: nothing is recorded, but the audit export still gets the call.
  expect(recordToolCall(raw, "a-b-c-d-1")).toBe(false);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.input).not.toContain("hunter2");

  setAuditSink(() => {
    throw new Error("collector down");
  });
  const inserted: ToolEvent[] = [];
  configureRecorder({
    store: { insert: (e: ToolEvent) => inserted.push(e), prune: () => 0, close: () => {} } as never,
    capture: { captureBody: true, maxBodyBytes: 4096 },
    maxEvents: 10,
  });
  expect(recordToolCall(raw, "a-b-c-d-2")).toBe(true);
  expect(inserted).toHaveLength(1);
});
