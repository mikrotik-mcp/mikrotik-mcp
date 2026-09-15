// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { VIEW_FIXTURES } from "./view-fixtures";
import { REPORT_VIEW_META } from "../../src/core/report-views";

type Result = Parameters<NonNullable<App["ontoolresult"]>>[0];
const bridge = vi.hoisted(() => ({
  app: undefined as App | undefined,
  result: undefined as Result | undefined,
  callServerTool: vi.fn(),
}));

vi.mock("@modelcontextprotocol/ext-apps", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@modelcontextprotocol/ext-apps")>();
  return {
    ...sdk,
    App: class {
      ontoolresult?: App["ontoolresult"];
      constructor() {
        bridge.app = this as unknown as App;
      }
      async connect() {
        if (bridge.result) this.ontoolresult?.(bridge.result);
      }
      getHostVersion() {
        return { name: "fixture-host", version: "1" };
      }
      getHostCapabilities() {
        return {};
      }
      callServerTool = bridge.callServerTool;
    },
  };
});

const views = [
  ["records", () => import("../../ui/records/main")],
  ["interfaces", () => import("../../ui/interfaces/main")],
  ["firewall", () => import("../../ui/firewall/main")],
  ["firewall-audit", () => import("../../ui/firewall-audit/main")],
  ["connected-devices", () => import("../../ui/connected-devices/main")],
  ["dashboard", () => import("../../ui/dashboard/main")],
  ["aaa", () => import("../../ui/aaa/main")],
  ["investigations", () => import("../../ui/investigations/main")],
  ["round-trip", () => import("../../ui/round-trip/main")],
  ["service-health", () => import("../../ui/service-health/main")],
  ["fabric", () => import("../../ui/fabric/main")],
  ["operations", () => import("../../ui/operations/main")],
  ["reports", () => import("../../ui/reports/main")],
] as const;

describe.each(views)("%s real view entrypoint", (_name, load) => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = document.createElement("div");
    root.id = "app";
    document.body.replaceChildren(root);
  });
  afterEach(async () => {
    await bridge.app?.onteardown?.({}, {} as never);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    bridge.app = undefined;
    bridge.result = undefined;
    bridge.callServerTool.mockClear();
    document.body.replaceChildren();
  });

  it.each<[Result, string]>([
    [{ content: [] }, "No data returned"],
    [{ content: [{ type: "text", text: "No matching records." }] }, "No matching records."],
    [{ content: [], structuredContent: { custom: true } }, '"custom": true'],
    [
      { content: [{ type: "text", text: "Device unavailable" }], isError: true },
      "Device unavailable",
    ],
  ])("renders a non-interactive result received during connect", async (result, expected) => {
    bridge.result = result;
    await load();
    // A late input notification must not replace error/fallback feedback.
    bridge.app?.ontoolinput?.({ arguments: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.getElementById("app")!.textContent).toContain(expected);
    expect(bridge.callServerTool).not.toHaveBeenCalled();
  });

  it("renders cancellation after a successful bridge connection", async () => {
    await load();
    bridge.app!.ontoolcancelled!({ reason: "User stopped this call" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.getElementById("app")!.textContent).toContain("User stopped this call");
    expect(bridge.callServerTool).not.toHaveBeenCalled();
  });
  it("renders a valid typed result without waiting for another call", async () => {
    bridge.result = { content: [], structuredContent: VIEW_FIXTURES[_name] };
    await load();
    const root = document.getElementById("app")!;
    expect(root.textContent).not.toContain("Waiting for data");
    expect(root.textContent?.length).toBeGreaterThan(100);
    expect(root.querySelector("h1")).not.toBeNull();
    expect(bridge.callServerTool).not.toHaveBeenCalled();
  });
  if (VIEW_FIXTURES[_name].__mikrotikView === "report") {
    it("renders metadata without requiring replacement of the tool's structured contract", async () => {
      bridge.result = {
        content: [],
        structuredContent: { original: true },
        _meta: { [REPORT_VIEW_META]: VIEW_FIXTURES[_name] },
      };
      await load();
      expect(document.getElementById("app")!.querySelector("h1")?.textContent).toBe(
        VIEW_FIXTURES[_name].title,
      );
      expect(bridge.callServerTool).not.toHaveBeenCalled();
    });
  }
});
