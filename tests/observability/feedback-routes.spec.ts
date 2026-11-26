import { beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { atomicWrite } from "../../src/config-write";
import { getConfig, setConfig } from "../../src/core/runtime";
import { getFeedbackStore, installFeedbackStore } from "../../src/feedback/accessor";
import { openFeedbackStore } from "../../src/feedback/store";
import { feedbackRoutes } from "../../src/observability/feedback-routes";

vi.mock("../../src/feedback/accessor", () => ({
  getFeedbackStore: vi.fn(),
  installFeedbackStore: vi.fn(),
  closeFeedbackStore: vi.fn(),
}));
vi.mock("../../src/feedback/store", () => ({ openFeedbackStore: vi.fn() }));
vi.mock("../../src/config-write", () => ({ atomicWrite: vi.fn(), serializeConfig: () => "{}" }));

const summaryStub = {
  totalIssues: 1,
  totalOccurrences: 3,
  openIssues: 1,
  inProgressIssues: 0,
  resolvedIssues: 0,
  wontFixIssues: 0,
  blockersOpen: 0,
  repeatOccurrencesSaved: 2,
  byKind: {},
  byImpact: {},
  topOperations: [],
};

const store = {
  list: vi.fn(() => ({ items: [], total: 0, limit: 50, offset: 0, summary: summaryStub })),
  submit: vi.fn(() => ({
    action: "created",
    deduplicated: false,
    matchStage: "none",
    similarity: 0,
    issue: { id: 1, occurrences: 1 },
    advice: "Recorded",
  })),
  get: vi.fn((id: number) =>
    id === 1 || id === 2
      ? {
          issue: {
            id,
            fingerprint: `abc123def45${id}`,
            kind: "missing_tool",
            impact: "degraded",
            status: "open",
            operation: "/ip/dns/cache",
            title: `Missing dedicated tool to flush DNS cache #${id}`,
            detail: "Had to use run_routeros_command.",
            expected: null,
            actualError: null,
            workaround: null,
            suggestedFix: null,
            resolutionNote: "Added flush_dns_cache in v6.17.0",
            fixedInVersion: "v6.17.0",
            replacementTool: "flush_dns_cache",
            memoryFactId: null,
            githubIssueUrl: null,
            tags: ["dns"],
            occurrences: 2,
            firstSeenAt: 1700000000000,
            lastSeenAt: 1700000005000,
            resolvedAt: null,
            reopenedCount: 0,
            lastSource: "llm",
            lastCallId: null,
            lastDevice: "home-ax3",
            lastRouterosVersion: "7.16.2",
            lastAgentModel: "claude-opus-4-7",
          },
          occurrences: [],
          similar: [],
        }
      : null,
  ),
  update: vi.fn(() => ({
    id: 1,
    status: "resolved",
    resolutionNote: "Added flush_dns_cache in v6.17.0",
    fixedInVersion: "v6.17.0",
    replacementTool: "flush_dns_cache",
    memoryFactId: null,
  })),
  merge: vi.fn(() => ({ id: 1, occurrences: 5 })),
  deleteIssues: vi.fn(() => 1),
  clear: vi.fn(() => 3),
  summary: vi.fn(() => summaryStub),
  close: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { test: { host: "127.0.0.1" } },
      defaultDevice: "test",
      memory: { enabled: false },
      feedback: { enabled: true, dbPath: ":memory:" },
    }),
  );
  vi.mocked(getFeedbackStore).mockResolvedValue(store as never);
  vi.mocked(openFeedbackStore).mockResolvedValue(store as never);
  vi.mocked(atomicWrite).mockImplementation(() => {});
});

async function request(path: string, method = "GET", data?: unknown, raw?: string) {
  const url = new URL(`http://localhost/api/feedback${path}`);
  return (await feedbackRoutes(
    new Request(
      url,
      method === "GET" && data === undefined && raw === undefined
        ? { method }
        : {
            method,
            body: raw ?? (data !== undefined ? JSON.stringify(data) : undefined),
            headers: { "content-type": "application/json" },
          },
    ),
    url,
  ))!;
}

