import { expect, test } from "vite-plus/test";
import {
  BandwidthJobSchema,
  bandwidthCommand,
  bandwidthRate,
  expectedRoute,
  parseBandwidthResult,
} from "../../src/bandwidth/model";
import type { BandwidthJob } from "../../src/bandwidth/types";
import { parseRecords } from "../../src/core/routeros-parse";

export const job: BandwidthJob = {
  ...BandwidthJobSchema.parse({
    id: "wg",
    name: "WireGuard",
    source: "a",
    destination: "b",
    sourceInterface: "wg0",
    sourceAddress: "10.0.0.1",
    destinationAddress: "10.0.0.2",
  }),
  nextRunAt: 0,
};

test("live RouterOS unnumbered connected routes retain flags and distinct records for preflight", () => {
  const output = [
    "Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT",
    " 0 As dst-address=0.0.0.0/0 routing-table=main gateway=ether1",
    "DAc dst-address=10.0.0.0/30 routing-table=main gateway=wg0",
    "    immediate-gw=wg0 distance=0 scope=10 target-scope=5",
    "    local-address=10.0.0.1%wg0",
    "DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge",
    "    immediate-gw=bridge distance=0",
  ].join("\r\n");
  const { rows } = parseRecords(output);
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({
    flags: "DAc",
    "dst-address": "10.0.0.0/30",
    "immediate-gw": "wg0",
  });
  expect(rows[1]).not.toHaveProperty("#");
  expect(expectedRoute(job, rows)).toBe(true);
  expect(
    expectedRoute(
      job,
      parseRecords(output.replace("DAc dst-address=10", "DIc dst-address=10")).rows,
    ),
  ).toBe(false);
  expect(expectedRoute(job, parseRecords(output.split("\r\n").slice(2, 5).join("\r\n")).rows)).toBe(
    true,
  );
});

test("documented commands include bounded rates and correct protocol-specific parameters without invented binding", () => {
  const command = bandwidthCommand(
    { ...job, localTxBps: 100_000_000_000, connectionCount: 3 },
    { username: "operator", password: 'secret"; /system reboot\n$x' },
  );
  expect(command).toContain("address=10.0.0.2");
  expect(command).toContain("connection-count=3");
  expect(command).toContain("local-tx-speed=100000000000");
  expect(command).not.toMatch(/local-address|interface=|\n/);
  expect(command).toContain('password="secret\\\"; /system reboot\\n\\$x"');
  const udp = bandwidthCommand({
    ...job,
    protocol: "udp",
    localUdpTxSize: 28,
    remoteUdpTxSize: 64000,
    randomData: true,
    reportIntervalSeconds: 0.021,
  });
  expect(udp).toContain("interval=21ms");
  expect(udp).toContain("local-udp-tx-size=28");
  expect(udp).toContain("remote-udp-tx-size=64000");
  expect(udp).toContain("random-data=yes");
  expect(udp).not.toContain("connection-count");
});
test("settings reject raw secrets, unbounded load, malformed IPs and fractional milliseconds", () => {
  for (const patch of [
    { password: "no" },
    { localAddress: "10.0.0.1" },
    { durationSeconds: 61 },
    { intervalSeconds: 299 },
    { localTxBps: 0 },
    { remoteTxBps: 100_000_000_001 },
    { reportIntervalSeconds: 0.0201 },
    { destinationAddress: "a; reboot" },
    { localUdpTxSize: 27 },
    { connectionCount: 256 },
  ]) {
    expect(BandwidthJobSchema.safeParse({ ...job, ...patch }).success).toBe(false);
  }
  expect(
    BandwidthJobSchema.safeParse({
      ...job,
      reportIntervalSeconds: 0.029,
      localTxBps: 100_000_000_000,
    }).success,
  ).toBe(true);
});
test("actual documented RouterOS summary parses SI rates and loss, not current rates", () => {
  const raw =
    "status: running\r\nrx-total-average: 1bps\r\nstatus: done testing\r\nduration: 15s\r\ntx-current: 272.8Mbps\r\ntx-10-second-average: 200.3Mbps\r\ntx-total-average: 139.5Mbps\r\nrx-current: 169.6Mbps\r\nrx-total-average: 117.0Mbps\r\nlost-packets: 373";
  expect(parseBandwidthResult(raw, "both")).toMatchObject({
    status: "ok",
    txBps: 139500000,
    rxBps: 117000000,
    lostPackets: 373,
  });
  expect(
    parseBandwidthResult("status: done testing\nrx-total-average: 0bps", "receive"),
  ).toMatchObject({ status: "ok", txBps: null, rxBps: 0 });
  expect(
    parseBandwidthResult(
      "status: running\rtx-total-average: 2Mbps\nstatus: done testing",
      "transmit",
    ).txBps,
  ).toBe(2000000);
  for (const [text, value] of [
    ["100bps", 100],
    ["2.5kbps", 2500],
    ["1.2Gbps", 1200000000],
    ["2Tbps", 2000000000000],
    ["bad", null],
    ["-1Mbps", null],
  ] as const)
    expect(bandwidthRate(text)).toBe(value);
});
test("failures, partial and missing final measurements never produce success or zero", () => {
  for (const output of [
    "",
    "status: running\ntx-total-average: 2Mbps",
    "status: done testing\ntx-current: 5Mbps",
    "status: done testing\ntx-total-average: 2Mbps\nfailure: denied",
    "status: authentication failed\nrx-total-average: 3Mbps",
  ]) {
    expect(parseBandwidthResult(output, "both")).toMatchObject({
      status: "failed",
      txBps: null,
      rxBps: null,
      lostPackets: null,
    });
  }
});
test("longest-prefix route validates direct /32 and refuses ECMP, inactive, wrong interface/source", () => {
  const route = {
    flags: "DAc",
    "dst-address": "10.0.0.2/32",
    gateway: "wg0",
    "routing-table": "main",
  };
  const defaultRoute = {
    flags: "AS",
    "dst-address": "0.0.0.0/0",
    "immediate-gw": "192.168.1.1%ether1",
  };
  expect(expectedRoute(job, [defaultRoute, route])).toBe(true);
  expect(
    expectedRoute(job, [
      { ...route, gateway: "", "immediate-gw": "10.0.0.2%wg0", "pref-src": "10.0.0.1" },
    ]),
  ).toBe(true);
  for (const patch of [
    { flags: "I" },
    { gateway: "ether1" },
    { gateway: "wg0,ether1" },
    { "pref-src": "10.0.0.99" },
    { "routing-table": "other" },
    { type: "blackhole" },
  ] as Record<string, string>[])
    expect(expectedRoute(job, [{ ...route, ...patch }])).toBe(false);
  expect(expectedRoute(job, [route, route])).toBe(false);
  expect(expectedRoute(job, [])).toBe(false);
});

test("more-specific discard route wins over a less-specific tunnel route and fails preflight", () => {
  const tunnel = { flags: "AS", "dst-address": "10.0.0.0/24", gateway: "wg0" };
  for (const discard of [
    { type: "blackhole" },
    { type: "unreachable" },
    { type: "prohibit" },
    { blackhole: "true" },
    { blackhole: "yes" },
  ] as Record<string, string>[]) {
    expect(
      expectedRoute(job, [
        tunnel,
        { flags: "AS", "dst-address": "10.0.0.2/32", gateway: "wg0", ...discard },
      ]),
    ).toBe(false);
  }
});
