import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createContext } from "../src/core/context";
import { sampleAllTraffic } from "../src/tools/connected-devices";

const read = vi.hoisted(() => vi.fn(async (_command: string) => ""));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: read }));
beforeEach(() => {
  read.mockReset();
});

test("dashboard sampling reads real dual-stack counters without modifying router configuration", async () => {
  read.mockImplementation(async (command: string) => {
    if (command === "/ip accounting print") return "bad command name accounting";
    if (command === "/ip kid-control device print count-only") return "1";
    if (command === "/ip kid-control device print detail without-paging")
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

test("empty counters give an actionable diagnostic rather than silent dashes", async () => {
  read.mockImplementation(async (command: string) =>
    command === "/ip accounting print" ? "enabled: no" : "",
  );
  const result = await sampleAllTraffic(createContext(undefined, "empty-traffic-test"));
  expect(result.hosts).toEqual({});
  expect(result.note).toContain("No per-device counters");
  expect(read.mock.calls.every(([command]) => /\bprint\b/.test(command))).toBe(true);
});
