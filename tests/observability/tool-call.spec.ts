import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MikrotikConfigSchema } from "../../src/config";
import { READ, WRITE, defineTool } from "../../src/core/registry";
import type { RegisterableTool } from "../../src/core/registry";
import { getConfig, setConfig } from "../../src/core/runtime";
import { resetSessionScope } from "../../src/core/access";
import { buildEvent, redactAuditText } from "../../src/observability/event";
import type { ToolEvent } from "../../src/observability/event";
import type { EventStore } from "../../src/observability/store";
import { configureRecorder, shutdownRecorder, subscribe } from "../../src/observability/recorder";
import { toolGatewayTools } from "../../src/tools/tool-gateway";
import { logger } from "../../src/logger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const original = getConfig();
let rows: Map<string, ToolEvent>;
let store: EventStore;

/** Capture registered MCP behavior without a router or production database. */
function register(tool: RegisterableTool) {
  let callback!: (args: Record<string, unknown>) => Promise<CallToolResult>;
  tool.register(
    {
      registerTool: (_name: string, _config: unknown, cb: typeof callback) => {
        callback = cb;
      },
    } as never,
    { deviceNames: ["lab", "edge"] },
  );
  return (args: Record<string, unknown> = {}) => callback(args);
}
const text = (result: CallToolResult) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
const idOf = (result: CallToolResult) => result._meta?.["mikrotik/toolCallId"] as string;
const lookup = () => register(toolGatewayTools.find((t) => t.name === "get_tool_call")!);
const probe = (handler: RegisterableTool["handler"] = () => "ok") =>
  defineTool({
    name: "probe_call",
    title: "Probe",
    description: "test",
    annotations: READ,
    handler,
  });

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  resetSessionScope();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        lab: { host: "192.0.2.1" },
        edge: { host: "192.0.2.2", description: "Edge Router" },
      },
      defaultDevice: "lab",
    }),
  );
  rows = new Map();
  store = {
    insert: (e) => {
      rows.set(e.id, e);
    },
    get: (id) => rows.get(id) ?? null,
    query: () => [...rows.values()],
    total: () => rows.size,
    delete: (ids) => ids.reduce((n, id) => n + Number(rows.delete(id)), 0),
    clear: () => {
      const count = rows.size;
      rows.clear();
      return count;
    },
    prune: () => 0,
    close: () => {},
  };
  configureRecorder({
    store,
    capture: { captureBody: true, maxBodyBytes: 16_384 },
    maxEvents: 1000,
    transport: "http",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  shutdownRecorder();
  resetSessionScope();
  setConfig(original);
});

