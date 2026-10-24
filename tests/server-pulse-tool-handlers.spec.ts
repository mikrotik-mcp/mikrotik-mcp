import { beforeEach, expect, test, vi } from "vite-plus/test";
import { serverPulseTools } from "../src/tools/server-pulse";
import { VERSION } from "../src/version";

const mocks = vi.hoisted(() => ({ check: vi.fn(), freshness: vi.fn() }));
vi.mock("../src/core/update-check", () => ({
  checkForUpdate: mocks.check,
  assessFreshness: mocks.freshness,
}));

const release = {
  version: "99.1.0",
  name: "Future",
  body: "Fixes and features",
  publishedAt: new Date().toISOString(),
  url: "https://example.test/release",
  isNewer: true,
  isAhead: false,
  currentVersion: VERSION,
};
async function call(args: Record<string, unknown> = {}) {
  return serverPulseTools[0].handler(args as never, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.freshness.mockReturnValue("ancient");
  mocks.check.mockResolvedValue({ release, checkedAt: Date.now(), fromCache: false });
});

test("new release reports notes, update commands, and server identity without router I/O", async () => {
  const output = await call();
  expect(output).toContain(`MikroTik MCP v${VERSION}`);
  expect(output).toContain("CRITICAL UPDATE NEEDED");
  expect(output).toContain("Fixes and features");
  expect(output).toContain("bun add -g @usex/mikrotik-mcp@latest");
  expect(output).toContain("Published:  today");
  expect(mocks.freshness).toHaveBeenCalledWith(VERSION, "99.1.0");
});

test("compact check suppresses notes but still offers upgrade commands", async () => {
  const output = await call({ include_release_notes: false });
  expect(output).not.toContain("Fixes and features");
  expect(output).toContain("UPGRADE");
});

test("current release omits upgrade and uses fresh label", async () => {
  mocks.freshness.mockReturnValue("fresh");
  mocks.check.mockResolvedValue({
    release: { ...release, version: VERSION, isNewer: false },
    fromCache: false,
  });
  const output = await call();
  expect(output).toContain("UP TO DATE");
  expect(output).toContain("You are running the latest version.");
  expect(output).toContain("RELEASE NOTES");
  expect(output).not.toContain("bun add -g");
});

test("ahead-of-release builds do not recommend downgrading", async () => {
  mocks.check.mockResolvedValue({
    release: { ...release, version: "1.0.0", isNewer: false, isAhead: true },
    fromCache: false,
  });
  const output = await call();
  expect(output).toContain("AHEAD OF LATEST RELEASE");
  expect(output).toContain("DEV BUILD");
  expect(output).not.toContain("UPGRADE");
});

test("unavailable update service describes the error without failing the pulse", async () => {
  mocks.check.mockResolvedValue({ release: null, error: "offline", fromCache: false });
  expect(await call()).toContain("Could not check for updates: offline");
  mocks.check.mockResolvedValue({ release: null, fromCache: true });
  expect(await call()).toContain("(showing cached data)");
});
