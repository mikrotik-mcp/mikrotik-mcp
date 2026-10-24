import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
  fetchInterfaceListMembers,
  fetchRules,
  firewallAuditTools,
} from "../src/tools/firewall-audit";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.execute }));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  resolveDeviceName: mocks.resolve,
}));

const ctx = { device: "lab", info: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockReturnValue("lab");
  mocks.execute.mockResolvedValue("");
});

test("fetchRules parses RouterOS detail rows and treats empty/error output as unavailable", async () => {
  mocks.execute.mockResolvedValueOnce(
    "0 chain=input action=accept comment=allow\n1 chain=input action=drop comment=deny",
  );
  expect(await fetchRules("/ip firewall filter", ctx as never)).toEqual([
    expect.objectContaining({ chain: "input", action: "accept" }),
    expect.objectContaining({ chain: "input", action: "drop" }),
  ]);
  expect(mocks.execute).toHaveBeenCalledWith("/ip firewall filter print detail", ctx);
  expect(await fetchRules("/ip firewall filter", ctx as never)).toEqual([]);
  mocks.execute.mockResolvedValueOnce("failure: unavailable");
  expect(await fetchRules("/ip firewall filter", ctx as never)).toEqual([]);
});

test("interface-list reader collects multiple members and ignores incomplete rows", async () => {
  mocks.execute.mockResolvedValueOnce(
    "0 list=WAN interface=ether1\n1 list=WAN interface=pppoe-out1\n2 list=LAN interface=bridge\n3 list=WAN",
  );
  const members = await fetchInterfaceListMembers(ctx as never);
  expect([...(members.get("WAN") ?? [])]).toEqual(["ether1", "pppoe-out1"]);
  expect([...(members.get("LAN") ?? [])]).toEqual(["bridge"]);
  expect(members.size).toBe(2);
  mocks.execute.mockResolvedValueOnce("failure: unavailable");
  expect((await fetchInterfaceListMembers(ctx as never)).size).toBe(0);
});

test("audit reads only selected tables and returns both explanatory text and structured findings", async () => {
  mocks.execute.mockImplementation(async (command: string) =>
    command.includes("firewall filter")
      ? "0 chain=input action=accept protocol=tcp dst-port=22"
      : "",
  );
  const output = (await firewallAuditTools[0].handler(
    { include_nat: false, include_mangle: false },
    ctx as never,
  )) as {
    text: string;
    structuredContent: { __mikrotikView: string; device: string; generatedAt: string };
  };
  expect(mocks.execute.mock.calls.map((args) => args[0])).toEqual([
    "/ip firewall filter print detail",
    "/interface list member print detail",
  ]);
  expect(output.text).toContain("lab");
  expect(output.structuredContent.__mikrotikView).toBe("firewall-audit");
  expect(output.structuredContent.device).toBe("lab");
  expect(Number.isNaN(Date.parse(output.structuredContent.generatedAt))).toBe(false);
});

test("audit includes NAT and mangle when requested", async () => {
  await firewallAuditTools[0].handler({ include_nat: true, include_mangle: true }, ctx as never);
  expect(mocks.execute.mock.calls.map((args) => args[0])).toEqual([
    "/ip firewall filter print detail",
    "/ip firewall nat print detail",
    "/ip firewall mangle print detail",
    "/interface list member print detail",
  ]);
});
