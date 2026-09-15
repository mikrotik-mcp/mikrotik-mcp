// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { connectApp, h } from "../../ui/shared/kit";

type Result = Parameters<NonNullable<App["ontoolresult"]>>[0];
type FixtureApp = Omit<App, "connect" | "callServerTool"> & {
  connect: ReturnType<typeof vi.fn<App["connect"]>>;
  callServerTool: ReturnType<typeof vi.fn<App["callServerTool"]>>;
};

function harness() {
  const root = h("div", {}, "Waiting for data…");
  document.body.append(root);
  const app = {
    connect: vi.fn(async () => {}),
    getHostVersion: () => ({ name: "test-host", version: "1" }),
    getHostCapabilities: () => ({}),
    callServerTool: vi.fn(),
    ontoolresult: undefined,
    ontoolcancelled: undefined,
    onteardown: vi.fn(async () => ({})),
    onclose: vi.fn(),
  } as unknown as FixtureApp;
  const adopt = vi.fn((sc: unknown) => {
    if (!sc || typeof sc !== "object" || !("rows" in sc)) return false;
    root.replaceChildren(h("p", {}, "Interactive result"));
    return true;
  });
  return {
    root,
    app,
    adopt,
    connect: () => connectApp(app as unknown as App, "test-view", root, adopt),
  };
}

describe("MCP App result lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("accepts a result delivered during initialization, without later replacing it", async () => {
    const { app, root, connect } = harness();
    vi.mocked(app.connect).mockImplementation(async () => {
      expect(app.ontoolcancelled).toBeTypeOf("function");
      app.ontoolresult!({ content: [], structuredContent: { rows: [] } });
    });
    expect(await connect()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.textContent).toBe("Interactive result");
    expect(app.callServerTool).not.toHaveBeenCalled();
  });

  it.each<[string, Result, string]>([
    [
      "plain text",
      { content: [{ type: "text", text: "No matching DHCP leases." }] },
      "No matching DHCP leases.",
    ],
    ["empty response", { content: [] }, "No data returned"],
    ["whitespace", { content: [{ type: "text", text: "  \n " }] }, "No data returned"],
    [
      "custom structured output",
      { content: [], structuredContent: { custom: true } },
      '"custom": true',
    ],
    [
      "error",
      {
        isError: true,
        content: [{ type: "text", text: "SSH timed out" }],
        structuredContent: { rows: [] },
      },
      "SSH timed out",
    ],
    ["error without details", { isError: true, content: [] }, "Tool failed"],
    [
      "non-text response",
      { content: [{ type: "image", data: "", mimeType: "image/png" }] },
      "non-text content",
    ],
  ])("shows %s instead of an endless skeleton", async (_name, result, expected) => {
    const { app, root, adopt, connect } = harness();
    await connect();
    app.ontoolresult!(result);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.textContent).toContain(expected);
    expect(root.textContent).not.toContain("Waiting for data");
    if (result.isError) {
      expect(adopt).not.toHaveBeenCalled();
      expect(root.querySelector('[role="alert"]')).not.toBeNull();
    }
    expect(app.callServerTool).not.toHaveBeenCalled();
  });

  it("preserves both fallback text and custom JSON without interpreting markup", async () => {
    const { app, root, connect } = harness();
    await connect();
    app.ontoolresult!({
      content: [{ type: "text", text: '<img src=x onerror="alert(1)">' }],
      structuredContent: { note: "<script>bad()</script>" },
    });
    expect(root.textContent).toContain("<img");
    expect(root.textContent).toContain("<script>");
    expect(root.querySelector("img,script")).toBeNull();
  });

  it("surfaces renderer errors, and accepts a later valid result", async () => {
    const { app, root, adopt, connect } = harness();
    await connect();
    adopt.mockImplementationOnce(() => {
      throw new Error("malformed rows");
    });
    app.ontoolresult!({ content: [{ type: "text", text: "Original summary" }] });
    expect(root.textContent).toContain("invalid view payload");
    expect(root.textContent).toContain("Original summary");
    app.ontoolresult!({ content: [], structuredContent: { rows: [] } });
    expect(root.textContent).toBe("Interactive result");
  });

  it("distinguishes a delayed result from handshake failure and accepts late data", async () => {
    const { app, root, connect } = harness();
    await connect();
    expect(app.connect).toHaveBeenCalledWith(undefined, { timeout: 10_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(root.textContent).toContain("Still awaiting the tool result");
    expect(app.callServerTool).not.toHaveBeenCalled();
    app.ontoolresult!({ content: [], structuredContent: { rows: [] } });
    expect(root.textContent).toBe("Interactive result");
  });

  it("renders cancellation and never retries the cancelled tool", async () => {
    const { app, root, connect } = harness();
    await connect();
    app.ontoolcancelled!({ reason: "Cancelled by the user" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.textContent).toContain("Cancelled by the user");
    expect(app.callServerTool).not.toHaveBeenCalled();
  });

  it("shows handshake failure without leaving a pending-result timer", async () => {
    const { app, root, connect } = harness();
    vi.mocked(app.connect).mockRejectedValue(new Error("Request timed out"));
    expect(await connect()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.textContent).toContain("host did not respond");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves teardown, cancels timers and ignores notifications after disposal", async () => {
    const { app, root, connect } = harness();
    const teardown = app.onteardown;
    await connect();
    await app.onteardown!({}, {} as never);
    const before = root.textContent;
    await vi.advanceTimersByTimeAsync(30_000);
    app.ontoolresult!({ content: [], structuredContent: { rows: [] } });
    app.ontoolcancelled!({});
    expect(teardown).toHaveBeenCalledOnce();
    expect(root.textContent).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a disconnected host when no result arrived, while preserving the close hook", async () => {
    const { app, root, connect } = harness();
    const close = app.onclose;
    await connect();
    app.onclose!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(close).toHaveBeenCalledOnce();
    expect(root.textContent).toContain("Host disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });
});
