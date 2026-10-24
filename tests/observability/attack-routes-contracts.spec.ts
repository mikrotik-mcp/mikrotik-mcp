import { beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { setConfig } from "../../src/core/runtime";
import { attackRoutes } from "../../src/observability/attack-routes";

const state = vi.hoisted(() => ({
  unavailable: false,
  incidents: [] as Record<string, unknown>[],
  responses: [] as Record<string, unknown>[],
  scan: 0,
}));
vi.mock("../../src/attack/store", () => ({
  attackStore: async () => {
    if (state.unavailable) throw new Error("history offline");
    return {
      listIncidents: () => state.incidents,
      getIncident: (id: string) => state.incidents.find((item) => item.id === id) ?? null,
      listResponses: () => state.responses,
      responseFor: (source: string) =>
        state.responses.find((item) => item.source === source) ?? null,
      countRecentBlocks: () => 0,
    };
  },
}));
vi.mock("../../src/attack/session", () => ({
  sweep: async () => {
    state.scan++;
    return { incidents: [], unavailable: [], devices: [], skipped: [] };
  },
  buildGuards: () => ({}),
  policyFromConfig: () => ({}),
}));
vi.mock("../../src/attack/respond", () => ({
  decide: () => ({ guard: true, reason: "protected management address" }),
  isPlan: () => false,
  neverBlockSet: () => new Set(["192.0.2.1"]),
  isNeverBlock: (ip: string) => ip === "192.0.2.1",
}));
vi.mock("../../src/attack/execute", () => ({ executePlan: vi.fn(), revokeBlock: vi.fn() }));
vi.mock("../../src/observability/geo", () => ({ getDeviceGeo: () => null }));
vi.mock("../../src/observability/health", () => ({ getDeviceStatus: () => ({ reachable: true }) }));

async function request(path: string, init?: RequestInit) {
  const req = new Request(`http://localhost${path}`, init);
  const response = await attackRoutes(req, new URL(req.url));
  if (!response && path.startsWith("/api/attacks"))
    throw new Error(`Unexpected unhandled attack route: ${path}`);
  return response;
}
const incident = {
  id: "incident-1",
  source: "198.51.100.20",
  devices: ["lab"],
  detectors: ["bruteforce"],
  firstTs: 1,
  lastTs: 2,
  severity: "high",
  narrative: "Failed logins",
  recommendations: ["Investigate"],
};
beforeEach(() => {
  state.unavailable = false;
  state.incidents = [incident];
  state.responses = [];
  state.scan = 0;
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { lab: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "lab",
    }),
  );
});

test("unrelated paths are ignored and storage outage returns 503", async () => {
  expect(await request("/api/other")).toBeNull();
  state.unavailable = true;
  expect((await request("/api/attacks"))?.status).toBe(503);
});

test("incident and source APIs correlate stored history without external geo lookup", async () => {
  const list = await request("/api/attacks");
  expect(((await list!.json()) as { incidents: { blocked: boolean }[] }).incidents[0].blocked).toBe(
    false,
  );
  state.incidents.push({ ...incident, id: "incident-2", lastTs: 3, devices: ["edge"] });
  const sources = await request("/api/attacks/sources");
  expect(
    ((await sources!.json()) as { sources: { incidents: number; devices: string[] }[] }).sources[0],
  ).toMatchObject({ incidents: 2, devices: ["edge", "lab"] });
  expect((await request("/api/attacks/incident-1"))?.status).toBe(200);
  expect((await request("/api/attacks/missing"))?.status).toBe(404);
});

test("config check identifies protected addresses and refuses ephemeral policy edits", async () => {
  const config = await request("/api/attacks/config?check=192.0.2.1");
  expect(((await config!.json()) as { check: { protected: boolean } }).check.protected).toBe(true);
  const edit = await request("/api/attacks/config", { method: "POST", body: "{}" });
  expect(edit?.status).toBe(501);
  expect((await request("/api/attacks/devices"))?.status).toBe(200);
});

test("scan is read-only and guarded response never applies a device mutation", async () => {
  const scan = await request("/api/attacks/scan", {
    method: "POST",
    body: JSON.stringify({ devices: ["lab"] }),
  });
  expect(scan?.status).toBe(200);
  expect(state.scan).toBe(1);
  const dismissed = await request("/api/attacks/incident-1/respond", {
    method: "POST",
    body: JSON.stringify({ action: "dismiss" }),
  });
  expect(await dismissed!.json()).toEqual({ dismissed: "incident-1" });
  const refused = await request("/api/attacks/incident-1/respond", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  expect(await refused!.json()).toMatchObject({ refused: true, guard: true });
  expect(
    (await request("/api/attacks/responses/198.51.100.20", { method: "DELETE" }))?.status,
  ).toBe(404);
});
