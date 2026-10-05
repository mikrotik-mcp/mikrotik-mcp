import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

const fetchMock = vi.fn();
let geo: typeof import("../src/observability/geo");
beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  geo = await import("../src/observability/geo");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const response = (code = "NL") => Response.json({ country: "Netherlands", country_code: code });

test("IP network endpoint validates literals, rejects writes and never geolocates private addresses", async () => {
  const request = (ip: string, method = "GET") => {
    const url = new URL(`http://dashboard/api/ip-network?ip=${encodeURIComponent(ip)}`);
    return geo.ipGeoRoute(new Request(url, { method }), url)!;
  };
  expect(
    geo.ipGeoRoute(new Request("http://dashboard/other"), new URL("http://dashboard/other")),
  ).toBeNull();
  expect(request("8.8.8.8", "POST").status).toBe(405);
  for (const value of ["localhost", "https://8.8.8.8", "8.8.8.8/24", "999.1.1.1", "x".repeat(129)])
    expect(request(value).status).toBe(400);
  expect(await request("10.0.0.1").json()).toEqual({ status: "private" });
  expect(await request("fd00::1").json()).toEqual({ status: "private" });
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValue(
    Response.json({ country_code: "NL", asn: 13335, asn_organization: "Example Network" }),
  );
  expect(await request("1.1.1.1").json()).toEqual({ status: "pending" });
  await vi.waitFor(() => expect(geo.getIpGeo("1.1.1.1").status).toBe("resolved"));
  const result = request("1.1.1.1");
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toMatchObject({ asn: "AS13335", asnOrganization: "Example Network" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("parses IPv4/IPv6 literals and endpoints without resolving hostnames or paths", () => {
  expect(geo.sourceIpLiteral("8.8.8.8:443")).toBe("8.8.8.8");
  expect(geo.sourceIpLiteral("[2606:4700::1111]:443")).toBe("2606:4700::1111");
  expect(geo.sourceIpLiteral("2606:4700::1111")).toBe("2606:4700::1111");
  for (const value of [
    "localhost",
    "https://8.8.8.8",
    "8.8.8.8/path",
    "8.8.8.8:99999",
    "999.1.1.1",
    "",
  ]) {
    expect(geo.sourceIpLiteral(value)).toBeNull();
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("private and invalid sources never leave the MCP host", () => {
  for (const ip of [
    "10.8.0.2",
    "192.168.1.2:1194",
    "[fe80::1]:1194",
    "::ffff:10.1.2.3",
    "::1",
    "fd00::1",
  ]) {
    expect(geo.getIpGeo(ip)).toEqual({ status: "private" });
  }
  expect(geo.getIpGeo("unknown")).toEqual({ status: "unavailable" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("returns immediately, coalesces duplicate IPs and caches countries for a day", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  expect(geo.getIpGeo("8.8.8.8:1194")).toEqual({ status: "pending" });
  expect(geo.getIpGeo("8.8.8.8:2200")).toEqual({ status: "pending" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  finish(response());
  await vi.waitFor(() => expect(geo.getIpGeo("8.8.8.8").status).toBe("resolved"));
  expect(geo.getIpGeo("8.8.8.8")).toEqual({
    status: "resolved",
    country: "Netherlands",
    countryCode: "nl",
  });
  clock.mockReturnValue(1000 + 23 * 60 * 60_000);
  expect(geo.getIpGeo("8.8.8.8").status).toBe("resolved");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValue(response());
  clock.mockReturnValue(1000 + 24 * 60 * 60_000 + 1);
  expect(geo.getIpGeo("8.8.8.8").status).toBe("pending");
  await vi.waitFor(() => expect(geo.getIpGeo("8.8.8.8").status).toBe("resolved"));
});

test("fallback failures settle as unavailable and are negatively cached for five minutes", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  fetchMock.mockRejectedValue(new Error("offline"));
  expect(geo.getIpGeo("8.8.8.8").status).toBe("pending");
  await vi.waitFor(() => expect(geo.getIpGeo("8.8.8.8").status).toBe("unavailable"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(1000 + 4 * 60_000);
  geo.getIpGeo("8.8.8.8");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(1000 + 5 * 60_000 + 1);
  fetchMock.mockResolvedValue(response());
  expect(geo.getIpGeo("8.8.8.8").status).toBe("pending");
  await vi.waitFor(() => expect(geo.getIpGeo("8.8.8.8").status).toBe("resolved"));
});

test("uses the existing fallback provider and rejects invalid country codes", async () => {
  fetchMock
    .mockRejectedValueOnce(new Error("primary offline"))
    .mockResolvedValueOnce(Response.json({ location: { country: "Germany", country_code: "DE" } }));
  geo.getIpGeo("1.1.1.1");
  await vi.waitFor(() =>
    expect(geo.getIpGeo("1.1.1.1")).toEqual({
      status: "resolved",
      country: "Germany",
      countryCode: "de",
    }),
  );
  expect(fetchMock.mock.calls[1][0]).toBe("https://api.ipquery.io/1.1.1.1");
  fetchMock.mockResolvedValue(response("../../bad"));
  geo.getIpGeo("8.8.8.8");
  await vi.waitFor(() => expect(geo.getIpGeo("8.8.8.8").status).toBe("unavailable"));
});

test("bounds concurrent work and the pending queue even with many source IPs", async () => {
  const finishes: (() => void)[] = [];
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finishes.push(() => resolve(response()));
      }),
  );
  for (let i = 0; i < 1024; i++) geo.getIpGeo(`8.8.${Math.floor(i / 256)}.${i % 256}`);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(geo.getIpGeo("1.1.1.1")).toEqual({ status: "unavailable" });
  finishes.splice(0).forEach((finish) => finish());
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
  // Drain all work with mocked responses so no asynchronous lookup escapes this test.
  fetchMock.mockImplementation(() => Promise.resolve(response()));
  finishes.splice(0).forEach((finish) => finish());
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1024));
});

test("retains primary-provider ASN organization in the shared country cache without extra requests", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  fetchMock.mockResolvedValue(
    Response.json({
      country: "Iran",
      country_code: "IR",
      asn: 44244,
      asn_organization: "Iran Cell Service and Communication Company",
    }),
  );
  expect(geo.getIpGeo("5.112.105.66:1194")).toEqual({ status: "pending" });
  await vi.waitFor(() => expect(geo.getIpGeo("5.112.105.66").status).toBe("resolved"));
  expect(geo.getIpGeo("5.112.105.66")).toEqual({
    status: "resolved",
    country: "Iran",
    countryCode: "ir",
    asn: "AS44244",
    asnOrganization: "Iran Cell Service and Communication Company",
  });
  clock.mockReturnValue(1000 + 23 * 60 * 60_000);
  expect(geo.getIpGeo("5.112.105.66:2200").asn).toBe("AS44244");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("reads fallback-provider nested network fields and normalizes AS-prefixed numbers", async () => {
  fetchMock.mockRejectedValueOnce(new Error("primary offline")).mockResolvedValueOnce(
    Response.json({
      location: { country: "Iran", country_code: "IR" },
      isp: { asn: " as44244 ", org: " Iran Cell Service and Communication Company " },
    }),
  );
  geo.getIpGeo("5.112.105.66");
  await vi.waitFor(() => expect(geo.getIpGeo("5.112.105.66").status).toBe("resolved"));
  expect(geo.getIpGeo("5.112.105.66")).toMatchObject({
    asn: "AS44244",
    asnOrganization: "Iran Cell Service and Communication Company",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each([undefined, null, "", "AS0", -1, 1.2, 4294967296, "ASfoo", [44244], { value: 44244 }])(
  "malformed or missing ASN %j never hides the country or becomes a fabricated network",
  async (asn) => {
    fetchMock.mockResolvedValue(
      Response.json({ country: "Iran", country_code: "IR", asn, asn_organization: null }),
    );
    geo.getIpGeo("5.112.105.66");
    await vi.waitFor(() => expect(geo.getIpGeo("5.112.105.66").status).toBe("resolved"));
    expect(geo.getIpGeo("5.112.105.66")).toEqual({
      status: "resolved",
      country: "Iran",
      countryCode: "ir",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

test.each([null, {}, [], 123, " \n\t "])(
  "ignores non-text or blank organizations: %j",
  async (org) => {
    fetchMock.mockResolvedValue(
      Response.json({ country_code: "IR", asn: "AS44244", asn_organization: org }),
    );
    geo.getIpGeo("5.112.105.66");
    await vi.waitFor(() => expect(geo.getIpGeo("5.112.105.66").status).toBe("resolved"));
    expect(geo.getIpGeo("5.112.105.66").asn).toBe("AS44244");
    expect(geo.getIpGeo("5.112.105.66").asnOrganization).toBeUndefined();
  },
);

test("bounds organization length and removes provider control characters", async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      country_code: "IR",
      asn_organization: `Example\n\tNetwork ${"x".repeat(500)}`,
    }),
  );
  geo.getIpGeo("5.112.105.66");
  await vi.waitFor(() => expect(geo.getIpGeo("5.112.105.66").status).toBe("resolved"));
  const text = geo.getIpGeo("5.112.105.66").asnOrganization!;
  expect(text).toHaveLength(256);
  expect(text).not.toMatch(/[\r\n\t]/);
  expect(text).toContain("Example  Network");
});