test("response, context, persisted history and live broadcast share one ID", async () => {
  let contextId: string | undefined;
  const events: ToolEvent[] = [];
  subscribe((e) => events.push(e));
  const result = await register(
    probe((_args, ctx) => {
      contextId = ctx.callId;
      ctx.info("Inspecting the interface");
      ctx.transport = "ssh";
      return { text: "ok", structuredContent: { untouched: true } };
    }),
  )();
  const id = idOf(result);
  expect(id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  expect(contextId).toBe(id);
  expect(text(result)).toContain(`Tool call ID: ${id}`);
  expect(result.structuredContent).toEqual({ untouched: true });
  expect(result._meta?.["mikrotik/recorded"]).toBe(true);
  expect(events[0]).toEqual(rows.get(id));
  expect(rows.get(id)).toMatchObject({
    id,
    tool: "probe_call",
    device: "lab",
    transport: "http",
    deviceTransport: "ssh",
    output: "ok",
    bodyCaptured: true,
  });
  expect(rows.get(id)?.logs?.[0]).toMatchObject({
    level: "info",
    message: "Inspecting the interface",
  });
});

test("MCP protocol preserves correlation metadata and retrieves a call by the returned ID", async () => {
  const server = new McpServer({ name: "call-test", version: "1" });
  const client = new Client({ name: "call-test-client", version: "1" });
  probe().register(server);
  toolGatewayTools.find((t) => t.name === "get_tool_call")!.register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "probe_call", arguments: {} });
    const callId = result._meta?.["mikrotik/toolCallId"];
    expect(callId).toEqual(expect.any(String));
    const retrieved = await client.callTool({
      name: "get_tool_call",
      arguments: { call_id: callId },
    });
    expect(retrieved.structuredContent).toMatchObject({ call: { id: callId, tool: "probe_call" } });
    expect(retrieved._meta?.["mikrotik/recorded"]).toBe(true);
    const invalid = await client.callTool({
      name: "get_tool_call",
      arguments: { call_id: "../invalid" },
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("concurrent calls keep unique IDs and isolated diagnostics", async () => {
  const call = register(
    probe(async (args, ctx) => {
      ctx.info(`start ${args.marker}`);
      await Promise.resolve();
      ctx.info(`end ${args.marker}`);
      return String(args.marker);
    }),
  );
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => call({ marker: i })));
  expect(new Set(results.map(idOf)).size).toBe(25);
  results.forEach((result, i) =>
    expect(rows.get(idOf(result))?.logs?.map((l) => l.message)).toEqual([`start ${i}`, `end ${i}`]),
  );
});

test("records early rejection, access denial, handler exceptions and reported failures", async () => {
  const handler = vi.fn(() => "ok");
  const writer = defineTool({
    name: "probe_write",
    title: "Write",
    description: "test",
    annotations: WRITE,
    handler,
  });
  const unknown = await register(writer)({ device: "missing" });
  const escaped = await register(writer)({ comment: "a &amp; b" });
  setConfig({
    ...getConfig(),
    access: { enabled: true, devices: ["lab"], denyTools: [], tools: [], denyDevices: [] },
  });
  const denied = await register(writer)({ device: "edge" });
  const thrown = await register(
    probe(() => {
      throw new Error("SSH timeout");
    }),
  )();
  const failed = await register(probe(() => "Failed to read: no such item"))();
  for (const result of [unknown, escaped, denied, thrown, failed]) {
    expect(result.isError).toBe(true);
    expect(rows.get(idOf(result))?.isError).toBe(true);
    expect(rows.get(idOf(result))?.error).toBeTruthy();
  }
  expect(handler).not.toHaveBeenCalled();
  expect(rows.get(idOf(unknown))?.device).toBe("missing");
});

test("canonical device identity survives aliases and changes to the default", async () => {
  const result = await register(
    probe(() => {
      setConfig({ ...getConfig(), defaultDevice: "edge" });
      return "ok";
    }),
  )();
  expect(rows.get(idOf(result))?.device).toBe("lab");
  const alias = await register(probe())({ device: "Edge Router" });
  expect(rows.get(idOf(alias))?.device).toBe("edge");
});

test("lookup returns the original evidence without replaying its handler", async () => {
  const handler = vi.fn((_args, ctx) => {
    ctx.error("read-back unavailable");
    return "Created; verify current state before retrying.";
  });
  const result = await register(probe(handler))({ password: "sensitive-input" });
  const inspected = await lookup()({ call_id: idOf(result) });
  expect(inspected.isError).toBeFalsy();
  expect(inspected.structuredContent?.call).toMatchObject({
    id: idOf(result),
    tool: "probe_call",
    input: '{"password":"«redacted»"}',
  });
  expect(idOf(inspected)).not.toBe(idOf(result));
  expect(handler).toHaveBeenCalledTimes(1);
  expect(text(inspected)).not.toContain("sensitive-input");
  expect(text(inspected)).toContain("read-back unavailable");
});

test("retained legacy IDs are retrievable, missing and disabled history are explicit", async () => {
  const result = await register(probe())();
  const event = rows.get(idOf(result))!;
  rows.set("old-123", { ...event, id: "old-123", logs: undefined, bodyCaptured: undefined });
  expect((await lookup()({ call_id: "old-123" })).isError).toBeFalsy();
  expect(text(await lookup()({ call_id: "missing" }))).toContain("Tool call not found");
  shutdownRecorder();
  const unrecorded = await register(probe())();
  expect(idOf(unrecorded)).toBeTruthy();
  expect(unrecorded._meta?.["mikrotik/recorded"]).toBe(false);
  expect(text(unrecorded)).toContain("history not saved");
  expect(text(await lookup()({ call_id: idOf(result) }))).toContain("history is unavailable");
});

test("reading a historical parser failure succeeds, including through invoke_tool", async () => {
  const failed = await register(probe(() => "syntax error (line 1 column 4)"))();
  expect(failed.isError).toBe(true);
  const result = await lookup()({ call_id: idOf(failed) });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent?.outcome).toBe("error");
  const gateway = register(toolGatewayTools.find((t) => t.name === "invoke_tool")!);
  const delegated = await gateway({ name: "get_tool_call", arguments: { call_id: idOf(failed) } });
  expect(delegated.isError).toBeFalsy();
  expect(delegated.structuredContent?.outcome).toBe("error");
  for (const inspected of [result, delegated]) {
    expect(rows.get(idOf(inspected))?.output).toContain("Evidence is not duplicated");
    expect(rows.get(idOf(inspected))?.output).not.toContain("syntax error");
  }
});

