import { beforeEach, expect, test, vi } from "vite-plus/test";
import { collectFabric, l2FabricTools } from "../src/tools/l2-fabric";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));

const mac = "AA:BB:CC:DD:EE:01";
const info = vi.fn();
const ctx = { device: "lab", info };
const responses: Record<string, string> = {
  "/interface bridge host print detail": `0 mac-address=${mac} on-interface=ether2 bridge=bridge1 dynamic=yes`,
  "/ip arp print detail": `0 mac-address=${mac} address=192.0.2.10 interface=bridge1 complete=yes`,
  "/ip dhcp-server lease print detail": `0 mac-address=${mac} address=192.0.2.10 host-name=printer status=bound`,
  "/ip neighbor print detail": "",
};

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockImplementation(async (command: string) => responses[command] ?? "");
});

test("collector joins four RouterOS tables and preserves useful labels", async () => {
  const result = await collectFabric("lab", ctx as never);
  expect(result.device).toBe("lab");
  expect(result.hosts).toEqual([
    expect.objectContaining({ mac, onInterface: "ether2", dynamic: true }),
  ]);
  expect(result.arp).toEqual([
    expect.objectContaining({ mac, address: "192.0.2.10", complete: true }),
  ]);
  expect(result.leases).toEqual([
    expect.objectContaining({ hostname: "printer", status: "bound" }),
  ]);
  expect(execute).toHaveBeenCalledTimes(4);
});

test("failed optional reads degrade gracefully without hiding bridge hosts", async () => {
  execute.mockImplementation(async (command: string) => {
    if (command.includes("bridge host")) return responses[command];
    if (command.includes("dhcp-server")) throw new Error("SSH timeout");
    return "failure: unavailable";
  });
  const result = await collectFabric(undefined, ctx as never);
  expect(result.device).toBe("default");
  expect(result.hosts).toHaveLength(1);
  expect(result.arp).toEqual([]);
  expect(result.leases).toEqual([]);
  expect(result.neighbors).toEqual([]);
});

test("map tool returns rendered and structured port data, including filter and summary", async () => {
  const tool = l2FabricTools.find((entry) => entry.name === "map_l2_fabric");
  if (!tool) throw new Error("map_l2_fabric missing");
  const full = (await tool.handler({}, ctx as never)) as {
    text: string;
    structuredContent: { ports: unknown[] };
  };
  expect(full.text).toContain("ether2");
  expect(full.text).toContain("printer");
  expect(full.structuredContent.ports).toHaveLength(1);
  const filtered = (await tool.handler(
    { interface_filter: "ether9", summary_only: true },
    ctx as never,
  )) as { text: string; structuredContent: { ports: unknown[] } };
  expect(filtered.structuredContent.ports).toHaveLength(0);
  expect(filtered.text).not.toContain("printer");
});

test("locate host reports its port or gives a useful absent-host explanation", async () => {
  const tool = l2FabricTools.find((entry) => entry.name === "locate_host_port");
  if (!tool) throw new Error("locate_host_port missing");
  const found = await tool.handler({ query: "192.0.2.10" }, ctx as never);
  expect(found).toContain("ether2");
  expect(found).toContain("printer");
  const missing = await tool.handler({ query: "192.0.2.99" }, ctx as never);
  expect(missing).toContain("No host matching");
  expect(missing).toContain("switch-chip offloaded");
});
