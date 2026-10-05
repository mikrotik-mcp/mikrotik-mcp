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
