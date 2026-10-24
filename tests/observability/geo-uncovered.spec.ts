import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  getDeviceGeo,
  ipGeoRoute,
  refreshGeo,
  sourceIpLiteral,
  startGeoLookups,
  stopGeoLookups,
} from "../../src/observability/geo";

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), lookup: vi.fn() }));
vi.mock("../../src/core/runtime", () => ({ getConfig: mocks.getConfig }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

function route(path: string, method = "GET") {
  const url = new URL(path, "http://localhost");
  return ipGeoRoute(new Request(url, { method }), url);
}

afterEach(() => {
  stopGeoLookups();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("geo uncovered paths", () => {
  test("only literal IP endpoints are accepted", async () => {
    expect(sourceIpLiteral(" [2606:4700:4700::1111]:443 ")).toBe("2606:4700:4700::1111");
    expect(sourceIpLiteral("8.8.8.8:65536")).toBeNull();
    expect(sourceIpLiteral("router.example:443")).toBeNull();
    expect(route("/api/other")).toBeNull();
    expect(route("/api/ip-network", "POST")?.status).toBe(405);
    expect(route("/api/ip-network")?.status).toBe(400);
    expect(route(`/api/ip-network?ip=${"x".repeat(129)}`)?.status).toBe(400);
    expect(await route("/api/ip-network?ip=192.168.1.1")?.json()).toEqual({ status: "private" });
  });

  test("refresh skips MAC and private hosts, resolves public hostnames, and uses cache", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ country: "Germany", country_code: "DE", city: "Berlin" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mocks.getConfig.mockReturnValue({
      devices: {
        "mac-only": { mac: "00:11:22:33:44:55" },
        private: { host: "10.0.0.1" },
        public: { host: "geo-uncovered.example" },
      },
    });
    mocks.lookup.mockResolvedValue({ address: "8.8.4.4", family: 4 });
    await refreshGeo();
    expect(getDeviceGeo("mac-only")).toBeNull();
    expect(getDeviceGeo("private")).toBeNull();
    expect(getDeviceGeo("public")).toMatchObject({ countryCode: "de", city: "Berlin" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await refreshGeo();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("failed DNS and both failed providers leave no cached country", async () => {
    mocks.getConfig.mockReturnValue({
      devices: {
        "dns-fails": { host: "dns-fails.example" },
        "provider-fails": { host: "8.8.8.8" },
      },
    });
    mocks.lookup.mockRejectedValue(new Error("NXDOMAIN"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await refreshGeo();
    expect(getDeviceGeo("dns-fails")).toBeNull();
    expect(getDeviceGeo("provider-fails")).toBeNull();
  });

  test("periodic lookup can be stopped", async () => {
    vi.useFakeTimers();
    mocks.getConfig.mockReturnValue({ devices: {} });
    startGeoLookups();
    stopGeoLookups();
    await vi.runOnlyPendingTimersAsync();
    expect(mocks.getConfig).toHaveBeenCalledTimes(1);
  });
});