test("feedback REST validates inputs, supports CRUD and merge, and rejects malformed requests", async () => {
  expect((await request("?limit=20&status=open")).status).toBe(200);
  expect(store.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, status: "open" }));

  // Invalid POST payload
  expect((await request("", "POST", { kind: "bug", title: "x" })).status).toBe(400);
  expect((await request("", "POST", undefined, "{")).status).toBe(400);
  expect(store.submit).not.toHaveBeenCalled();

  // Valid POST payload
  const created = await request("", "POST", {
    kind: "missing_tool",
    impact: "degraded",
    operation: "/ip/dns/cache",
    title: "Missing dedicated tool to flush DNS cache",
    detail: "Had to use run_routeros_command to flush DNS cache.",
  });
  expect(created.status).toBe(200);
  expect(store.submit).toHaveBeenCalledOnce();

  // GET by id & 404
  expect((await request("/1")).status).toBe(200);
  expect((await request("/999")).status).toBe(404);

  // PATCH status & resolution_note
  const patched = await request("/1", "PATCH", {
    status: "resolved",
    resolution_note: "Added flush_dns_cache in v6.17.0",
    fixed_in_version: "v6.17.0",
    replacement_tool: "flush_dns_cache",
  });
  expect(patched.status).toBe(200);
  expect(store.update).toHaveBeenCalledWith(1, {
    status: "resolved",
    resolution_note: "Added flush_dns_cache in v6.17.0",
    fixed_in_version: "v6.17.0",
    replacement_tool: "flush_dns_cache",
  });

  // POST github-issue without token returns pre-filled GitHub web URL with device & RouterOS details
  const ghWeb = await request("/1/github-issue", "POST", {});
  expect(ghWeb.status).toBe(200);
  const ghJson = (await ghWeb.json()) as { mode: string; url: string };
  expect(ghJson.mode).toBe("web_url");
  expect(ghJson.url).toContain("https://github.com/mikrotik-mcp/mikrotik-mcp/issues/new");
  expect(decodeURIComponent(ghJson.url)).toContain("home-ax3");
  expect(decodeURIComponent(ghJson.url)).toContain("7.16.2");

  // POST merge
  const merged = await request("/1/merge", "POST", { sourceId: 2 });
  expect(merged.status).toBe(200);
  expect(store.merge).toHaveBeenCalledWith(1, 2);

  // POST batch update
  const batchUpdated = await request("/batch", "POST", {
    ids: [1, 2],
    action: "update",
    patch: { status: "resolved", sync_to_memory: false },
  });
  expect(batchUpdated.status).toBe(200);
  expect((await batchUpdated.json()).updatedCount).toBe(2);

  // POST batch github_issue
  const batchGh = await request("/batch", "POST", {
    ids: [1, 2],
    action: "github_issue",
  });
  expect(batchGh.status).toBe(200);
  const batchGhJson = (await batchGh.json()) as { mode: string; url: string; count: number };
  expect(batchGhJson.mode).toBe("web_url");
  expect(batchGhJson.count).toBe(2);
  expect(new URL(batchGhJson.url).searchParams.get("title")).toContain(
    "[Batch Feedback] 2 tool issues",
  );

  // POST batch merge
  const batchMerged = await request("/batch", "POST", {
    ids: [1, 2],
    action: "merge",
    target_id: 1,
  });
  expect(batchMerged.status).toBe(200);
  expect((await batchMerged.json()).mergedCount).toBe(1);

  // DELETE batch
  const deleted = await request("", "DELETE", { ids: [1] });
  expect(deleted.status).toBe(200);
  expect(store.deleteIssues).toHaveBeenCalledWith([1]);
});

test("config endpoint can toggle feedback store and rolls back on disk write failure", async () => {
  setConfig({ ...getConfig(), feedback: { enabled: false, dbPath: ":memory:" } });
  expect((await (await request("/config")).json()).enabled).toBe(false);
  expect((await request("")).status).toBe(503);

  expect((await request("/config", "POST", { enabled: true })).status).toBe(200);
  expect(atomicWrite).toHaveBeenCalledOnce();
  expect(installFeedbackStore).toHaveBeenCalledWith(store);
  expect(getConfig().feedback.enabled).toBe(true);
});
