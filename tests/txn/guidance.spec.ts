import { afterEach, describe, expect, test } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { createServer } from "../../src/server";
import { listPrompts } from "../../src/prompts";
import { TRANSACTION_WORKFLOW, TRANSACTION_TOOL_NAMES } from "../../src/txn/guidance";
import { txnTools } from "../../src/tools/txn";

const original = getConfig();
afterEach(() => setConfig(original));

async function connected(overrides: Record<string, unknown> = {}) {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { a: { host: "127.0.0.1", port: 1 }, b: { host: "127.0.0.1", port: 1 } },
      defaultDevice: "a",
      disableUpdateCheck: true,
      memory: { enabled: false },
      tools: { enabledModules: ["txn"] },
      ...overrides,
    }),
  );
  const { server } = createServer();
  const client = new Client({ name: "txn-guidance-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("model-facing transaction guidance (offline MCP handshake)", () => {
  test("initialization promotes the available workflow and keeps approval boundaries", async () => {
    const { client, close } = await connected();
    try {
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain(TRANSACTION_WORKFLOW);
      expect(instructions).not.toContain("configure each side by passing");
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of TRANSACTION_TOOL_NAMES) expect(names).toContain(name);
      for (const boundary of [
        "REAL WRITE",
        "NOT ACID",
        "PARTIAL",
        "user's approval",
        "read tools",
        "jump_host LAST",
      ])
        expect(instructions).toContain(boundary);
    } finally {
      await close();
    }
  });

  test.each([
    { readOnly: true },
    { tools: { disabledModules: ["txn"] } },
    { tools: { enabledModules: ["dns"] } },
    { devices: { a: { host: "127.0.0.1", port: 1 } } },
    { devices: { a: { host: "127.0.0.1" }, b: { mac: "02:00:00:00:00:02" } } },
    { devices: { a: { host: "127.0.0.1" }, b: { host: "127.0.0.2", disabled: true } } },
  ])("does not promote an unavailable workflow: %j", async (config) => {
    const { client, close } = await connected(config);
    try {
      expect(client.getInstructions()).not.toContain(TRANSACTION_WORKFLOW);
    } finally {
      await close();
    }
  });

  test("prompt delivery includes the workflow and substitutes the actual participants", async () => {
    const { client, close } = await connected();
    try {
      const prompt = await client.getPrompt({
        name: "setup-tunnel-between-sites",
        arguments: {
          device_a: "a",
          device_b: "b",
          technology: "wireguard",
        },
      });
      const text = prompt.messages[0]?.content;
      expect(text?.type).toBe("text");
      if (text?.type !== "text") throw new Error("Expected prompt text");
      expect(text.text).toContain(TRANSACTION_WORKFLOW);
      expect(text.text).toContain("Device A: a");
      expect(text.text).toContain("Device B: b");
      expect(text.text).toContain("replace its individual write calls");
      expect(text.text).not.toContain("{{device_a}}");
    } finally {
      await close();
    }
  });

  test("every cross-device tunnel recipe gets guidance; diagnostic prompts stay read-only", () => {
    const prompts = listPrompts();
    const tunnelPrompts = prompts.filter((p) => p.name.endsWith("-tunnel-between-sites"));
    expect(tunnelPrompts.length).toBeGreaterThan(5);
    for (const prompt of tunnelPrompts) expect(prompt.body).toContain(TRANSACTION_WORKFLOW);
    expect(prompts.find((p) => p.name === "diagnose-connectivity")?.body).not.toContain(
      TRANSACTION_WORKFLOW,
    );
    expect(
      txnTools.find((t) => t.name === "verify_transaction")?.annotations.readOnlyHint,
    ).not.toBe(true);
    expect(txnTools.find((t) => t.name === "commit_transaction")?.annotations.destructiveHint).toBe(
      true,
    );
  });
});
