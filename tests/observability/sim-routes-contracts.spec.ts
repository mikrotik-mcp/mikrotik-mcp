import { beforeEach, expect, test, vi } from "vite-plus/test";
import { simRoutes } from "../../src/observability/sim-routes";

const state = vi.hoisted(() => ({ suites: new Map<string, Record<string, unknown>>() }));
const command = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../../src/sim/suites", () => ({
  listSuites: async () => [...state.suites.values()],
  saveSuite: async (input: { id?: string; name: string; packets: unknown[] }) => {
    const saved = { ...input, id: input.id ?? "suite-1" };
    state.suites.set(saved.id, saved);
    return saved;
  },
  getSuite: async (id: string) => state.suites.get(id) ?? null,
}));
vi.mock("../../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({
    get: (id: string) =>
      id === "snap-1" ? { id, body: "/ip firewall filter\nadd chain=forward action=drop" } : null,
  }),
}));

const configText = "/ip firewall filter\nadd chain=forward action=drop";
const packet = {
  chain: "forward",
  srcAddress: "192.0.2.10",
  dstAddress: "198.51.100.20",
  protocol: "tcp",
  dstPort: 443,
};
async function request(path: string, init?: RequestInit) {
  const req = new Request(`http://localhost${path}`, init);
  const response = await simRoutes(req, new URL(req.url));
  if (!response && path.startsWith("/api/sim"))
    throw new Error(`Unexpected unhandled simulator route: ${path}`);
  return response;
}
function post(data: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(data) };
}
beforeEach(() => {
  state.suites.clear();
  command.mockReset().mockResolvedValue(configText);
});

test("unrelated request is ignored and invalid suite/verification bodies are rejected", async () => {
  expect(await request("/api/other")).toBeNull();
  expect((await request("/api/sim/suites", post({ name: "empty", packets: [] })))?.status).toBe(
    400,
  );
  expect((await request("/api/sim/verify", post({})))?.status).toBe(400);
});

test("packet trace and before/after comparison use supplied config without router I/O", async () => {
  const traced = await request("/api/sim/packet", post({ configText, packet }));
  expect(((await traced!.json()) as { source: string; result: unknown }).source).toBe(
    "supplied text",
  );
  const missingChange = await request("/api/sim/change", post({ configText, packet }));
  expect(missingChange?.status).toBe(400);
  const compared = await request(
    "/api/sim/change",
    post({ configText, packet, changes: "/ip firewall filter\nadd chain=forward action=accept" }),
  );
  expect((await compared!.json()) as { before: unknown; after: unknown }).toMatchObject({
    before: expect.any(Object),
    after: expect.any(Object),
  });
  expect(command).not.toHaveBeenCalled();
});

test("saved suite traces a snapshot and preserves UNKNOWN as non-pass", async () => {
  expect((await request("/api/sim/suite/missing/run", post({ configText })))?.status).toBe(404);
  const saved = await request(
    "/api/sim/suites",
    post({ name: "traffic", packets: [{ name: "web", packet, expect: "UNKNOWN" }] }),
  );
  expect(saved?.status).toBe(200);
  expect(
    ((await (await request("/api/sim/suites"))!.json()) as { suites: unknown[] }).suites,
  ).toHaveLength(1);
  const run = await request("/api/sim/suite/suite-1/run", post({ snapshotId: "snap-1" }));
  expect(await run!.json()).toMatchObject({ total: 1, source: "snapshot snap-1" });
});

test("missing snapshot and unreachable-rule analysis retain evidence provenance", async () => {
  const absent = await request("/api/sim/packet", post({ snapshotId: "missing", packet }));
  expect(absent?.status).toBe(400);
  const reachability = await request("/api/sim/reachability?snapshot=snap-1");
  expect(((await reachability!.json()) as { source: string; rules: unknown[] }).source).toBe(
    "snapshot snap-1",
  );
  expect(command).not.toHaveBeenCalled();
});

test("live simulator fallback reads only the export and reports an unreadable router", async () => {
  const traced = await request("/api/sim/packet", post({ device: "default", packet }));
  expect(((await traced!.json()) as { source: string }).source).toContain("live config");
  expect(command.mock.calls.map(([text]) => text)).toEqual(["/export terse"]);
  command.mockResolvedValueOnce("failure: unavailable");
  const failed = await request("/api/sim/packet", post({ device: "default", packet }));
  expect(failed?.status).toBe(400);
  expect(((await failed!.json()) as { error: string }).error).toContain("could not read");
});
