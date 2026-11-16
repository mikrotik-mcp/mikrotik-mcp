/**
 * Tool exposure: what `tools/list` contains, and that every tool the server
 * names is reachable.
 *
 * Regression for hosts that load only part of a several-hundred-tool list: the
 * server listed `invoke_tool`, `rollback_safe_mode` and others, the host never
 * loaded them, and every hint the server printed ("call X") was a dead end.
 *
 * Offline: a real MCP server and client over an in-memory transport, synthetic
 * devices, and a mocked connector. No router is contacted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MikrotikConfigSchema } from "../src/config";
import { resetSessionScope } from "../src/core/access";
import { executeMikrotikCommand } from "../src/core/connector";
import { PINNED_TOOLS, unreachableToolHint } from "../src/core/registry";
import { getConfig, setConfig } from "../src/core/runtime";
import { recordToolCall } from "../src/observability/recorder";
import { createServer } from "../src/server";
import { moduleCatalog } from "../src/tools/index";

vi.mock("../src/core/connector", () => ({
  executeMikrotikCommand: vi.fn(),
  executeMikrotikJson: vi.fn(),
}));
vi.mock("../src/observability/recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/observability/recorder")>()),
  recordToolCall: vi.fn(() => true),
}));

const CATALOG = moduleCatalog.flatMap((mod) => mod.tools.map((tool) => tool.name));
const original = getConfig();
const open: (() => Promise<void>)[] = [];

interface Listed {
  name: string;
  inputSchema: Record<string, unknown>;
}

async function connect(config: Record<string, unknown> = {}) {
  const dev = { host: "127.0.0.1", port: 1 };
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { home: dev, branch: dev },
      defaultDevice: "home",
      disableUpdateCheck: true,
      memory: { enabled: false },
      ...config,
    }),
  );
  resetSessionScope();
  const { server } = createServer();
  const client = new Client({ name: "tool-exposure-test", version: "1" });
  let listChanged = 0;
  client.fallbackNotificationHandler = async (note) => {
    if (note.method === "notifications/tools/list_changed") listChanged++;
  };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  open.push(async () => {
    await client.close();
    await server.close();
  });

  const list = async (): Promise<Listed[]> => {
    const tools: Listed[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools as Listed[]));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])
      .map((block) => block.text)
      .join("\n");
    return { text, isError: result.isError === true };
  };
  const invoke = (name: string, args: Record<string, unknown> = {}, device?: string) =>
    call("invoke_tool", { name, arguments: args, ...(device ? { device } : {}) });
  return { client, list, call, invoke, listChanged: () => listChanged };
}

/** The JSON schema `describe_tool` prints for a tool. */
function describedSchema(text: string): Record<string, unknown> {
  const start = text.indexOf("JSON schema:\n") + "JSON schema:\n".length;
  return JSON.parse(text.slice(start, text.lastIndexOf("\n\nRun it:")));
}

/**
 * Catalog tools named in `text` that a client could fail to reach: not pinned,
 * and not given as a ready-to-run `invoke_tool` call.
 */
function unreachableNames(text: string): string[] {
  const catalog = new Set(CATALOG);
  const tokens = new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []);
  return [...tokens].filter(
    (name) =>
      catalog.has(name) && !PINNED_TOOLS.includes(name) && !text.includes(`"name":"${name}"`),
  );
}

beforeEach(() => {
  vi.mocked(executeMikrotikCommand).mockReset().mockResolvedValue("# ADDRESS\n0 192.0.2.1/24");
  vi.mocked(recordToolCall).mockClear();
});
afterEach(async () => {
  while (open.length) await open.pop()!();
  setConfig(original);
});

