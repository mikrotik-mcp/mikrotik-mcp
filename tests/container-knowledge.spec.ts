import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MikrotikConfigSchema } from "../src/config";
import { executeMikrotikCommand } from "../src/core/connector";
import { getConfig, setConfig } from "../src/core/runtime";
import {
  CONTAINER_GUIDE_URI,
  CONTAINER_GUIDE_TOPICS,
  CONTAINER_INSTRUCTIONS,
  getRouterosContainerGuide,
} from "../src/core/container-guidance";
import { listPrompts } from "../src/prompts";
import { composePrompt } from "../src/prompts/compose";
import { createServer } from "../src/server";

vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
const original = getConfig();
afterEach(() => {
  setConfig(original);
  vi.clearAllMocks();
});
async function connected(readOnly: boolean, enabled: boolean) {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { a: { host: "127.0.0.1", port: 1 }, b: { host: "127.0.0.1", port: 1 } },
      defaultDevice: "a",
      readOnly,
      disableUpdateCheck: true,
      memory: { enabled: false },
      tools: { enabledModules: [enabled ? "container" : "dns"] },
      mcp: { appViews: false, toolPageSize: 0 },
    }),
  );
  const { server } = createServer();
  const client = new Client({ name: "container-knowledge-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("container knowledge delivery over real offline MCP protocol", () => {
  test.each([
    [false, true],
    [true, true],
    [true, false],
    [false, false],
  ])("readOnly=%s enabled=%s needs no device/package/Memory", async (readOnly, enabled) => {
    const { client, close } = await connected(readOnly, enabled);
    try {
      expect(client.getInstructions()).toContain(CONTAINER_INSTRUCTIONS);
      expect(client.getInstructions()?.includes("Container tool-only clients:")).toBe(enabled);
      expect(
        (await client.listResources()).resources.some((r) => r.uri === CONTAINER_GUIDE_URI),
      ).toBe(true);
      expect((await client.readResource({ uri: CONTAINER_GUIDE_URI })).contents[0]).toMatchObject({
        text: getRouterosContainerGuide(),
      });
      const tools = (await client.listTools()).tools;
      const guide = tools.find((t) => t.name === "get_routeros_container_guide");
      expect(Boolean(guide)).toBe(enabled);
      expect(tools.some((t) => t.name === "add_container")).toBe(enabled && !readOnly);
      if (enabled) {
        expect(guide?.inputSchema.properties).not.toHaveProperty("device");
        expect(guide?.annotations?.readOnlyHint).toBe(true);
        const result = await client.callTool({
          name: "get_routeros_container_guide",
          arguments: {},
        });
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: "text", text: getRouterosContainerGuide() }]);
        expect(
          (
            await client.callTool({
              name: "get_routeros_container_guide",
              arguments: { topic: "invalid" },
            })
          ).isError,
        ).toBe(true);
        expect(
          JSON.stringify(
            (
              await client.callTool({
                name: "find_tools",
                arguments: { query: "get_routeros_container_guide" },
              })
            ).content,
          ),
        ).toContain("get_routeros_container_guide");
      }
      expect(executeMikrotikCommand).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
  test("guide is device-independent, bounded by topic and contains all safety boundaries", () => {
    const full = getRouterosContainerGuide();
    for (const topic of CONTAINER_GUIDE_TOPICS) {
      const part = getRouterosContainerGuide(topic);
      expect(part.length).toBeLessThan(full.length);
      expect(full).toContain(part.split("\n\n")[1]);
    }
    for (const boundary of [
      "physical-confirmation",
      "ARM variants",
      "memory-high",
      "positive WAN",
      "IPv4 AND IPv6",
      "positive stopped observation",
      "outcome is UNKNOWN",
      "Memory never grants",
      "image-save",
      "Shared scope",
    ])
      expect(full).toContain(boundary);
    expect(full).not.toMatch(/86\.104\.|185\.192\.|10\.79\.79\.|home-ax3|netherlands/);
  });
  test("MCP, Dashboard and Raycast prompt composition share the guide and preserve target", async () => {
    const { client, close } = await connected(true, true);
    try {
      for (const name of [
        "audit-routeros-containers",
        "setup-routeros-container",
        "setup-v2ray-container-proxy",
      ]) {
        const prompt = listPrompts().find((p) => p.name === name)!;
        expect(prompt.body).toContain(getRouterosContainerGuide());
        expect(composePrompt(prompt, { device: "b" }, "Review only", "b")).toContain(
          getRouterosContainerGuide(),
        );
        const rendered = await client.getPrompt({ name, arguments: { device: "b" } });
        const text = rendered.messages[0].content;
        if (text.type !== "text") throw new Error("Expected text");
        expect(text.text).toMatch(/(?:Audit b|Target b|deployment on b)/);
        expect(text.text).toContain(getRouterosContainerGuide());
        expect(text.text).not.toMatch(/\{\{(?:image|scope|requirements)\}\}/);
      }
      expect(listPrompts().find((p) => p.name === "audit-routeros-containers")?.body).toContain(
        "Any implementation needs separate approval",
      );
      expect(listPrompts().find((p) => p.name === "setup-vlan-network")?.body).not.toContain(
        getRouterosContainerGuide(),
      );
      expect(executeMikrotikCommand).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
