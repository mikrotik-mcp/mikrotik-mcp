import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { installAccessPolicy } from "../../src/core/access";
import { serviceContractRoutes } from "../../src/observability/service-contract-routes";
import { auditServiceContracts } from "../../src/service-contracts/audit";
import type { ServiceContract, ContractRun } from "../../src/service-contracts/model";
import { runServiceContract } from "../../src/service-contracts/run";

const local = vi.hoisted(() => ({
  definitions: new Map<string, ServiceContract>(),
  runs: [] as ContractRun[],
}));
vi.mock("../../src/service-contracts/store", () => ({
  contractStore: async () => ({
    get: (id: string) => local.definitions.get(id),
    list: (device: string) => [...local.definitions.values()].filter((c) => c.device === device),
    save: (c: ServiceContract) => local.definitions.set(c.id, c),
    history: (id: string) => local.runs.filter((r) => r.contractId === id),
    record: (r: ContractRun) => local.runs.push(r),
  }),
}));
const original = getConfig();
beforeEach(() => {
  local.definitions.clear();
  local.runs.length = 0;
  setConfig(
    MikrotikConfigSchema.parse({
      defaultDevice: "edge",
      devices: { edge: { host: "192.0.2.1" }, other: { host: "192.0.2.2" } },
      serviceProbes: {
        targets: { checkout: { kind: "dns", host: "192.0.2.10", addresses: ["192.0.2.10"] } },
      },
    }),
  );
  installAccessPolicy({ enabled: false, scope: {} });
});
afterEach(() => {
  setConfig(original);
  installAccessPolicy({ enabled: false, scope: {} });
});
async function request(path: string, body?: unknown): Promise<Response> {
  const req = new Request(
    `http://localhost/api/service-contracts${path}`,
    body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
  );
  return (await serviceContractRoutes(req, new URL(req.url)))!;
}
async function create(): Promise<ServiceContract> {
  return (
    await request("?device=edge", { name: "Checkout", checks: [{ target: "checkout" }] })
  ).json();
}
describe("service contract HTTP, history and scheduled enrollment", () => {
  test("create, list, run and history share owner checks and preserve results", async () => {
    const c = await create();
    expect(c.id).toBeTruthy();
    expect(local.runs).toHaveLength(0);
    expect((await (await request("?device=edge")).json()).contracts).toHaveLength(1);
    const run = await (await request("/run?device=edge", { id: c.id })).json();
    expect(run.status).toBe("pass");
    expect(run.vantage).toBe("mcp-host");
    expect((await (await request(`/history?device=edge&id=${c.id}`)).json()).runs).toHaveLength(1);
  });
  test("rejects unapproved aliases, cross-device history and invalid UUIDs", async () => {
    expect(
      (await request("?device=edge", { name: "Bad", checks: [{ target: "metadata" }] })).status,
    ).toBe(400);
    const c = await create();
    expect((await request(`/history?device=other&id=${c.id}`)).status).toBe(400);
    expect((await request("/run?device=edge", { id: "bad" })).status).toBe(400);
  });
  test("dashboard cannot bypass read-only mode or access scope", async () => {
    setConfig({ ...getConfig(), readOnly: true });
    expect(
      (await request("?device=edge", { name: "Bad", checks: [{ target: "checkout" }] })).status,
    ).toBe(400);
    installAccessPolicy({ enabled: true, scope: { devices: ["other"] } });
    expect((await request("?device=edge")).status).toBe(400);
  });
  test("new definitions are not scheduled automatically", async () => {
    await create();
    const findings = await auditServiceContracts("edge");
    expect(findings[0].id).toContain("unconfigured");
    expect(local.runs).toHaveLength(0);
  });
  test("explicit enrollment emits stable unknown findings after target removal", async () => {
    const c = await create();
    setConfig({
      ...getConfig(),
      serviceProbes: { ...getConfig().serviceProbes, targets: {}, scheduled: { edge: [c.id] } },
    });
    const first = await auditServiceContracts("edge");
    const second = await auditServiceContracts("edge");
    expect(first).toEqual(second);
    expect(first[0].severity).toBe("medium");
    expect(local.runs).toHaveLength(2);
  });
  test("denied service runs cannot launch an optional RouterOS export", async () => {
    const c = await create();
    c.packetSuiteId = "missing";
    local.definitions.set(c.id, c);
    // Deny the run before any optional RouterOS export could be attempted.
    installAccessPolicy({ enabled: true, scope: { denyTools: ["run_service_contract"] } });
    await expect(runServiceContract(c.id, "edge")).rejects.toThrow("denied");
    expect(local.runs).toHaveLength(0);
  });
});
