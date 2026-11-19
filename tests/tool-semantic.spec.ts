/// <reference types="bun" />
/** Tool search by meaning: the index, the fused ranking, and what find_tools prints. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import { READ, WRITE, defineTool, registerTools } from "../src/core/registry";
import { getConfig, setConfig } from "../src/core/runtime";
import { buildToolIndex } from "../src/core/tool-search";
import {
  BUILD_WAIT_LIMIT_MS,
  buildStatus,
  buildWaitMessage,
  fuseRanks,
  resetSemanticIndex,
  semanticRank,
  semanticReady,
  semanticText,
  startSemanticIndex,
} from "../src/core/tool-semantic";
import { AUTO_CORE_ABOVE, resolveSurface } from "../src/server";
import { rankTools, toolGatewayTools } from "../src/tools/tool-gateway";

const DOCS = [
  {
    name: "set_dns_servers",
    title: "Set DNS Servers",
    description: "Sets the upstream resolvers. More text.",
  },
  { name: "reboot_system", title: "Reboot", description: "Restarts the router." },
  { name: "list_routes", title: "List Routes", description: "Lists the routing table." },
];

/**
 * A stand-in for the model: a vector with one axis for each topic. "nameserver"
 * and "dns" share an axis, as they share a meaning.
 */
const TOPICS = [/dns|nameserver|resolver/i, /reboot|restart/i, /route|routing/i];
const fakeEmbed = (text: string): Float32Array => {
  const v = new Float32Array(384);
  TOPICS.forEach((topic, i) => {
    if (topic.test(text)) v[i] = 1;
  });
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
};

beforeEach(() => {
  resetSemanticIndex();
  vi.stubEnv("MIKROTIK_TOOL_VECTORS", join(mkdtempSync(join(tmpdir(), "vec-")), "v.bin"));
});
afterEach(() => {
  resetSemanticIndex();
  vi.unstubAllEnvs();
});

test("the text that is embedded is the title and the first sentence", () => {
  expect(semanticText(DOCS[0]!)).toBe("Set DNS Servers. Sets the upstream resolvers.");
});

test("a request finds a tool by meaning, with none of the tool's words", async () => {
  expect(semanticRank("change the nameservers", 3)).toBeNull();
  await startSemanticIndex(DOCS, fakeEmbed);
  expect(semanticReady()).toBe(true);
  expect(semanticRank("change the nameservers", 3)![0]).toMatchObject({
    name: "set_dns_servers",
    sim: 1,
  });
  expect(semanticRank("restart it", 1)![0]!.name).toBe("reboot_system");
});

test("a model that cannot load leaves the search working on words", async () => {
  await startSemanticIndex(DOCS, () => {
    throw new Error("WebAssembly is not available");
  });
  expect(semanticReady()).toBe(false);
  expect(semanticRank("anything", 3)).toBeNull();
});

test("two rankings are merged by rank: high in both beats first in one", () => {
  expect(
    fuseRanks(
      [
        ["a", "b", "c"],
        ["b", "c", "a"],
      ],
      3,
    ),
  ).toEqual(["b", "a", "c"]);
  expect(fuseRanks([["a"], []], 5)).toEqual(["a"]);
});

const index = buildToolIndex(DOCS.map((d) => ({ ...d, module: "m", group: "g", params: [] })));

test("rankTools uses meaning when it is ready, and keeps an exact name first", async () => {
  // Words only: "nameservers" is not in any tool here.
  const before = rankTools(index, "which upstream nameserver", 3);
  expect(before.semantic).toBe(false);

  await startSemanticIndex(DOCS, fakeEmbed);
  const after = rankTools(index, "which upstream nameserver", 3);
  expect(after.semantic).toBe(true);
  expect(after.hits[0]!.name).toBe("set_dns_servers");

  // The request is a tool name: that tool is first and the result is sure.
  const exact = rankTools(index, "list_routes", 3);
  expect(exact.hits[0]!.name).toBe("list_routes");
  expect(exact.sure).toBe(true);
  // Both rankings agree on the first tool: sure.
  expect(rankTools(index, "reboot restart", 3)).toMatchObject({ sure: true });
});

test("the automatic tool list is short only for a large catalog", () => {
  expect(resolveSurface("auto", AUTO_CORE_ABOVE)).toBe("full");
  expect(resolveSurface("auto", AUTO_CORE_ABOVE + 1)).toBe("core");
  expect(resolveSurface("full", 5000)).toBe("full");
  expect(resolveSurface("core", 3)).toBe("core");
});

