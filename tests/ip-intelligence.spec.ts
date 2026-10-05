import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

const fetchMock = vi.fn();
let lookup: typeof import("../src/core/ip-intelligence").lookupIpIntelligence;
beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  lookup = (await import("../src/core/ip-intelligence")).lookupIpIntelligence;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const payload = {
  ip: "1.1.1.1",
  isp: { asn: "AS13335", org: "Example" },
  risk: { is_vpn: false, risk_score: 0 },
  future: { unknown: null, list: [1, "new"], empty: {} },
};

test("retains complete independent payloads and caches/coalesces duplicate lookups", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    Response.json(url.includes("ipquery") ? payload : { ...payload, extra: "ipkit" }),
  );
  const [report, joined] = await Promise.all([
    lookup({ ip: "1.1.1.1" }),
    lookup({ ip: "1.1.1.1" }),
  ]);
  expect(report.providers.ipquery.data).toEqual(payload);
  expect(report.providers.ipkit.data).toEqual({ ...payload, extra: "ipkit" });
  expect(joined).toEqual({ ...report, cached: true });
  expect((await lookup({ ip: "1.1.1.1" })).cached).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "https://api.ipquery.io/1.1.1.1",
    "https://ipkit.ir/1.1.1.1",
  ]);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    headers: { accept: "application/json" },
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
  expect(report.expiresAt - report.lookedUpAt).toBeGreaterThanOrEqual(300_000);
});

test("private and special addresses stay local; input cannot select arbitrary destinations", async () => {
  for (const ip of [
    "10.0.0.1",
    "127.0.0.1",
    "100.64.1.1",
    "192.168.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.1.1.1",
    "224.0.0.1",
  ]) {
    const report = await lookup({ ip });
    expect(report.public).toBe(false);
    expect(report.providers.ipquery.status).toBe("skipped");
    expect(report.providers.ipkit.status).toBe("skipped");
  }
  for (const ip of [
    "localhost",
    "https://1.1.1.1",
    "1.1.1.1/24",
    "1.1.1.1:443",
    "1.1.1.1; /system reset",
    "999.1.1.1",
  ])
    await expect(lookup({ ip })).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("canonical IPv6 URLs, expiry and shorter partial-failure cache", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  fetchMock
    .mockResolvedValueOnce(new Response("bad", { status: 429 }))
    .mockResolvedValueOnce(Response.json(payload));
  const report = await lookup({ ip: "2606:4700:0000:0000:0000:0000:0000:1111" });
  expect(fetchMock.mock.calls[0][0]).toBe("https://api.ipquery.io/2606%3A4700%3A%3A1111");
  expect(report.providers.ipquery).toMatchObject({
    status: "error",
    error: "Provider returned HTTP 429",
  });
  expect(report.providers.ipkit.data).toEqual(payload);
  expect(report.expiresAt).toBe(31_000);
  clock.mockReturnValue(30_000);
  expect((await lookup({ ip: "2606:4700::1111" })).cached).toBe(true);
  clock.mockReturnValue(31_000);
  fetchMock.mockImplementation(async () => Response.json(payload));
  expect((await lookup({ ip: "2606:4700::1111" })).cached).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("bounds payloads, rejects non-object JSON and sanitizes arbitrary errors", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response("x".repeat(65_537)))
    .mockResolvedValueOnce(Response.json([]));
  const report = await lookup({ ip: "8.8.8.8" });
  expect(report.providers.ipquery.error).toBe("Provider response exceeded 64 KiB");
  expect(report.providers.ipkit.error).toBe("Provider did not return a JSON object");
  fetchMock.mockRejectedValue(new Error("secret: user-controlled provider HTML"));
  const failed = await lookup({ ip: "9.9.9.9" });
  expect(failed.providers.ipquery.error).not.toContain("secret");
  expect(failed.providers.ipkit.status).toBe("error");
});

test("limits distinct concurrent lookups but still joins duplicate requests", async () => {
  const finish: ((response: Response) => void)[] = [];
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => finish.push(resolve)));
  const pending = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "8.8.4.4"].map((ip) => lookup({ ip }));
  await expect(lookup({ ip: "1.0.0.1" })).rejects.toThrow("capacity");
  const joined = lookup({ ip: "1.1.1.1" });
  expect(fetchMock).toHaveBeenCalledTimes(8);
  for (const resolve of finish) resolve(Response.json(payload));
  await Promise.all(pending);
  expect((await joined).cached).toBe(true);
});

test("MCP tool is host-only, read-only and discloses external requests", async () => {
  const { ipIntelligenceTools } = await import("../src/tools/ip-intelligence");
  const tool = ipIntelligenceTools[0];
  expect(tool.name).toBe("lookup_ip_intelligence");
  expect(tool.noDevice).toBe(true);
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  fetchMock.mockImplementation(async () => Response.json(payload));
  const output = await tool.handler({ ip: "1.1.1.1" }, { info: vi.fn(), error: vi.fn() });
  expect(JSON.parse(output as string).providers.ipquery.data).toEqual(payload);
});
test("full successes expire after five minutes and cache evicts old entries at its limit", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  fetchMock.mockImplementation(async () => Response.json(payload));
  await lookup({ ip: "1.1.1.1" });
  clock.mockReturnValue(301_000);
  expect((await lookup({ ip: "1.1.1.1" })).cached).toBe(false);
  for (let index = 0; index < 256; index++) await lookup({ ip: `8.8.4.${index}` });
  expect((await lookup({ ip: "1.1.1.1" })).cached).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(518);
});

test("dashboard lookup validates method, origin, body limit and literal before fetching", async () => {
  const { ipIntelligenceRoutes } = await import("../src/observability/ip-intelligence-routes");
  const url = new URL("http://dashboard/api/ip-intelligence");
  const request = (body: string, headers = {}) =>
    ipIntelligenceRoutes(new Request(url, { method: "POST", headers, body }), url);
  expect((await ipIntelligenceRoutes(new Request(url), url))?.status).toBe(405);
  expect((await request("{}", { origin: "https://external.test" }))?.status).toBe(403);
  expect((await request("x".repeat(513)))?.status).toBe(413);
  expect((await request("bad"))?.status).toBe(400);
  expect((await request('{"ip":"localhost"}'))?.status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockImplementation(async () => Response.json(payload));
  const response = await request('{"ip":"1.1.1.1"}');
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toMatchObject({ providers: { ipkit: { data: payload } } });
});