describe("(a) the pinned core set is always in tools/list", () => {
  test("full surface: every catalog tool, pinned ones first and in fixed order", async () => {
    const names = (await (await connect()).list()).map((tool) => tool.name);
    expect(names.slice(0, PINNED_TOOLS.length)).toEqual(PINNED_TOOLS);
    expect([...names].sort()).toEqual([...CATALOG].sort());
  });

  test("a paginated list has the whole pinned set on its first page", async () => {
    const { client, list } = await connect({ mcp: { toolPageSize: PINNED_TOOLS.length } });
    const first = await client.listTools();
    expect(first.tools.map((tool) => tool.name)).toEqual(PINNED_TOOLS);
    expect(first.nextCursor).toBeDefined();
    expect((await list()).length).toBe(CATALOG.length);
  });

  test("a module allow-list cannot filter the pinned set out", async () => {
    const names = (await (await connect({ tools: { enabledModules: ["dns"] } })).list()).map(
      (tool) => tool.name,
    );
    expect(names.slice(0, PINNED_TOOLS.length)).toEqual(PINNED_TOOLS);
    expect(names).toContain("list_dns_static");
    expect(names).not.toContain("list_filter_rules");
  });

  test("core surface: only the pinned set plus coreTools", async () => {
    const { list } = await connect({
      mcp: { toolSurface: "core", coreTools: "list_filter_rules, ping" },
    });
    const names = (await list()).map((tool) => tool.name);
    expect(names.slice(0, PINNED_TOOLS.length)).toEqual(PINNED_TOOLS);
    expect([...names].sort()).toEqual([...PINNED_TOOLS, "list_filter_rules", "ping"].sort());
  });

  test("read-only mode keeps the gateway and every pinned read tool", async () => {
    const names = (await (await connect({ readOnly: true })).list()).map((tool) => tool.name);
    for (const name of [
      "find_tools",
      "describe_tool",
      "invoke_tool",
      "get_access_scope",
      "safe_mode_status",
      "get_tool_call",
    ]) {
      expect(names).toContain(name);
    }
    // Safe Mode control changes the router, so read-only mode withholds it.
    expect(names).not.toContain("enable_safe_mode");
  });
});

describe("(b) the list is stable", () => {
  test.each(["full", "core"])("%s surface: same set and order on every call", async (surface) => {
    const session = await connect({ mcp: { toolSurface: surface } });
    const first = (await session.list()).map((tool) => tool.name);
    await session.call("find_tools", { query: "firewall filter rules" });
    await session.invoke("list_ip_addresses");
    expect((await session.list()).map((tool) => tool.name)).toEqual(first);
    expect((await session.list()).map((tool) => tool.name)).toEqual(first);
    expect(session.listChanged()).toBe(0);

    const other = await connect({ mcp: { toolSurface: surface } });
    expect((await other.list()).map((tool) => tool.name)).toEqual(first);
  });
});