test("gateway history cannot disclose a delegated tool denied by the current scope", async () => {
  const result = await register(probe())();
  rows.set("delegated", {
    ...rows.get(idOf(result))!,
    id: "delegated",
    tool: "invoke_tool",
    input: JSON.stringify({ name: "list_interfaces", arguments: {} }),
  });
  setConfig({
    ...getConfig(),
    access: {
      enabled: true,
      devices: [],
      denyTools: ["list_interfaces"],
      tools: [],
      denyDevices: [],
    },
  });
  expect(text(await lookup()({ call_id: "delegated" }))).toContain("Access denied");
});

test("diagnostic storage honors the configured capture budget in bytes", () => {
  const event = buildEvent(
    {
      tool: "probe_call",
      title: "Probe",
      risk: "READ",
      ts: 1,
      durationMs: 1,
      isError: false,
      args: {},
      output: "ok",
      hasStructured: false,
      logs: Array.from({ length: 100 }, () => ({
        offsetMs: 0,
        level: "info" as const,
        message: "سلام".repeat(10),
      })),
    },
    "bounded",
    { captureBody: true, maxBodyBytes: 100 },
  );
  expect(event.logsTruncated).toBe(true);
  expect(
    event.logs!.reduce((n, l) => n + new TextEncoder().encode(l.message).length, 0),
  ).toBeLessThanOrEqual(100);
});

test("storage failure does not break execution or falsely claim a saved history", async () => {
  store.insert = () => {
    throw new Error("disk full");
  };
  const result = await register(probe())();
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain("ok");
  expect(result._meta?.["mikrotik/recorded"]).toBe(false);
});

test("lookup respects current device and tool scope, even for legacy records", async () => {
  const edge = await register(probe())({ device: "edge" });
  setConfig({
    ...getConfig(),
    access: { enabled: true, devices: ["lab"], denyTools: [], tools: [], denyDevices: [] },
  });
  expect(text(await lookup()({ call_id: idOf(edge) }))).toContain("Access denied");
  const event = rows.get(idOf(edge))!;
  rows.set("unknown-device", { ...event, id: "unknown-device", device: undefined });
  expect(text(await lookup()({ call_id: "unknown-device" }))).toContain("no attributable device");
  setConfig({
    ...getConfig(),
    access: { enabled: true, devices: [], denyTools: ["probe_call"], tools: [], denyDevices: [] },
  });
  expect(text(await lookup()({ call_id: idOf(edge) }))).toContain("Access denied");
});

test("logs are bounded, secrets are masked, and body capture opt-out is preserved", async () => {
  const result = await register(
    probe((_args, ctx) => {
      ctx.info('/user set password="log-secret" private-key=key-secret');
      for (let i = 0; i < 100; i++) ctx.info("x".repeat(500));
      return 'password="output-secret"';
    }),
  )({ command: '/user add password="command-secret"' });
  const event = rows.get(idOf(result))!;
  expect(JSON.stringify(event)).not.toMatch(/log-secret|key-secret|output-secret|command-secret/);
  expect(event.logs!.length).toBeLessThanOrEqual(64);
  expect(event.logsTruncated).toBe(true);
  configureRecorder({ store, capture: { captureBody: false, maxBodyBytes: 1000 }, maxEvents: 100 });
  const uncaptured = await register(
    probe((_args, ctx) => {
      ctx.info("not retained");
      return "hidden";
    }),
  )();
  expect(rows.get(idOf(uncaptured))).toMatchObject({ input: "", output: "", bodyCaptured: false });
  expect(rows.get(idOf(uncaptured))?.logs).toBeUndefined();
});

test("legacy unredacted input is masked at lookup without modifying the stored record", async () => {
  const event = buildEvent(
    {
      tool: "probe_call",
      title: "Probe",
      risk: "READ",
      ts: 1000,
      durationMs: 1,
      isError: false,
      args: { password: "legacy-secret" },
      output: "ok",
      hasStructured: false,
    },
    "legacy",
    { captureBody: true, redactInput: false, maxBodyBytes: 1000 },
  );
  rows.set("legacy", event);
  const result = await lookup()({ call_id: "legacy" });
  expect(text(result)).not.toContain("legacy-secret");
  expect(event.input).toContain("legacy-secret");
});

test.each([
  'password="sensitive-value"',
  "private-key=sensitive-value",
  "Authorization: Bearer sensitive-value",
  '{"headers":{"Authorization":"Bearer sensitive-value"}}',
  '{"nested":{"token":"sensitive-value"}}',
  '{"command":"/user add password=sensitive-value"}',
  "-----BEGIN PRIVATE KEY-----\nsensitive-value\n-----END PRIVATE KEY-----",
])("redacts diagnostics in supported secret forms: %s", (input) => {
  expect(redactAuditText(input)).not.toContain("sensitive-value");
});