const gatewayTool = (name: string) => toolGatewayTools.find((t) => t.name === name)!;
const run = async (
  name: string,
  args: Record<string, unknown>,
  ctx: Record<string, unknown> = {},
) => {
  const result = await (gatewayTool(name).handler as (a: unknown, c: unknown) => Promise<unknown>)(
    args,
    {
      info() {},
      error() {},
      ...ctx,
    },
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};

test("find_tools gives names with one line each, no schema, and says every tool can be run", async () => {
  const text = await run("find_tools", { query: "list ipv4 firewall filter rules", limit: 4 });
  expect(text).toMatch(/^Found 4 tools/);
  expect(text.match(/^\d+\. /gm)).toHaveLength(4);
  expect(text.match(/^ {3}Run: /gm)).toHaveLength(4);
  expect(text).not.toContain('"type":');
  expect(text).not.toContain("JSON schema");
  expect(text).toContain("also when it is not in your own tool list");
  // An exact name is a sure match: its parameters come with the list.
  const sure = await run("find_tools", { query: "set_dns_servers" });
  expect(sure).toContain("Best match: set_dns_servers. Its parameters:");
  // The kind is said, so a list is not sent as plain text.
  expect(sure).toMatch(/• servers \(optional, list of text\)/);
});

test("the tool descriptions carry the rule that an unlisted tool is not missing", () => {
  expect(gatewayTool("find_tools").description).toContain("is NOT missing");
  expect(gatewayTool("invoke_tool").description).toContain("is NOT missing");
});

test("the build reports how much is left and for how long, and stops at the limit", async () => {
  expect(buildStatus()).toBeNull();
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    title: `T${i}`,
    description: "d.",
  }));
  const build = startSemanticIndex(many, fakeEmbed);
  // The build has started and yields after every eight tools.
  await new Promise((resolve) => setImmediate(resolve));
  const status = buildStatus()!;
  expect(status.total).toBe(40);
  expect(status.done).toBeGreaterThan(0);
  expect(status.remaining).toBe(40 - status.done);
  expect(status.seconds).toBeGreaterThanOrEqual(1);
  expect(buildWaitMessage({ done: 600, total: 1006, remaining: 406, seconds: 4 })).toBe(
    "Not run: the tool search index is still being built. 600 of 1006 tools are embedded, 406 are left, about 4 seconds more. Nothing was changed. Wait 4 seconds, then make the same call again. Do not look for another way to do the task meanwhile.",
  );
  // A build that hangs does not hold calls back for ever.
  expect(buildStatus(Date.now() + BUILD_WAIT_LIMIT_MS + 1)).toBeNull();
  await build;
  expect(buildStatus()).toBeNull();
});

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ isError?: boolean; content: { text: string }[] }>;

test("while the vectors are built, a tool call is told to wait; Safe Mode control is not", async () => {
  const original = getConfig();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { home: { host: "192.0.2.1" } },
      defaultDevice: "home",
      verifyWrites: false,
    }),
  );
  const ran: string[] = [];
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      handlers[name] = handler;
      return { enable() {}, disable() {} };
    },
  };
  const tool = (name: string, annotations: typeof READ) =>
    defineTool({
      name,
      title: name,
      description: "d",
      annotations,
      noDevice: true,
      inputSchema: { x: z.string().optional() },
      handler: async () => {
        ran.push(name);
        return "done";
      },
    });
  registerTools(server as never, [
    [tool("list_x", READ), tool("add_x", WRITE), tool("rollback_safe_mode", WRITE)],
  ]);
  try {
    await handlers.list_x!({});
    expect(ran).toEqual(["list_x"]);

    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      title: `T${i}`,
      description: "d.",
    }));
    const build = startSemanticIndex(many, fakeEmbed);
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = await handlers.add_x!({});
    expect(waiting.isError).toBe(true);
    expect(waiting.content[0]!.text).toMatch(
      /^Not run: the tool search index is still being built\. \d+ of 40 tools are embedded, \d+ are left, about \d+ seconds? more\./,
    );
    expect((await handlers.list_x!({})).isError).toBe(true);
    // A rollback never waits.
    expect((await handlers.rollback_safe_mode!({})).isError).toBeUndefined();
    expect(ran).toEqual(["list_x", "rollback_safe_mode"]);

    await build;
    expect((await handlers.add_x!({})).isError).toBeUndefined();
    expect(ran).toEqual(["list_x", "rollback_safe_mode", "add_x"]);
  } finally {
    setConfig(original);
  }
});
