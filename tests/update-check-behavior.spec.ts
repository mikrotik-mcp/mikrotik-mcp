import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { VERSION } from "../src/version";

const state = vi.hoisted(() => ({ file: "", exists: false, writes: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) =>
      path.endsWith("update-check.json") ? state.exists : actual.existsSync(path),
    mkdirSync: (path: string, options?: { recursive?: boolean }) =>
      path.endsWith(".mikrotik-mcp") ? (state.exists = true) : actual.mkdirSync(path, options),
    readFileSync: (path: string, encoding: BufferEncoding) => {
      if (!path.endsWith("update-check.json")) return actual.readFileSync(path, encoding);
      if (!state.file) throw new Error("missing cache");
      return state.file;
    },
    writeFileSync: (path: string, body: string) => {
      if (!path.endsWith("update-check.json")) throw new Error("Unexpected write");
      state.file = body;
      state.writes.push(body);
    },
  };
});

const release = {
  tag_name: "v99.1.0",
  name: "Next",
  body: "changes",
  published_at: "2026-01-01",
  html_url: "https://example.test/release",
  prerelease: false,
  draft: false,
};
const fetchMock = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;

async function module() {
  return import("../src/core/update-check");
}

beforeEach(() => {
  vi.resetModules();
  state.file = "";
  state.exists = false;
  state.writes = [];
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("network release is normalized and reused from memory without another request", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(release)));
  const api = await module();
  const first = await api.fetchLatestRelease();
  expect(first).toMatchObject({
    version: "99.1.0",
    name: "Next",
    isNewer: true,
    currentVersion: VERSION,
  });
  expect(state.writes).toHaveLength(1);
  expect(await api.fetchLatestRelease()).toEqual(first);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toContain("/releases/latest");
});

test("file cache survives module reload and recalculates version relationship", async () => {
  state.file = JSON.stringify({
    data: {
      version: VERSION,
      name: "cached",
      body: "",
      publishedAt: "",
      url: "",
      isNewer: true,
      isAhead: true,
      currentVersion: "0.0.1",
    },
    fetchedAt: Date.now(),
  });
  const api = await module();
  expect(api.loadFileCacheSync()).toMatchObject({ isNewer: true });
  expect(await api.fetchLatestRelease()).toMatchObject({
    isNewer: false,
    isAhead: false,
    currentVersion: VERSION,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("failed update check falls back to stale disk data and never throws", async () => {
  state.file = JSON.stringify({
    data: {
      version: "99.1.0",
      name: "old",
      body: "",
      publishedAt: "",
      url: "",
      isNewer: false,
      isAhead: false,
      currentVersion: "99.1.0",
    },
    fetchedAt: 1,
  });
  fetchMock.mockRejectedValue(new Error("offline"));
  const api = await module();
  expect(await api.checkForUpdate()).toMatchObject({
    fromCache: true,
    release: { isNewer: true, currentVersion: VERSION },
  });
  state.file = "bad json";
  vi.resetModules();
  expect(await (await module()).checkForUpdate()).toMatchObject({
    release: null,
    error: "offline",
  });
});

test("HTTP errors, invalid caches and release list filtering are explicit", async () => {
  state.file = JSON.stringify({ data: { version: "bad" }, fetchedAt: "not a number" });
  fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  const api = await module();
  await expect(api.fetchLatestRelease()).rejects.toThrow("GitHub API 503");
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify([
        { ...release, tag_name: `v${VERSION}`, name: "", body: "" },
        { ...release, tag_name: "v99.2.0", prerelease: true },
        { ...release, tag_name: "v100.0.0", draft: true },
      ]),
    ),
  );
  const list = await api.fetchAllReleases();
  expect(list.releases).toHaveLength(2);
  expect(list.latestVersion).toBe(VERSION);
  expect(list.releases.find((entry) => entry.version === VERSION)).toMatchObject({
    relation: "current",
    name: `v${VERSION}`,
  });
  expect(await api.fetchAllReleases()).toEqual(list);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("version ordering and freshness boundaries classify patch, minor and major lag", async () => {
  const api = await module();
  expect(api.compareVersions("v6.2", "6.2.0")).toBe(0);
  expect(api.compareVersions("6.2.1", "6.2.2")).toBeLessThan(0);
  expect(api.assessFreshness("6.2.0", "6.2.1")).toBe("fresh");
  expect(api.assessFreshness("6.2.0", "6.2.2")).toBe("aging");
  expect(api.assessFreshness("6.2.0", "6.3.0")).toBe("aging");
  expect(api.assessFreshness("6.2.0", "6.4.0")).toBe("stale");
  expect(api.assessFreshness("6.2.0", "7.0.0")).toBe("ancient");
  expect(api.updateSummaryLine({ version: VERSION, isNewer: false } as never)).toBeNull();
  expect(api.updateSummaryLine({ version: "99.1.0", isNewer: true } as never)).toContain(
    "check_server_pulse",
  );
});
