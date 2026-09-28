import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createContext } from "../src/core/context";
import {
  fetchDevices,
  KID_CONTROL_COUNTERS_COMMAND,
  sampleAllTraffic,
} from "../src/tools/connected-devices";

const read = vi.hoisted(() => vi.fn(async (_command: string) => ""));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: read }));
beforeEach(() => {
  read.mockReset();
});

test("dashboard sampling reads real dual-stack counters without modifying router configuration", async () => {
  read.mockImplementation(async (command: string) => {
    if (command === "/ip accounting print") return "bad command name accounting";
    if (command === "/ip kid-control device print count-only") return "1";
    if (command === KID_CONTROL_COUNTERS_COMMAND)
      return `0 D name="PS5"
      ip-address=fe80::1,10.10.10.191 rate-down=1Mbps rate-up=64kbps
      bytes-down=1MiB bytes-up=64KiB`;
    if (command === "/queue simple print detail") return "";
    throw new Error(`Unexpected command: ${command}`);
  });
  const result = await sampleAllTraffic(createContext(undefined, "traffic-test"));
  expect(result.source).toBe("kid-control");
  expect(result.hosts["10.10.10.191"]).toEqual({
    rxRate: 1_000_000,
    txRate: 64_000,
    rxBytes: 1048576,
    txBytes: 65536,
  });
  expect(read.mock.calls.every(([command]) => /\bprint\b/.test(command))).toBe(true);
});

test("RouterOS flags and reachable ARP aliases are not mislabelled static/incomplete", async () => {
  read.mockImplementation(async (command) =>
    command.includes("arp")
      ? `Flags: D - DYNAMIC; C - COMPLETE
0 DC address=10.0.0.1 mac-address=AA:BB:CC:DD:EE:01 interface=ether1 status="reachable"
1 DC address=192.0.2.1 mac-address=AA:BB:CC:DD:EE:01 interface=ether1 status="stale"
2 C address=10.0.0.3 mac-address=AA:BB:CC:DD:EE:03 interface=bridge
3 D address=10.0.0.4 mac-address=AA:BB:CC:DD:EE:04 interface=bridge status="failed"`
      : `0 D address=10.0.0.2 mac-address=AA:BB:CC:DD:EE:02 status=bound`,
  );
  const rows = await fetchDevices(createContext(undefined, "flags-test"));
  expect(rows.find((r) => r.mac.endsWith(":01"))).toMatchObject({
    ip: "10.0.0.1",
    static: false,
    status: "reachable",
  });
  expect(rows.find((r) => r.mac.endsWith(":02"))).toMatchObject({ static: false, status: "bound" });
  expect(rows.find((r) => r.mac.endsWith(":03"))).toMatchObject({
    static: true,
    status: "arp-only",
  });
  expect(rows.find((r) => r.mac.endsWith(":04"))).toMatchObject({
    static: false,
    status: "failed",
  });
});

test("empty counters give an actionable diagnostic rather than silent dashes", async () => {
  read.mockImplementation(async (command: string) =>
    command === "/ip accounting print" ? "enabled: no" : "",
  );
  const result = await sampleAllTraffic(createContext(undefined, "empty-traffic-test"));
  expect(result.hosts).toEqual({});
  expect(result.note).toContain("No per-device counters");
  expect(read.mock.calls.every(([command]) => /\bprint\b/.test(command))).toBe(true);
});
