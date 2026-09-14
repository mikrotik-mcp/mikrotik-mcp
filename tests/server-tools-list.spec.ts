import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MikrotikConfigSchema } from "../src/config";
import { executeMikrotikCommand } from "../src/core/connector";
import { getConfig, setConfig } from "../src/core/runtime";
import { createServer } from "../src/server";
import { allToolModules } from "../src/tools";

// Discovery must never probe a device, even with capability gating enabled.
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));

const original = getConfig();
afterEach(() => {
  setConfig(original);
  vi.clearAllMocks();
});

describe("tools/list over the real MCP transport (offline)", () => {
  for (const capabilityGating of ["off", "annotate", "filter"] as const) {
    for (const appViews of [false, true]) {
      test.each([0, 37, 50, 100])(
        `${capabilityGating}, appViews=${appViews}, pageSize=%i lists the full catalog`,
        async (toolPageSize) => {
          setConfig(
            MikrotikConfigSchema.parse({
              devices: {
                offline_a: { host: "127.0.0.1", port: 1 },
                offline_b: { host: "127.0.0.1", port: 1 },
              },
              defaultDevice: "offline_a",
              disableUpdateCheck: true,
              memory: { enabled: false },
              mcp: { capabilityGating, appViews, toolPageSize },
            }),
          );
          const { server } = createServer();
          const client = new Client({ name: "tools-list-regression", version: "1" });
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          try {
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            const tools: Tool[] = [];
            const cursors = new Set<string>();
            const total = allToolModules.flat().length;
            const expectedPages = toolPageSize === 0 ? 1 : Math.ceil(total / toolPageSize);
            let pages = 0;
            let cursor: string | undefined;
            do {
              const page = await client.listTools(cursor ? { cursor } : undefined);
              expect(page.tools.length).toBe(
                toolPageSize === 0 ? total : Math.min(toolPageSize, total - tools.length),
              );
              pages += 1;
              expect(pages).toBeLessThanOrEqual(expectedPages);
              tools.push(...page.tools);
              cursor = page.nextCursor;
              if (toolPageSize === 0) expect(cursor).toBeUndefined();
              if (cursor) {
                expect(cursors.has(cursor), "pagination must make progress").toBe(false);
                cursors.add(cursor);
              }
            } while (cursor);
            expect(pages).toBe(expectedPages);

            expect(tools.map((tool) => tool.name).sort()).toEqual(
              allToolModules
                .flat()
                .map((tool) => tool.name)
                .sort(),
            );
            for (const tool of tools) {
              expect(tool.inputSchema.type).toBe("object");
              if (tool.outputSchema) expect(tool.outputSchema.type).toBe("object");
              if (!appViews) expect(tool._meta).toBeUndefined();
            }
            expect(
              tools.find((tool) => tool.name === "get_system_identity")?.inputSchema.properties,
            ).toHaveProperty("device");
            // This record field invokes the processor that crashed with a
            // mismatched Zod context. Assert its schema is preserved, not hidden.
            expect(
              tools.find((tool) => tool.name === "set_aaa_settings")?.inputSchema.properties
                ?.fields,
            ).toMatchObject({
              type: "object",
              propertyNames: { type: "string" },
              additionalProperties: { type: "string" },
            });
            expect(executeMikrotikCommand).not.toHaveBeenCalled();
          } finally {
            await client.close();
            await server.close();
          }
        },
      );
    }
  }
});
