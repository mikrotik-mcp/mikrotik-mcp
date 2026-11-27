import { beforeEach, expect, test, vi } from "vite-plus/test";
import { webProxyRoutes } from "../../src/observability/web-proxy-routes";
import { executeMikrotikCommand } from "../../src/core/connector";
import { assertDeviceAccess } from "../../src/core/scoped-access";
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
vi.mock("../../src/core/scoped-access", () => ({ assertDeviceAccess: vi.fn() }));
vi.mock("../../src/core/runtime", async (original) => ({
  ...(await original<typeof import("../../src/core/runtime")>()),
  resolveDeviceName: (name: string) => name,
}));
vi.mock("../../src/observability/recorder", () => ({ recordToolCall: vi.fn() }));
const run = vi.mocked(executeMikrotikCommand);
beforeEach(() => vi.resetAllMocks());
async function request(path: string, body?: unknown, origin?: string) {
  const url = new URL(`/api/web-proxy/${path}`, "http://localhost");
  const req = new Request(
    url,
    body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body), headers: origin ? { origin } : {} },
  );
  return (await webProxyRoutes(req, url))!;
}
test("writes only the requested settings on the explicitly selected router", async () => {
  run.mockResolvedValueOnce("").mockResolvedValueOnce("enabled: yes\nport: 3128");
  expect((await request("settings?device=home", { port: 3128 })).status).toBe(200);
  expect(run).toHaveBeenCalledWith(
    "/ip proxy set port=3128",
    expect.objectContaining({ device: "home", risk: "DANGEROUS" }),
  );
});
test("lists stable IDs and match conditions in policy order", async () => {
  run.mockResolvedValueOnce(
    JSON.stringify([
      { ".id": "*B", action: "deny", "dst-host": "*.example.net", disabled: true },
      { ".id": "*1", action: "allow" },
    ]),
  );
  const res = await request("rules?device=r2");
  expect(await res.json()).toMatchObject({
    rules: [
      { id: "*B", host: "*.example.net", disabled: true },
      { id: "*1", action: "allow" },
    ],
  });
  expect(run).toHaveBeenCalledTimes(1);
});
test("rejects an unconfirmed enable, unstable rule IDs and cross-origin writes", async () => {
  expect((await request("settings?device=home", { enabled: true })).status).toBe(400);
  expect((await request("remove?device=home", { rule_id: "0" })).status).toBe(400);
  expect(
    (await request("settings?device=home", { port: 8888 }, "https://elsewhere.example")).status,
  ).toBe(403);
  expect((await request("settings", { port: 3128 })).status).toBe(400);
  expect((await request("history?device=home&range=unknown")).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});
test("honors access restrictions on both writes and local historical reads", async () => {
  vi.mocked(assertDeviceAccess).mockImplementation(() => {
    throw new Error("denied");
  });
  expect((await request("add?device=home", { action: "allow" })).status).toBe(403);
  expect((await request("history?device=home")).status).toBe(403);
  expect(run).not.toHaveBeenCalled();
});
