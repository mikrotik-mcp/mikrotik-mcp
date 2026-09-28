import { expect, test } from "vite-plus/test";
import { clientCheckNetwork } from "../../src/client-check/network";
import { clientCheckOrigin } from "../../src/client-check/model";
import { DashboardConfigSchema } from "../../src/config";

const address = (ip: string, internal = false) => ({
  address: ip,
  family: "IPv4" as const,
  internal,
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: `${ip}/24`,
});
test("dashboard defaults to all interfaces and QR discovery prefers LAN over VPN and never loopback", () => {
  expect(DashboardConfigSchema.parse({}).host).toBe("0.0.0.0");
  const network = {
    lo0: [address("127.0.0.1", true)],
    utun1: [address("10.79.79.2")],
    en0: [address("192.168.1.20")],
  };
  const result = clientCheckNetwork("0.0.0.0", 9091, network);
  expect(result.localOnly).toBe(false);
  expect(result.candidates.map((c) => c.origin)).toEqual([
    "http://192.168.1.20:9091",
    "http://10.79.79.2:9091",
  ]);
  expect(clientCheckNetwork("127.0.0.1", 9091, network)).toMatchObject({
    localOnly: true,
    candidates: [],
  });
  expect(clientCheckNetwork("192.168.1.20", 9091, network).candidates).toHaveLength(1);
  expect(clientCheckNetwork("0.0.0.0", 9091, {}).candidates).toEqual([]);
});
test.each([
  "http://localhost:9091",
  "http://127.1:9091",
  "http://0.0.0.0:9091",
  "http://[::1]:9091",
  "http://[::]:9091",
  "http://[::ffff:127.0.0.1]:9091",
  "http://user:pass@host",
  "http://host/path",
  "http://host?token=secret",
  "http://host#secret",
  "file:///tmp/test",
])("rejects unusable or credential-bearing QR origin %s", (value) => {
  expect(() => clientCheckOrigin(value)).toThrow();
});
test("supports LAN, VPN and explicitly selected HTTPS proxy origins", () => {
  for (const value of [
    "http://192.168.1.20:9091",
    "http://10.79.79.2:9091",
    "https://checks.example",
    "http://[fd00::1]:9091",
  ])
    expect(clientCheckOrigin(value)).toBe(value);
});
