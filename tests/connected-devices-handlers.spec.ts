import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import {
  allowDevice,
  blockDevice,
  fetchDevices,
  makeDeviceStatic,
  removeDeviceLease,
  sampleAllTraffic,
  sampleDeviceTraffic,
  setDeviceIp,
  setDeviceLabel,
  setDeviceLimits,
} from "../src/tools/connected-devices";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture-connected", info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  command.mockReset();
  command.mockImplementation(async (text) => {
    if (text === "/ip dhcp-server lease print detail")
      return "0 D address=10.0.0.7 mac-address=AA:BB:CC:DD:EE:FF host-name=Phone dynamic=yes status=bound server=dhcp1\n1 address=10.0.0.8 mac-address=11:22:33:44:55:66 comment=Printer dynamic=no block-access=yes";
    if (text === "/ip arp print detail")
      return "0 address=10.0.0.7 mac-address=AA:BB:CC:DD:EE:FF interface=bridge status=reachable\n1 address=10.0.0.9 mac-address=77:88:99:AA:BB:CC interface=bridge status=stale";
    if (text.includes("print count-only")) return "1";
    if (text.includes("/queue simple print stats detail"))
      return "0 target=10.0.0.7/32 rate=1000/2000 bytes=100/200 max-limit=5M/10M";
    return "";
  });
});

test("lease and ARP inventory prefers a reachable ARP entry and retains ARP-only clients", async () => {
  const devices = await fetchDevices(ctx);
  expect(devices.map((d) => d.ip)).toEqual(["10.0.0.7", "10.0.0.8", "10.0.0.9"]);
  expect(devices[0]).toMatchObject({
    host: "Phone",
    iface: "bridge",
    static: false,
    status: "bound",
  });
  expect(devices[1]).toMatchObject({ blocked: true, static: true, comment: "Printer" });
  expect(devices[2]).toMatchObject({ status: "stale", iface: "bridge" });
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    "/ip dhcp-server lease print detail",
    "/ip arp print detail",
  ]);
});

test("device traffic normalizes RouterOS upload/download ordering", async () => {
  expect(await sampleDeviceTraffic(ctx, "10.0.0.7")).toMatchObject({
    source: "queue",
    txBitsPerSec: 1000,
    rxBitsPerSec: 2000,
    txBytes: 100,
    rxBytes: 200,
    uploadLimit: "5M",
    downloadLimit: "10M",
  });
  command.mockResolvedValueOnce("");
  expect(await sampleDeviceTraffic(ctx, "10.0.0.10")).toMatchObject({
    source: "none",
    rxBitsPerSec: 0,
  });
});

test("read-only bulk sample diagnoses unavailable sources without changing the router", async () => {
  command.mockImplementation(async (text) => {
    if (text === "/ip accounting print") return "failure: not supported";
    if (text === "/ip kid-control device print count-only") return "failure: not supported";
    return "";
  });
  const sample = await sampleAllTraffic(ctx);
  expect(sample.source).toBe("none");
  expect(sample.note).toContain("Kid Control");
  expect(command.mock.calls.every(([text]) => !/\b(?:add|set|remove)\b/.test(text))).toBe(true);
});

test("rate-limit operation distinguishes no-op, creation, update and RouterOS failure", async () => {
  command.mockResolvedValueOnce("0");
  expect((await setDeviceLimits(ctx, "10.0.0.7", {})).message).toContain("left unlimited");
  expect(command).toHaveBeenCalledTimes(1);

  command.mockResolvedValueOnce("0");
  expect((await setDeviceLimits(ctx, "10.0.0.7", { download: "10M", upload: "2M" })).ok).toBe(true);
  expect(command.mock.calls.at(-1)?.[0]).toContain("max-limit=2M/10M");

  command.mockResolvedValueOnce("1");
  expect((await setDeviceLimits(ctx, "10.0.0.7", { download: "5M" })).ok).toBe(true);
  expect(command.mock.calls.at(-1)?.[0]).toContain("/queue simple set");

  command.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: denied");
  expect((await setDeviceLimits(ctx, "10.0.0.7", { download: "5M" })).ok).toBe(false);
});

test("block/allow use a MAC-scoped tagged rule and avoid duplicate blocks", async () => {
  command.mockResolvedValueOnce("1");
  expect((await blockDevice(ctx, "aa-bb-cc-dd-ee-ff")).message).toContain("already blocked");
  expect(command).toHaveBeenCalledTimes(1);
  command.mockResolvedValueOnce("0");
  expect((await blockDevice(ctx, "aa-bb-cc-dd-ee-ff")).ok).toBe(true);
  const writes = command.mock.calls.map(([text]) => text);
  expect(writes.filter((text) => text.startsWith("/ip firewall filter add"))).toHaveLength(2);
  expect(writes.some((text) => text.includes("src-mac-address=AA:BB:CC:DD:EE:FF"))).toBe(true);
  command.mockResolvedValueOnce("1");
  expect((await allowDevice(ctx, "aa-bb-cc-dd-ee-ff")).ok).toBe(true);
  expect(
    command.mock.calls
      .map(([text]) => text)
      .some((text) => text.startsWith("/ip firewall filter remove")),
  ).toBe(true);
});

test("lease mutations verify existence and keep MAC scoping", async () => {
  command.mockResolvedValueOnce("0");
  expect((await makeDeviceStatic(ctx, "aa-bb-cc-dd-ee-ff")).ok).toBe(false);
  command.mockResolvedValueOnce("1");
  expect((await makeDeviceStatic(ctx, "aa-bb-cc-dd-ee-ff")).ok).toBe(true);

  command.mockResolvedValueOnce("0");
  expect((await setDeviceLabel(ctx, "aa-bb-cc-dd-ee-ff", "Phone")).ok).toBe(false);
  command.mockResolvedValueOnce("1");
  expect((await setDeviceLabel(ctx, "aa-bb-cc-dd-ee-ff", "Phone")).ok).toBe(true);

  command.mockResolvedValueOnce("0");
  expect((await removeDeviceLease(ctx, "aa-bb-cc-dd-ee-ff")).ok).toBe(false);
  command.mockResolvedValueOnce("1");
  expect((await removeDeviceLease(ctx, "aa-bb-cc-dd-ee-ff")).ok).toBe(true);

  command.mockResolvedValueOnce("");
  expect((await setDeviceIp(ctx, "aa-bb-cc-dd-ee-ff", "10.0.0.10")).ok).toBe(false);
  command.mockResolvedValueOnce("0 D dynamic=yes address=10.0.0.7");
  expect((await setDeviceIp(ctx, "aa-bb-cc-dd-ee-ff", "10.0.0.10")).ok).toBe(true);
  expect(command.mock.calls.at(-1)?.[0]).toContain("address=10.0.0.10");
});
