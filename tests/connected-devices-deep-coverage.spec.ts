import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import {
  KID_CONTROL_COUNTERS_COMMAND,
  allowDevice,
  blockDevice,
  fetchDevices,
  sampleAllTraffic,
  setDeviceIp,
  setDeviceLimits,
} from "../src/tools/connected-devices";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "connected-deep", info: vi.fn(), error: vi.fn() };
const issued = () => command.mock.calls.map(([text]) => text);
beforeEach(() => command.mockReset());

test("inventory tolerates failed DHCP read and prefers reachable ARP alias", async () => {
  command
    .mockResolvedValueOnce("failure: denied")
    .mockResolvedValueOnce(
      "0 address=10.0.0.9 mac-address=AA:BB:CC:DD:EE:FF status=stale\n1 address=10.0.0.7 mac-address=AA:BB:CC:DD:EE:FF interface=bridge status=reachable",
    );
  expect(await fetchDevices(ctx)).toMatchObject([
    { mac: "AA:BB:CC:DD:EE:FF", ip: "10.0.0.7", status: "reachable", iface: "bridge" },
  ]);
  expect(issued()).toEqual(["/ip dhcp-server lease print detail", "/ip arp print detail"]);
});

test("bulk traffic falls back to Kid Control, parses counters and queue limits", async () => {
  command.mockImplementation(async (text) => {
    if (text === "/queue simple print detail") return "0 target=10.0.0.7/32 max-limit=2M/10M";
    if (text === "/ip accounting print") return "bad command name accounting";
    if (text === "/ip kid-control device print count-only") return "1";
    if (text === KID_CONTROL_COUNTERS_COMMAND)
      return "0 ip-address=10.0.0.7 rate-down=8000 rate-up=2000 bytes-down=1024 bytes-up=256";
    return "";
  });
  const sample = await sampleAllTraffic(ctx);
  expect(sample).toMatchObject({
    source: "kid-control",
    limits: { "10.0.0.7": { download: "10M", upload: "2M" } },
    hosts: { "10.0.0.7": { rxRate: 8000, txRate: 2000, rxBytes: 1024, txBytes: 256 } },
  });
  expect(issued()).toContain(KID_CONTROL_COUNTERS_COMMAND);
  expect(issued().every((text) => !/\/ip accounting snapshot take/.test(text))).toBe(true);
});

test("bulk traffic reports counter failure while retaining queue limits", async () => {
  const failed: ToolContext = { ...ctx, device: "connected-deep-failure" };
  command.mockImplementation(async (text) => {
    if (text === "/queue simple print detail") return "0 target=10.0.0.8/32 max-limit=1M/4M";
    if (text === "/ip accounting print") return "bad command name accounting";
    if (text === "/ip kid-control device print count-only") return "1";
    if (text === KID_CONTROL_COUNTERS_COMMAND) return "failure: permission denied";
    return "";
  });
  expect(await sampleAllTraffic(failed)).toMatchObject({
    source: "none",
    note: "failure: permission denied",
    hosts: {},
    limits: { "10.0.0.8": { download: "4M", upload: "1M" } },
  });
});

test("block failure stops before later firewall and DHCP writes", async () => {
  command.mockResolvedValueOnce("0").mockResolvedValueOnce("failure: denied");
  expect(await blockDevice(ctx, "aa-bb-cc-dd-ee-ff")).toMatchObject({
    ok: false,
    message: "Failed to add forward block rule: failure: denied",
  });
  expect(issued()).toHaveLength(2);
  expect(issued()[1]).toContain("chain=forward");
});

test("allow failure preserves DHCP block state; IP pin failure prevents address write", async () => {
  command.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: denied");
  expect((await allowDevice(ctx, "aa-bb-cc-dd-ee-ff")).ok).toBe(false);
  expect(issued().some((text) => text.includes("block-access=no"))).toBe(false);
  command
    .mockReset()
    .mockResolvedValueOnce("0 D dynamic=yes address=10.0.0.7")
    .mockResolvedValueOnce("failure: denied");
  expect((await setDeviceIp(ctx, "aa-bb-cc-dd-ee-ff", "10.0.0.8")).message).toContain(
    "Failed to pin lease",
  );
  expect(issued().some((text) => text.includes("address=10.0.0.8"))).toBe(false);
});

test("queue limit failure preserves RouterOS upload/download command ordering", async () => {
  command.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: denied");
  expect((await setDeviceLimits(ctx, "10.0.0.7", { download: "8M", upload: "2M" })).ok).toBe(false);
  expect(issued()[1]).toContain("max-limit=2M/8M");
});
