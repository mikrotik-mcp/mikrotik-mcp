import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  buildAiFixPrompt,
  buildBatchAiFixPrompt,
  buildIssueDetailMarkdown,
  matchesSmartFeedbackQuery,
  parseSmartQuery,
} from "../raycast/src/lib/feedback-model";
import { runFeedback } from "../raycast/src/lib/fleet-menu";
import type { FeedbackIssue } from "../raycast/src/lib/types";

const raycast = vi.hoisted(() => ({
  environment: { launchType: "userInitiated" },
  toast: { style: "animated", message: "" },
  showToast: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  environment: raycast.environment,
  LaunchType: { Background: "background", UserInitiated: "userInitiated" },
  Toast: { Style: { Animated: "animated", Success: "success", Failure: "failure" } },
  showToast: raycast.showToast,
  Color: { Green: "green", Orange: "orange", Red: "red", SecondaryText: "secondary" },
  Icon: {},
  MenuBarExtra: {},
  Clipboard: {},
  launchCommand: vi.fn(),
  open: vi.fn(),
  openExtensionPreferences: vi.fn(),
  getPreferenceValues: vi.fn(),
}));

beforeEach(() => {
  raycast.environment.launchType = "userInitiated";
  raycast.toast = { style: "animated", message: "" };
  raycast.showToast.mockReset().mockImplementation(async () => {
    if (raycast.environment.launchType === "background") {
      throw new Error("Toast API is not available when command is launched in background");
    }
    return raycast.toast;
  });
});
afterEach(() => vi.restoreAllMocks());

test("background menu actions execute once without calling the unavailable Toast API", async () => {
  raycast.environment.launchType = "background";
  const action = vi.fn(async () => {});
  await expect(runFeedback("Refresh fleet", action)).resolves.toBeUndefined();
  expect(action).toHaveBeenCalledTimes(1);
  expect(raycast.showToast).not.toHaveBeenCalled();
});

test("background action failures are logged without a toast or an unhandled rejection", async () => {
  raycast.environment.launchType = "background";
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("Dashboard unavailable");
  await expect(
    runFeedback("Refresh fleet", async () => {
      throw error;
    }),
  ).resolves.toBeUndefined();
  expect(raycast.showToast).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("Refresh fleet failed:", error);
});

test("foreground feedback keeps success and failure updates", async () => {
  await runFeedback("Refresh fleet", async () => {});
  expect(raycast.showToast).toHaveBeenCalledWith({ style: "animated", title: "Refresh fleet" });
  expect(raycast.toast.style).toBe("success");
  await runFeedback("Refresh fleet", async () => {
    throw new Error("Dashboard unavailable");
  });
  expect(raycast.toast).toEqual({ style: "failure", message: "Dashboard unavailable" });
});

test("a rejected foreground toast never prevents or retries the requested action", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  raycast.showToast.mockRejectedValueOnce(new Error("Toast unavailable"));
  const action = vi.fn(async () => {});
  await expect(runFeedback("Refresh fleet", action)).resolves.toBeUndefined();
  expect(action).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalled();
});

const sampleIssue = (overrides: Partial<FeedbackIssue> = {}): FeedbackIssue => ({
  id: 11,
  fingerprint: "fp-wg-peer",
  kind: "missing_tool",
  impact: "blocker",
  status: "open",
  operation: "create_wireguard_peer",
  title: "Missing dedicated tool to flush DNS cache",
  detail: "Agent needed to flush RouterOS DNS cache without raw CLI.",
  expected: "A dedicated flush_dns_cache tool",
  actualError: "input does not match any value of item",
  workaround: "Use invoke_tool with flush_dns_cache",
  suggestedFix: "Add flush_dns_cache in src/tools/dns.ts",
  resolutionNote: null,
  fixedInVersion: null,
  replacementTool: null,
  memoryFactId: 42,
  githubIssueUrl: "https://github.com/mikrotik-mcp/mikrotik-mcp/issues/99",
  tags: ["dns", "wireguard"],
  occurrences: 5,
  firstSeenAt: 1700000000000,
  lastSeenAt: 1700003600000,
  resolvedAt: null,
  reopenedCount: 2,
  lastSource: "llm",
  lastCallId: "call_abc",
  lastDevice: "home-ax3",
  lastRouterosVersion: "7.16.2",
  lastAgentModel: "claude-opus-4-7",
  ...overrides,
});

describe("Raycast Tool Feedback model", () => {
  test("parses JQL-style filter tokens and plain search text", () => {
    const parsed = parseSmartQuery("kind:missing_tool impact:blocker is:hot dns cache");
    expect(parsed.plainQuery).toBe("dns cache");
    expect(parsed.tokens.map((t) => `${t.key}:${t.value}`)).toEqual([
      "kind:missing_tool",
      "impact:blocker",
      "is:hot",
    ]);
  });

  test("filters feedback issues by dropdown presets and smart query tokens", () => {
    const hotBlocker = sampleIssue();
    const resolvedMinor = sampleIssue({
      id: 12,
      kind: "docs_gap",
      impact: "suggestion",
      status: "resolved",
      occurrences: 1,
      reopenedCount: 0,
      memoryFactId: null,
      githubIssueUrl: null,
    });

    expect(
      matchesSmartFeedbackQuery(
        hotBlocker,
        "kind:missing_tool impact:blocker tool:wireguard device:home-ax3 ros:7.16 tag:dns is:hot is:reopened has:memory has:github flush",
        "preset:unresolved",
      ),
    ).toBe(true);
    expect(matchesSmartFeedbackQuery(resolvedMinor, "is:hot", "all")).toBe(false);
    expect(matchesSmartFeedbackQuery(resolvedMinor, "", "status:resolved")).toBe(true);
    expect(matchesSmartFeedbackQuery(resolvedMinor, "", "preset:unresolved")).toBe(false);
  });

  test("builds single and batch AI Fix Prompts and Markdown detail with telemetry", () => {
    const first = sampleIssue({ id: 1, title: "First issue" });
    const second = sampleIssue({ id: 2, title: "Second issue", occurrences: 3 });

    const singlePrompt = buildAiFixPrompt(first);
    expect(singlePrompt).toContain("Resolve LLM tool-feedback issue #1: **First issue**");
    expect(singlePrompt).toContain("`create_wireguard_peer`");

    const batchPrompt = buildBatchAiFixPrompt([first, second]);
    expect(batchPrompt).toContain("Resolve a batch of **2 LLM tool-feedback issues**");
    expect(batchPrompt).toContain("## Issue #1: First issue");
    expect(batchPrompt).toContain("## Issue #2: Second issue");

    const md = buildIssueDetailMarkdown(first, [
      {
        id: 100,
        issueId: 1,
        ts: 1700003600000,
        source: "llm",
        callId: "call_1",
        device: "home-ax3",
        routerosVersion: "7.16.2",
        agentModel: "claude-opus-4-7",
        detail: "Failed call",
        actualError: "syntax error",
        workaround: null,
      },
    ]);
    expect(md).toContain("# #1 · First issue");
    expect(md).toContain("## Sighting Timeline (1 recent)");
    expect(md).toContain("`call_1`");
  });
});