describe("(c) invoke_tool reaches every tool, with the direct-call pipeline", () => {
  test("every catalog tool resolves and is validated by its own schema", async () => {
    // An unknown argument is rejected by the target's schema BEFORE its handler
    // runs, so this proves dispatch for all tools without executing any of them.
    const { invoke } = await connect({ mcp: { toolSurface: "core" } });
    const unresolved: string[] = [];
    for (const name of CATALOG) {
      if (name === "invoke_tool") continue;
      const { text } = await invoke(name, { __not_a_real_argument__: 1 });
      if (!text.startsWith(`Invalid arguments for "${name}"`)) unresolved.push(name);
    }
    expect(unresolved).toEqual([]);
    expect(executeMikrotikCommand).not.toHaveBeenCalled();
  });

  test("the call find_tools prints can be pasted into invoke_tool", async () => {
    const { call } = await connect({ mcp: { toolSurface: "core" } });
    const found = await call("find_tools", { query: "list ipv4 firewall filter rules", limit: 5 });
    const printed = [...found.text.matchAll(/Run: .*?invoke_tool (\{.*\})$/gm)].map((match) =>
      JSON.parse(match[1]),
    );
    expect(printed.length).toBe(5);
    for (const args of printed) {
      const { text } = await call("invoke_tool", args);
      expect(text).not.toMatch(/No tool named|not available on this server/);
    }
  });

  test("a tool that is not listed runs through invoke_tool and returns its real output", async () => {
    const { call, invoke } = await connect({ mcp: { toolSurface: "core" } });
    const direct = await call("list_ip_addresses").catch((error: unknown) => String(error));
    expect(JSON.stringify(direct)).toMatch(/not found|Unknown tool/i);

    const result = await invoke("list_ip_addresses", {}, "branch");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("192.0.2.1/24");
    // The device chosen on invoke_tool reached the delegated tool.
    expect(vi.mocked(executeMikrotikCommand).mock.calls[0][1].device).toBe("branch");
    // …and a READ target is routed as a read, not as invoke_tool's WRITE.
    expect(vi.mocked(executeMikrotikCommand).mock.calls[0][1].risk).toBe("READ");
  });

  test("the audit record is filed once, under the delegated tool", async () => {
    const { invoke } = await connect();
    const result = await invoke("list_ip_addresses");
    expect(vi.mocked(recordToolCall)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordToolCall).mock.calls[0][0]).toMatchObject({
      tool: "list_ip_addresses",
      risk: "READ",
      device: "home",
    });
    expect(result.text.match(/Tool call ID:/g)).toHaveLength(1);
  });

  test("a DANGEROUS target still requires `reason`", async () => {
    const { invoke } = await connect();
    const result = await invoke("apply_plan", { commands: ["/ip address print"] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Invalid arguments for "apply_plan": reason/);
    expect(executeMikrotikCommand).not.toHaveBeenCalled();
  });

  test("an argument the target does not have is rejected, not dropped", async () => {
    const { invoke } = await connect();
    const result = await invoke("apply_plan", {
      reason: "test",
      commands: ["/ip address print"],
      use_safemode: false,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("use_safemode");
    expect(executeMikrotikCommand).not.toHaveBeenCalled();
  });

  test("the access policy judges the delegated tool, not the dispatcher", async () => {
    const { invoke } = await connect({ access: { enabled: true, maxRisk: "READ" } });
    expect((await invoke("list_ip_addresses")).isError).toBe(false);

    vi.mocked(executeMikrotikCommand).mockClear();
    const write = await invoke("set_system_identity", { name: "x" });
    expect(write.isError).toBe(true);
    expect(write.text).toContain("Access denied");
    expect(executeMikrotikCommand).not.toHaveBeenCalled();
  });

  test("read-only mode: reads work through invoke_tool, writes are refused", async () => {
    const { invoke } = await connect({ readOnly: true });
    expect((await invoke("list_ip_addresses")).isError).toBe(false);
    const write = await invoke("set_system_identity", { name: "x" });
    expect(write.isError).toBe(true);
    expect(write.text).toContain("not available on this server");
  });

  test("unknown names and self-invocation fail cleanly", async () => {
    const { invoke } = await connect();
    expect((await invoke("totally_made_up_tool")).text).toContain("No tool named");
    expect((await invoke("invoke_tool")).text).toContain("cannot invoke itself");
  });

  test("invoke_tool's own errors carry no hint line that re-suggests the target", async () => {
    const { invoke } = await connect();
    const invalid = await invoke("apply_plan", { commands: ["/ip address print"] });
    expect(invalid.text).toContain('Invalid arguments for "apply_plan"');
    expect(invalid.text).not.toContain("Not in your tool list?");
    expect((await invoke("totally_made_up_tool")).text).not.toContain("Not in your tool list?");
    // A failure raised inside the delegated tool keeps its hint.
    const ghost = await invoke("list_ip_addresses", {}, "ghost");
    expect(ghost.text).toContain('invoke_tool {"name":"list_mikrotik_devices"');
  });
});

describe("(d) one schema per tool", () => {
  test("describe_tool returns exactly the tools/list schema, for every tool", async () => {
    const { list, call } = await connect();
    const different: string[] = [];
    for (const tool of await list()) {
      const described = describedSchema((await call("describe_tool", { name: tool.name })).text);
      if (!isDeepStrictEqual(described, tool.inputSchema)) different.push(tool.name);
    }
    expect(different).toEqual([]);
  });

  test("apply_plan: draft-07, defaults are not required, injected fields are shown", async () => {
    const { list, call } = await connect();
    const listed = (await list()).find((tool) => tool.name === "apply_plan")!.inputSchema;
    expect(listed.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(listed.required).toEqual(["reason"]);
    expect(Object.keys(listed.properties as object)).toEqual(
      expect.arrayContaining(["confirm", "use_safe_mode", "device", "reason"]),
    );
    const described = (await call("describe_tool", { name: "apply_plan" })).text;
    expect(describedSchema(described)).toEqual(listed);
    expect(described).toContain("reason (required)");
    expect(described).toContain("use_safe_mode (optional)");
  });

  test("a tool that is not listed (core surface) still describes its direct-call schema", async () => {
    const full = await connect();
    const listed = (await full.list()).find((tool) => tool.name === "update_filter_rule")!;
    const core = await connect({ mcp: { toolSurface: "core" } });
    const described = (await core.call("describe_tool", { name: "update_filter_rule" })).text;
    expect(describedSchema(described)).toEqual(listed.inputSchema);
  });
});

describe("(e) hints and errors only point at reachable tools", () => {
  test.each(["full", "core"])("%s surface: find_tools and describe_tool", async (surface) => {
    const { call } = await connect({ mcp: { toolSurface: surface } });
    for (const query of ["rollback safe mode", "ping a host", "web proxy access rules"]) {
      const found = (await call("find_tools", { query })).text;
      expect(found).not.toContain("directly if available");
      expect(unreachableNames(found)).toEqual([]);
    }
    expect(unreachableNames((await call("find_tools", { query: "zzzqqq xyzzy" })).text)).toEqual(
      [],
    );
    for (const name of ["apply_plan", "rollback_safe_mode", "ping"]) {
      const described = (await call("describe_tool", { name })).text;
      const tail = described.slice(described.lastIndexOf("Run it:"));
      expect(tail).toContain(`invoke_tool {"name":"${name}"`);
      expect(unreachableNames(tail)).toEqual([]);
    }
  });

  test("'call directly' is said only for tools the client is sure to have", async () => {
    const { call } = await connect();
    const pinned = (await call("describe_tool", { name: "rollback_safe_mode" })).text;
    expect(pinned).toContain("call rollback_safe_mode directly, or invoke_tool");
    const other = (await call("describe_tool", { name: "ping" })).text;
    expect(other).not.toContain("directly");
  });

  test("a required argument appears as a placeholder in the printed call", async () => {
    const { call } = await connect();
    const described = (await call("describe_tool", { name: "apply_plan" })).text;
    expect(described).toContain(
      'invoke_tool {"name":"apply_plan","arguments":{"reason":"<reason>"}}',
    );
  });

  test("any tool result that names an unlisted tool gets a ready-to-run call", async () => {
    const { call } = await connect();
    // An error raised by the registry itself, before any handler runs.
    const unknownDevice = await call("list_ip_addresses", { device: "ghost" });
    expect(unknownDevice.isError).toBe(true);
    expect(unknownDevice.text).toContain("list_mikrotik_devices");
    expect(unreachableNames(unknownDevice.text)).toEqual([]);
    // A handler's own text.
    const guide = await call("get_vlan_segmentation_guide");
    expect(unreachableNames(guide.text)).toEqual([]);
  });

  test("Safe Mode guidance names only pinned tools", async () => {
    const { call } = await connect();
    const status = await call("safe_mode_status");
    expect(unreachableNames(status.text)).toEqual([]);
    const rollback = await call("rollback_safe_mode");
    expect(unreachableNames(rollback.text)).toEqual([]);
  });

  test("unreachableToolHint: quiet when nothing needs it, bounded when much does", () => {
    const tools = {
      run: () => undefined,
      shape: (name: string) => (CATALOG.includes(name) ? {} : undefined),
      schema: () => ({ required: ["x"] }),
      direct: (name: string) => PINNED_TOOLS.includes(name),
    };
    expect(
      unreachableToolHint("Call rollback_safe_mode next.", tools, "apply_plan"),
    ).toBeUndefined();
    expect(unreachableToolHint("dst_address not_a_tool", tools, "apply_plan")).toBeUndefined();
    expect(unreachableToolHint("apply_plan itself", tools, "apply_plan")).toBeUndefined();
    const hint = unreachableToolHint("Use list_filter_rules, then plan_changes.", tools, "x");
    expect(hint).toContain('invoke_tool {"name":"list_filter_rules","arguments":{"x":"<x>"}}');
    expect(hint).toContain('"name":"plan_changes"');
    // Already printed as a call: not repeated.
    expect(
      unreachableToolHint('invoke_tool {"name":"plan_changes","arguments":{}}', tools, "x"),
    ).toBeUndefined();
    const many = CATALOG.filter((name) => !PINNED_TOOLS.includes(name))
      .slice(0, 20)
      .join(" ");
    expect(unreachableToolHint(many, tools, "x")!.match(/invoke_tool \{/g)).toHaveLength(4);
  });
});
