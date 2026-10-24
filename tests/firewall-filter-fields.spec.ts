import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { firewallFilterTools } from "../src/tools/firewall-filter";

const read = vi.hoisted(() => vi.fn<(command: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: read }));

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const tool = firewallFilterTools.find((entry) => entry.name === "update_filter_rule")!;
const run = (args: Record<string, unknown>) => tool.handler(args as never, ctx);

beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async (command) => {
    if (command.endsWith("count-only where .id=*A")) return "1";
    if (command === "/ip firewall filter print detail where .id=*A")
      return "0 chain=forward action=accept comment=fixture";
    return "";
  });
});
afterEach(() => vi.clearAllMocks());

const fields = [
  ["src_address", "src-address", "192.0.2.1"],
  ["dst_address", "dst-address", "203.0.113.0/24"],
  ["src_port", "src-port", "443"],
  ["dst_port", "dst-port", "8443"],
  ["protocol", "protocol", "tcp"],
  ["in_interface", "in-interface", "ether1"],
  ["out_interface", "out-interface", "ether2"],
  ["connection_state", "connection-state", "established,related"],
  ["connection_nat_state", "connection-nat-state", "dstnat"],
  ["src_address_list", "src-address-list", "TRUSTED"],
  ["dst_address_list", "dst-address-list", "BLOCKED"],
  ["limit", "limit", "10/1s:packet"],
  ["tcp_flags", "tcp-flags", "syn,!ack"],
  ["src_mac_address", "src-mac-address", "02:00:00:00:00:01"],
  ["in_interface_list", "in-interface-list", "LAN"],
  ["out_interface_list", "out-interface-list", "WAN"],
  ["port", "port", "80,443"],
  ["connection_mark", "connection-mark", "mark-conn"],
  ["packet_mark", "packet-mark", "mark-packet"],
  ["routing_mark", "routing-mark", "vpn"],
  ["connection_type", "connection-type", "ftp"],
  ["connection_bytes", "connection-bytes", "1000-2000"],
  ["connection_limit", "connection-limit", "10,32"],
  ["connection_rate", "connection-rate", "0-100k"],
  ["content", "content", "fixture"],
  ["dscp", "dscp", "46"],
  ["layer7_protocol", "layer7-protocol", "http"],
  ["packet_size", "packet-size", "64-1500"],
  ["ipsec_policy", "ipsec-policy", "in,ipsec"],
  ["ttl", "ttl", "64"],
  ["nth", "nth", "2,1"],
  ["time", "time", "08:00:00-18:00:00,sun"],
  ["random", "random", "50"],
  ["tcp_mss", "tcp-mss", "1200-1450"],
  ["src_address_type", "src-address-type", "local"],
  ["dst_address_type", "dst-address-type", "unicast"],
  ["hotspot", "hotspot", "auth"],
  ["icmp_options", "icmp-options", "8:0"],
  ["priority", "priority", "1"],
  ["jump_target", "jump-target", "custom-chain"],
  ["reject_with", "reject-with", "icmp-net-unreachable"],
  ["address_list", "address-list", "suspects"],
  ["address_list_timeout", "address-list-timeout", "1h"],
] as const;

test.each(fields)(
  "maps %s to RouterOS %s and reads back the same rule",
  async (input, key, value) => {
    const result = await run({ rule_id: "*A", [input]: value });
    expect(read.mock.calls.map(([command]) => command)).toEqual([
      "/ip firewall filter print count-only where .id=*A",
      `/ip firewall filter set *A ${key}=${value}`,
      "/ip firewall filter print detail where .id=*A",
    ]);
    expect(result).toContain("updated successfully");
  },
);

test.each(["src_address", "dst_address", "src_address_list", "dst_address_list", "content"])(
  "clears %s with the RouterOS unset syntax",
  async (input) => {
    const key = fields.find(([field]) => field === input)![1];
    await run({ rule_id: "*A", [input]: "" });
    expect(read.mock.calls[1][0]).toBe(`/ip firewall filter set *A !${key}`);
  },
);

test("rejects a chain passed as an interface before accessing the router", async () => {
  const result = await run({ rule_id: "*A", in_interface: "input" });
  expect(result).toContain("CHAIN, not an interface");
  expect(read).not.toHaveBeenCalled();
});

test("rejects malformed row references before executing the set command", async () => {
  const result = await run({ rule_id: "*A; /system reboot", comment: "fixture" });
  expect(result).toContain("not found");
  expect(read).not.toHaveBeenCalled();
});

test("a router-side rejection is reported without reading success details", async () => {
  read.mockImplementation(async (command) => {
    if (command.endsWith("count-only where .id=*A")) return "1";
    return "failure: not enough permissions";
  });
  const result = await run({ rule_id: "*A", action: "drop" });
  expect(result).toContain("Failed to update");
  expect(read).toHaveBeenCalledTimes(2);
});
