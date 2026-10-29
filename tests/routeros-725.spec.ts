import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import type { ToolModule } from "../src/core/registry";
import { bridgeTools } from "../src/tools/bridge";
import { dhcpTools } from "../src/tools/dhcp";
import { dot1xServerTools } from "../src/tools/dot1x-server";
import { ipv6DhcpServerTools } from "../src/tools/ipv6-dhcp-server";
import { routingBgpTools } from "../src/tools/routing-bgp";
import { vlanTools } from "../src/tools/vlan";
import { wireguardTools } from "../src/tools/wireguard";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };

function invoke(module: ToolModule, name: string, args: Record<string, unknown>) {
  const tool = module.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return Promise.resolve(tool.handler(args as never, ctx));
}

beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("0 name=fixture");
});

describe("RouterOS 7.25 command compatibility", () => {
  test("802.1X accepts the new period but rejects both period names", async () => {
    await invoke(dot1xServerTools, "add_dot1x_server", {
      interface: "ether2",
      reauth_period: "1h",
      disabled: false,
    });
    expect(command.mock.calls[0][0]).toContain("reauth-period=1h");
    command.mockClear();
    expect(
      await invoke(dot1xServerTools, "add_dot1x_server", {
        interface: "ether2",
        reauth_period: "1h",
        reauth_timeout: "2h",
      }),
    ).toContain("either");
    expect(command).not.toHaveBeenCalled();
  });

  test("WireGuard sends client MTU and can unset the generated client listen port", async () => {
    await invoke(wireguardTools, "update_wireguard_peer", {
      peer_id: "*A",
      client_mtu: 1380,
      client_listen_port: "",
    });
    expect(
      command.mock.calls.some(
        ([text]) => text.includes("client-mtu=1380") && text.includes("!client-listen-port"),
      ),
    ).toBe(true);
  });

  test("bridge security controls require explicit disruption acknowledgement", async () => {
    expect(
      await invoke(bridgeTools, "update_bridge", { name: "bridge1", arp_inspection: true }),
    ).toContain("confirm_security_disruption=true");
    expect(command).not.toHaveBeenCalled();
    await invoke(bridgeTools, "update_bridge", {
      name: "bridge1",
      arp_inspection: true,
      confirm_security_disruption: true,
    });
    expect(command.mock.calls[0][0]).toContain("arp-inspection=yes");
  });

  test("BGP MED update verifies instance before changing path selection", async () => {
    command.mockResolvedValueOnce("0");
    expect(
      await invoke(routingBgpTools, "update_bgp_instance_med_comparison", {
        name: "main",
        always_compare_med: true,
        confirm_routing_change: true,
      }),
    ).toContain("not found");
    expect(command).toHaveBeenCalledTimes(1);
  });

  test("new VLAN and DHCP settings reach the corresponding RouterOS properties", async () => {
    await invoke(vlanTools, "create_vlan_interface", {
      name: "vlan20",
      interface: "ether1",
      vlan_id: 20,
      forced_mac_address: "02:00:00:00:00:20",
      disabled: false,
      use_service_tag: false,
      arp: "enabled",
    });
    expect(command.mock.calls[0][0]).toContain("forced-mac-address=02:00:00:00:00:20");
    command.mockClear();
    await invoke(dhcpTools, "create_dhcp_server", {
      name: "dhcp1",
      interface: "bridge1",
      address_pool: "pool1",
      ipv6_only_preferred: true,
    });
    expect(command.mock.calls[0][0]).toContain("ipv6-only-preferred=yes");
    command.mockClear();
    await invoke(ipv6DhcpServerTools, "create_ipv6_dhcp_server", {
      name: "v6",
      interface: "bridge1",
      address_pool: "pool6",
      lease_time: "3d",
      add_dns_entries: true,
      add_dns_entries_suffix: "lan.example",
    });
    expect(command.mock.calls[0][0]).toContain("add-dns-entries=yes");
    expect(command.mock.calls[0][0]).toContain("add-dns-entries-suffix=lan.example");
  });
});
