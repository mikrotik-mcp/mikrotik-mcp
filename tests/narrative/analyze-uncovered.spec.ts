import { expect, test } from "vite-plus/test";
import { analyzeDevice } from "../../src/narrative/analyze";

test("describes less common WAN NAT, tunnels, and narrowly scoped exposures", () => {
  const report = analyzeDevice(`
/interface gre
add name=gre-backup remote-address=198.51.100.5
/interface wireguard
add name=wg-office
/interface wireguard peers
add interface=wg-office name=roamer allowed-address=10.4.0.0/24
/ip ipsec peer
add name=site address=198.51.100.6
/ip ipsec policy
add src-address=10.0.0.0/24 dst-address=10.8.0.0/24
/ip dhcp-client
add interface=ether1
/ip firewall nat
add chain=srcnat action=src-nat out-interface=ether1 to-addresses=192.0.2.10
add chain=dstnat action=dst-nat protocol=tcp dst-port=3389 to-addresses=10.0.0.4 to-ports=3389 src-address=198.51.100.0/24
/ip firewall filter
add chain=input action=accept in-interface-list=WAN protocol=tcp dst-port=22 src-address-list=admins comment=admin-access
/ip service
set telnet disabled=no port=23
set ssh disabled=no address=198.51.100.0/24
`);
  expect(report.wans.find((w) => w.interface === "ether1")?.nat).toContain("src-nat to 192.0.2.10");
  expect(report.tunnels.find((t) => t.name === "roamer")).toBeUndefined();
  expect(report.tunnels.find((t) => t.name === "wg-office")?.peers).toContain(
    "roamer (no endpoint — it dials in)",
  );
  expect(report.tunnels.find((t) => t.name === "site")?.subnets).toEqual([
    "10.0.0.0/24",
    "10.8.0.0/24",
  ]);
  expect(report.tunnels.find((t) => t.name === "gre-backup")?.peers).toEqual(["198.51.100.5"]);
  expect(report.exposure.find((e) => e.kind === "dst-nat")?.what).toContain("RDP");
  expect(report.exposure.find((e) => e.kind === "firewall-accept")?.severity).toBe("medium");
  expect(report.exposure.find((e) => e.what === "telnet")?.severity).toBe("critical");
  expect(report.exposure.find((e) => e.what === "ssh")?.severity).toBe("low");
});

test("unrestricted WAN accepts are critical, while established accepts are ignored", () => {
  const report = analyzeDevice(`/ip firewall filter
add chain=input action=accept in-interface=WAN1 protocol=udp dst-port=500
add chain=input action=accept in-interface=WAN1 connection-state=established,related
`);
  expect(report.exposure.filter((e) => e.kind === "firewall-accept")).toMatchObject([
    { severity: "critical", from: "anyone" },
  ]);
});
