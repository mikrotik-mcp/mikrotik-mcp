/** Detailed metrics: interface counters, CPU cores and SFP levels, read only when scraped. */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { DeviceDetail } from "../../src/observability/metrics-detail";

vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
const {
  CPU_SCRIPT,
  DETAIL_TTL_MS,
  INTERFACES_SCRIPT,
  SFP_SCRIPT,
  detailFor,
  parseCores,
  parseInterfaces,
  parseSfps,
  renderDetail,
  resetDetail,
} = await import("../../src/observability/metrics-detail");

beforeEach(resetDetail);

test("the script output is read as samples (lines are from RouterOS 7.25.1)", () => {
  expect(
    parseInterfaces("ether1|false|0|0||||\r\nbridge|true|123456789012|42|0|1|2|3\r\n"),
  ).toEqual([
    {
      name: "ether1",
      running: false,
      rxBytes: 0,
      txBytes: 0,
      rxErrors: undefined,
      txErrors: undefined,
      rxDrops: undefined,
      txDrops: undefined,
    },
    {
      name: "bridge",
      running: true,
      rxBytes: 123456789012,
      txBytes: 42,
      rxErrors: 0,
      txErrors: 1,
      rxDrops: 2,
      txDrops: 3,
    },
  ]);
  expect(parseCores("cpu0|70\r\ncpu1|27\r\nnoise\r\n")).toEqual([
    { cpu: "cpu0", load: 70 },
    { cpu: "cpu1", load: 27 },
  ]);
  // A cage with no module gives no values and is left out.
  expect(parseSfps("sfp-sfpplus1|-5.2dBm|-1.9dBm|42C|3.31V\r\nsfp2||||\r\n")).toEqual([
    { name: "sfp-sfpplus1", rxPowerDbm: -5.2, txPowerDbm: -1.9, temperatureC: 42, voltage: 3.31 },
  ]);
});

test("the scripts only read", () => {
  for (const script of [INTERFACES_SCRIPT, CPU_SCRIPT, SFP_SCRIPT])
    expect(script).not.toMatch(/\b(?:add|set|remove|enable|disable|reset)\b/);
});

const detail = (at: number): DeviceDetail => ({
  at,
  interfaces: [{ name: 'wan "1"', running: true, rxBytes: 10, txBytes: 20 }],
  cores: [{ cpu: "cpu0", load: 5 }],
  sfps: [{ name: "sfp1", rxPowerDbm: -6.5 }],
});

test("a scrape never waits: it serves the cache and refreshes a stale router in the background", async () => {
  const read = vi.fn(async (_device: string) => detail(1000));
  expect(detailFor(["edge"], 1000, read).size).toBe(0);
  // A second scrape while the first read runs starts no second read.
  detailFor(["edge"], 1001, read);
  expect(read).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(detailFor(["edge"], 2000, read).get("edge")!.cores).toEqual([{ cpu: "cpu0", load: 5 }]);
  expect(read).toHaveBeenCalledTimes(1);
  // Stale: the old values are still served while the new read runs.
  expect(detailFor(["edge"], 1000 + DETAIL_TTL_MS + 1, read).size).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test("a failed read keeps the scrape working", async () => {
  const read = vi.fn(async (): Promise<DeviceDetail> => {
    throw new Error("connection lost");
  });
  expect(detailFor(["edge"], 1, read).size).toBe(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(detailFor(["edge"], 2, read).size).toBe(0);
  expect(read).toHaveBeenCalledTimes(2);
});

test("the text has interface, core and SFP series with escaped labels", () => {
  const text = renderDetail(new Map([["edge", detail(5000)]]));
  expect(text).toContain('mikrotik_interface_running{device="edge",interface="wan \\"1\\""} 1');
  expect(text).toContain("# TYPE mikrotik_interface_receive_bytes_total counter");
  expect(text).toContain(
    'mikrotik_interface_transmit_bytes_total{device="edge",interface="wan \\"1\\""} 20',
  );
  // A counter the router did not report gives no series and no header.
  expect(text).not.toContain("mikrotik_interface_receive_errors_total");
  expect(text).toContain('mikrotik_cpu_core_load_percent{device="edge",cpu="cpu0"} 5');
  expect(text).toContain('mikrotik_sfp_rx_power_dbm{device="edge",interface="sfp1"} -6.5');
  expect(text).toContain('mikrotik_detail_timestamp_seconds{device="edge"} 5');
  expect(renderDetail(new Map())).toBe("");
});
