import { beforeEach, expect, test, vi } from "vite-plus/test";
import { policyRoutes } from "../../src/observability/policy-routes";

const state = vi.hoisted(() => ({
  rules: [] as object[],
  files: [] as object[],
  resultsError: "",
}));
const command = vi.hoisted(() => vi.fn());
const results = vi.hoisted(() => vi.fn());
const recorded = vi.hoisted(() => vi.fn());
vi.mock("../../src/tools/policy", () => ({
  currentPolicySet: () => ({
    files: state.files,
    policies: state.rules,
    duplicateIds: [],
    emptyPatterns: [],
  }),
}));
vi.mock("../../src/core/runtime", () => ({
  getConfig: () => ({
    policy: { paths: ["policy.yaml"] },
    devices: { enabled: { host: "192.0.2.1" }, disabled: { host: "192.0.2.2", disabled: true } },
  }),
}));
vi.mock("../../src/core/context", () => ({
  createContext: (_: unknown, device: string) => ({ device }),
}));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../../src/policy/results", () => ({
  policyResults: results,
  recordPolicyResult: recorded,
}));
vi.mock("../../src/policy/session", () => ({ rememberReport: vi.fn() }));
vi.mock("../../src/policy/evaluate", () => ({
  evaluatePolicies: (_rules: object[], _config: unknown, opts: { device: string }) => ({
    device: opts.device,
    summary: { score: 100 },
    findings: [],
  }),
}));
vi.mock("../../src/policy/report", () => ({ renderReport: () => "# Report" }));

async function request(path: string, data?: unknown, raw?: string) {
  const url = new URL(`http://localhost${path}`);
  return policyRoutes(
    new Request(
      url,
      data === undefined && raw === undefined
        ? {}
        : {
            method: "POST",
            body: raw ?? JSON.stringify(data),
            headers: { "content-type": "application/json" },
          },
    ),
    url,
  );
}
beforeEach(() => {
  state.rules = [];
  state.files = [];
  state.resultsError = "";
  vi.clearAllMocks();
  results.mockResolvedValue([{ device: "enabled" }]);
  command.mockResolvedValue("/ip ssh\nset strong-crypto=yes");
});

test("catalog exposes complete rule files and configured paths", async () => {
  state.rules = [{ id: "secure" }];
  state.files = [
    { path: "policy.yaml", name: "Security", ok: true, issues: [], policies: state.rules },
  ];
  expect(await (await request("/api/policies"))?.json()).toMatchObject({
    ruleCount: 1,
    files: [{ policies: [{ id: "secure" }] }],
    paths: ["policy.yaml"],
  });
});
test("results forward filters and recover from storage errors", async () => {
  expect(await (await request("/api/policies/results?device=enabled&limit=2"))?.json()).toEqual({
    results: [{ device: "enabled" }],
  });
  expect(results).toHaveBeenCalledWith("enabled", 2);
  results.mockRejectedValueOnce(new Error("db locked"));
  expect(await (await request("/api/policies/results"))?.json()).toEqual({
    results: [],
    error: "db locked",
  });
});
test("validation handles malformed and meaningful policy text", async () => {
  expect((await request("/api/policies/validate", undefined, "{"))?.status).toBe(400);
  const valid = JSON.stringify({
    version: 1,
    policies: [
      {
        id: "ssh-secure",
        match: { section: "/ip ssh" },
        assert: { field: "strong-crypto", equals: "yes" },
      },
    ],
  });
  expect(await (await request("/api/policies/validate", { content: valid }))?.json()).toMatchObject(
    { ok: true, issues: [], file: { policies: [{ id: "ssh-secure" }] } },
  );
  const invalid = await (
    await request("/api/policies/validate", { content: "not valid JSON" })
  )?.json();
  expect(invalid).toMatchObject({ ok: false, issues: [{ path: "(root)" }] });
});
test("fleet run skips disabled devices and persists a successful report", async () => {
  state.rules = [{ id: "secure" }];
  const response = await request("/api/policies/run", {});
  expect(await response?.json()).toMatchObject({
    reports: [{ device: "enabled", summary: { score: 100 }, markdown: "# Report" }],
  });
  expect(command).toHaveBeenCalledExactlyOnceWith("/export terse", { device: "enabled" });
  expect(recorded).toHaveBeenCalledOnce();
});
test("a failed device does not prevent the rest of a fleet sweep", async () => {
  state.rules = [{ id: "secure" }];
  command
    .mockRejectedValueOnce(new Error("unreachable"))
    .mockResolvedValueOnce("/ip ssh\nset strong-crypto=yes");
  const response = await request("/api/policies/run", { devices: ["bad", "good"] });
  expect(await response?.json()).toMatchObject({
    reports: [
      { device: "bad", error: "unreachable" },
      { device: "good", summary: { score: 100 } },
    ],
  });
  expect(recorded).toHaveBeenCalledOnce();
});
test("empty rules and empty exports give useful responses", async () => {
  expect(await (await request("/api/policies/run", {}))?.json()).toEqual({
    error: "no policy rules are loaded",
    reports: [],
  });
  state.rules = [{ id: "secure" }];
  command.mockResolvedValueOnce(" ");
  expect(await (await request("/api/policies/run", { devices: ["enabled"] }))?.json()).toEqual({
    reports: [{ device: "enabled", error: "empty export" }],
  });
  expect(recorded).not.toHaveBeenCalled();
  expect(await request("/api/other")).toBeNull();
  expect((await request("/api/policies/nope"))?.status).toBe(404);
});
