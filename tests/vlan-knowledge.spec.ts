import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MikrotikConfigSchema } from "../src/config";
import { executeMikrotikCommand } from "../src/core/connector";
import { getConfig, setConfig } from "../src/core/runtime";
import {
  getVlanSegmentationGuide,
  VLAN_GUIDE_TOPICS,
  VLAN_GUIDE_URI,
  VLAN_INSTRUCTIONS,
} from "../src/core/vlan-guidance";
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
      tools: { enabledModules: [enabled ? "vlan-designer" : "dns"] },
      mcp: { appViews: false, toolPageSize: 0 },
    }),
  );
  const { server } = createServer();
  const client = new Client({ name: "vlan-knowledge-test", version: "1" });
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

describe("VLAN knowledge delivery (offline real MCP protocol)", () => {
  test.each([
    [false, true],
    [true, true],
    [true, false],
    [false, false],
  ])(
    "readOnly=%s and designer enabled=%s preserve guidance without device I/O",
    async (readOnly, enabled) => {
      const { client, close } = await connected(readOnly, enabled);
      try {
        expect(client.getInstructions()).toContain(VLAN_INSTRUCTIONS);
        expect(client.getInstructions()?.includes("Tool-only clients:")).toBe(enabled);
        const resource = (await client.listResources()).resources.find(
          (r) => r.uri === VLAN_GUIDE_URI,
        );
        expect(resource?.mimeType).toBe("text/markdown");
        const result = await client.readResource({ uri: VLAN_GUIDE_URI });
        expect(result.contents[0]).toMatchObject({ text: getVlanSegmentationGuide() });
        const names = (await client.listTools()).tools;
        const guide = names.find((t) => t.name === "get_vlan_segmentation_guide");
        expect(Boolean(guide)).toBe(enabled);
        expect(names.some((t) => t.name === "design_network_segment")).toBe(enabled && !readOnly);
        if (enabled) {
          expect(guide?.inputSchema.properties).not.toHaveProperty("device");
          expect(guide?.annotations?.readOnlyHint).toBe(true);
          const found = await client.callTool({
            name: "find_tools",
            arguments: { query: "get_vlan_segmentation_guide" },
          });
          expect(JSON.stringify(found.content)).toContain("get_vlan_segmentation_guide");
          const read = await client.callTool({
            name: "get_vlan_segmentation_guide",
            arguments: {},
          });
          expect(read.isError).toBeFalsy();
          expect(read.content).toEqual([{ type: "text", text: getVlanSegmentationGuide() }]);
          const invalid = await client.callTool({
            name: "get_vlan_segmentation_guide",
            arguments: { topic: "unknown" },
          });
          expect(invalid.isError).toBe(true);
        }
        expect(executeMikrotikCommand).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    },
  );

  test("every selected topic is bounded, shares the guide version and is part of the full guide", () => {
    const full = getVlanSegmentationGuide();
    for (const topic of VLAN_GUIDE_TOPICS) {
      const part = getVlanSegmentationGuide(topic);
      expect(part.length).toBeLessThan(full.length);
      expect(part).toContain("Reference only; no device inspection or changes.");
      expect(full).toContain(part.split("\n\n")[1]);
    }
    for (const boundary of [
      "filtering LAST",
      "bridge/CPU",
      "wifi-qcom-ac",
      "IPv6",
      "INPUT",
      "FORWARD",
      "PVID",
      "FastTrack",
      "return routes",
      "real representative wired AND wireless",
      "Memory never grants new",
    ]) {
      expect(full).toContain(boundary);
    }
    expect(full).not.toMatch(/86\.104\.|185\.192\.|10\.79\.79\.|home-ax3|netherlands/);
  });

  test("MCP and dashboard/Raycast catalog share the same guide and recipes", async () => {
    const { client, close } = await connected(true, true);
    try {
      for (const name of ["setup-vlan-network", "setup-guest-wifi", "audit-vlan-segmentation"]) {
        const prompt = listPrompts().find((p) => p.name === name)!;
        expect(prompt).toBeDefined();
        expect(prompt.body).toContain(getVlanSegmentationGuide());
        const args = Object.fromEntries(prompt.arguments.map((a) => [a.name, `test-${a.name}`]));
        const rendered = await client.getPrompt({ name, arguments: { ...args, device: "b" } });
        expect(JSON.stringify(rendered.messages)).toContain("bridge/CPU");
        expect(composePrompt(prompt, args, "Audit only", "a")).toContain(
          getVlanSegmentationGuide(),
        );
        const content = rendered.messages[0]?.content;
        expect(content.type).toBe("text");
        if (content.type === "text") {
          expect(content.text).toContain(getVlanSegmentationGuide());
          expect(content.text).toContain('Target device (configured MCP key or label): "b"');
          expect(content.text).toContain("do not substitute the default");
        }
      }
      expect(listPrompts().find((p) => p.name === "audit-vlan-segmentation")?.body).toContain(
        "Any future implementation needs separate approval",
      );
      expect(listPrompts().find((p) => p.name === "manage-certificates")?.body).not.toContain(
        getVlanSegmentationGuide(),
      );
      const withoutOptions = await client.getPrompt({
        name: "audit-vlan-segmentation",
        arguments: {},
      });
      const auditText = withoutOptions.messages[0]?.content;
      if (auditText.type !== "text") throw new Error("Expected audit text");
      expect(auditText.text).not.toContain("{{requirements}}");
      expect(auditText.text).toContain("(not specified; ask if needed)");
      expect(executeMikrotikCommand).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
