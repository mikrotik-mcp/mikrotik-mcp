/// <reference types="bun" />
/** Tool search by meaning: the index, the fused ranking, and what find_tools prints. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { buildToolIndex } from "../src/core/tool-search";
import {
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
  expect(sure).toMatch(/• servers \(required\)/);
});

test("the tool descriptions carry the rule that an unlisted tool is not missing", () => {
  expect(gatewayTool("find_tools").description).toContain("is NOT missing");
  expect(gatewayTool("invoke_tool").description).toContain("is NOT missing");
});
