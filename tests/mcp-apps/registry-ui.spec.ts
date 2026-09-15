/**
 * MCP Apps — registry UI extension (Vitest).
 *
 * Verifies that `defineTool` opts a tool into an interactive view without
 * disturbing plain tools: UI metadata is advertised on the registration, and a
 * handler may return `structuredContent` for the view while keeping its text
 * fallback. No device or network is touched.
 */
import { describe, it, expect } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defineTool, READ, WRITE } from "../../src/core/registry";
import {
  toolUiMeta,
  UI_RESOURCE_MIME_TYPE,
  UI_RESOURCE_URI_LEGACY_KEY,
  OPENAI_OUTPUT_TEMPLATE_KEY,
} from "../../src/core/ui-meta";
import { registerUiResources, uiViewUri, UI_VIEWS } from "../../src/core/ui-resources";

interface Captured {
  name: string;
  config: Record<string, any>;
  cb: (args: Record<string, unknown>) => Promise<any>;
}

/** Minimal fake McpServer that records `registerTool` calls. */
function fakeServer(): { server: any; calls: Captured[] } {
  const calls: Captured[] = [];
  const server = {
    registerTool: (name: string, config: any, cb: any) => calls.push({ name, config, cb }),
  };
  return { server, calls };
}

describe("toolUiMeta", () => {
  it("advertises the view under all host-specific keys", () => {
    const meta = toolUiMeta({ resourceUri: "ui://mikrotik/x.html" });
    expect(meta.ui).toEqual({ resourceUri: "ui://mikrotik/x.html" });
    expect(meta[UI_RESOURCE_URI_LEGACY_KEY]).toBe("ui://mikrotik/x.html");
    expect(meta[OPENAI_OUTPUT_TEMPLATE_KEY]).toBe("ui://mikrotik/x.html");
  });

  it("includes visibility when provided", () => {
    const meta = toolUiMeta({
      resourceUri: "ui://mikrotik/x.html",
      visibility: ["app"],
    });
    expect(meta.ui).toEqual({
      resourceUri: "ui://mikrotik/x.html",
      visibility: ["app"],
    });
  });

  it("uses the MCP App profile mime type", () => {
    expect(UI_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });
});

describe("defineTool — plain tools are unchanged", () => {
  it("registers no _meta and wraps a string result as text", async () => {
    const tool = defineTool({
      name: "plain_tool",
      title: "Plain",
      description: "plain text tool",
      annotations: READ,
      handler: () => "hello world",
    });
    const { server, calls } = fakeServer();
    tool.register(server);

    expect(calls).toHaveLength(1);
    expect(calls[0].config._meta).toBeUndefined();
    expect(tool.ui).toBeUndefined();

    const result = await calls[0].cb({});
    expect(result.content[0].text).toBe("hello world");
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("defineTool — UI-enabled tools", () => {
  const resourceUri = uiViewUri("dashboard");

  it("advertises the ui:// resource on the registration", () => {
    const tool = defineTool({
      name: "ui_tool",
      title: "UI Tool",
      description: "renders a view",
      annotations: READ,
      ui: { resourceUri },
      handler: () => ({ text: "summary", structuredContent: { a: 1 } }),
    });
    const { server, calls } = fakeServer();
    tool.register(server);

    expect(tool.ui).toEqual({ resourceUri });
    const meta = calls[0].config._meta;
    expect(meta.ui.resourceUri).toBe(resourceUri);
    expect(meta[OPENAI_OUTPUT_TEMPLATE_KEY]).toBe(resourceUri);
  });

  it("passes structuredContent through to the result for the view", async () => {
    const tool = defineTool({
      name: "ui_tool2",
      title: "UI Tool 2",
      description: "renders a view",
      annotations: READ,
      ui: { resourceUri },
      handler: () => ({ text: "summary", structuredContent: { cpu: 42 } }),
    });
    const { server, calls } = fakeServer();
    tool.register(server);

    const result = await calls[0].cb({});
    expect(result.content[0].text).toBe("summary"); // text fallback preserved
    expect(result.structuredContent).toEqual({ cpu: 42 });
  });

  it("still works when a UI tool returns a plain string (no structured data)", async () => {
    const tool = defineTool({
      name: "ui_tool3",
      title: "UI Tool 3",
      description: "renders a view",
      annotations: READ,
      ui: { resourceUri },
      handler: () => "just text",
    });
    const { server, calls } = fakeServer();
    tool.register(server);

    const result = await calls[0].cb({});
    expect(result.content[0].text).toBe("just text");
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("defineTool — auto records view for read tools", () => {
  const recordsUri = uiViewUri("records");

  it("delivers empty, textual, custom and failed results through the real SDK", async () => {
    const server = new McpServer({ name: "result-test", version: "1.0.0" });
    const client = new Client({ name: "result-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handlers = {
      list_empty_probe: () => "",
      get_text_probe: () => "No matching records.",
      get_custom_probe: () => ({ text: "Custom summary", structuredContent: { custom: true } }),
      get_error_probe: () => {
        throw new Error("SSH timeout");
      },
    };
    for (const [name, handler] of Object.entries(handlers)) {
      defineTool({
        name,
        title: name,
        description: "offline probe",
        annotations: READ,
        handler,
      }).register(server);
    }
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.every((t) => t.outputSchema && t._meta?.ui)).toBe(true);
      const empty = await client.callTool({ name: "list_empty_probe", arguments: {} });
      expect(empty.isError).not.toBe(true);
      expect(empty.structuredContent).toMatchObject({
        __mikrotikView: "records",
        rows: [],
        raw: "",
      });
      const text = await client.callTool({ name: "get_text_probe", arguments: {} });
      expect(text.structuredContent).toMatchObject({
        __mikrotikView: "records",
        raw: "No matching records.",
      });
      const custom = await client.callTool({ name: "get_custom_probe", arguments: {} });
      expect(custom.structuredContent).toEqual({ custom: true });
      const error = await client.callTool({ name: "get_error_probe", arguments: {} });
      expect(error.isError).toBe(true);
      expect(error.content).toContainEqual({ type: "text", text: "Error: SSH timeout" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("attaches the records view + structuredContent to a list_* read tool", async () => {
    const tool = defineTool({
      name: "list_widgets",
      title: "List Widgets",
      description: "lists things",
      annotations: READ,
      handler: () => 'WIDGETS:\n\n 0 name="a" type="x"\n 1 name="b" type="y"',
    });
    const { server, calls } = fakeServer();
    tool.register(server);

    // Advertised as a UI tool even though the handler returned plain text.
    expect(calls[0].config._meta.ui.resourceUri).toBe(recordsUri);
    expect(calls[0].config._meta.ui.visibility).toEqual(["model", "app"]);

    const result = await calls[0].cb({});
    const sc = result.structuredContent;
    expect(sc.__mikrotikView).toBe("records");
    expect(sc.tool).toBe("list_widgets");
    expect(sc.kind).toBe("list");
    expect(sc.count).toBe(2);
    // Text fallback preserved for text-only hosts.
    expect(result.content[0].text).toMatch(/WIDGETS/);
  });

  it("does not attach to write tools or to non-verb read tools", () => {
    const write = defineTool({
      name: "get_widget_now",
      title: "Set",
      description: "writes",
      annotations: WRITE,
      handler: () => "ok",
    });
    const plainRead = defineTool({
      name: "ping_host",
      title: "Ping",
      description: "reads but not a list/get verb",
      annotations: READ,
      handler: () => "ok",
    });
    const { server, calls } = fakeServer();
    write.register(server);
    plainRead.register(server);
    expect(calls[0].config._meta).toBeUndefined();
    expect(calls[1].config._meta).toBeUndefined();
  });

  it("lets a read tool keep its own structuredContent", async () => {
    const tool = defineTool({
      name: "get_special",
      title: "Get Special",
      description: "custom structured output",
      annotations: READ,
      handler: () => ({ text: "summary", structuredContent: { custom: true } }),
    });
    const { server, calls } = fakeServer();
    tool.register(server);
    const result = await calls[0].cb({});
    expect(result.structuredContent).toEqual({ custom: true });
  });
});

describe("UI view registry", () => {
  it("lists and reads MCP App resources through the installed server SDK", async () => {
    const server = new McpServer({ name: "resource-test", version: "1.0.0" });
    const client = new Client({ name: "resource-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerUiResources(server);
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { resources } = await client.listResources();
      expect(resources).toHaveLength(UI_VIEWS.length);
      for (const view of UI_VIEWS) {
        const uri = uiViewUri(view.id);
        expect(resources.find((r) => r.uri === uri)).toMatchObject({
          name: view.name,
          description: view.description,
          mimeType: UI_RESOURCE_MIME_TYPE,
        });
        const { contents } = await client.readResource({ uri });
        expect(contents[0]).toMatchObject({ uri, mimeType: UI_RESOURCE_MIME_TYPE });
        const content = contents[0];
        expect("text" in content ? content.text : undefined).toMatch(/<html/i);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("builds a stable ui:// uri from a view id", () => {
    expect(uiViewUri("dashboard")).toBe("ui://mikrotik/dashboard.html?v=2");
  });

  it("has at least one view with unique ids", () => {
    expect(UI_VIEWS.length).toBeGreaterThan(0);
    const ids = new Set(UI_VIEWS.map((v) => v.id));
    expect(ids.size).toBe(UI_VIEWS.length);
  });
});
