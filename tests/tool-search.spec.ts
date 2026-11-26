/**
 * Offline tests for the lexical tool-search ranker. These pin the precision
 * properties the tool gateway relies on: exact-name wins, field weighting,
 * rare-token (IDF) preference, and the IPv4/IPv6 disambiguation that fixes the
 * documented shadowing of generic IPv4 tool names by their IPv6 twins.
 */
import { describe, expect, test } from "vite-plus/test";
import { buildToolIndex, searchToolIndex, tokenize } from "../src/core/tool-search";
import type { ToolForIndex } from "../src/core/tool-search";

const T = (
  name: string,
  title: string,
  description: string,
  module: string,
  group = "G",
): ToolForIndex => ({ name, title, description, module, group, params: [] });

const SAMPLE: ToolForIndex[] = [
  T(
    "create_filter_rule",
    "Create Filter Rule",
    "Add an IP firewall filter rule",
    "firewall-filter",
  ),
  T(
    "create_ipv6_filter_rule",
    "Create IPv6 Filter Rule",
    "Add an IPv6 firewall filter rule",
    "ipv6-firewall-filter",
  ),
  T("list_dhcp_leases", "List DHCP Leases", "List DHCP server leases", "dhcp"),
  T("add_wireguard_peer", "Add WireGuard Peer", "Add a WireGuard peer", "wireguard"),
  T(
    "import_certificate",
    "Import Certificate",
    "Import a TLS certificate from a file",
    "certificate",
  ),
  T("list_ip_addresses", "List IP Addresses", "List IPv4 addresses on interfaces", "ip-address"),
  T(
    "analyze_ovpn_usage",
    "Analyze OpenVPN Usage & Session Accounting",
    "Compute exact OpenVPN historical and live usage, traffic (download, upload, total bytes), session durations, and daily connection counts per user and across all users.",
    "openvpn",
  ),
  T(
    "list_ovpn_sessions",
    "List Active OpenVPN Connections",
    "Read currently connected OpenVPN users on an explicit router.",
    "openvpn",
  ),
];

const index = buildToolIndex(SAMPLE);

describe("tokenize", () => {
  test("splits snake_case and lowercases", () => {
    expect(tokenize("create_IPv6_Filter_rule")).toEqual(["create", "ipv6", "filter", "rule"]);
  });
});

describe("searchToolIndex", () => {
  test("exact tool name ranks first", () => {
    const hits = searchToolIndex(index, "list_dhcp_leases");
    expect(hits[0]?.name).toBe("list_dhcp_leases");
  });

  test("rare token (wireguard) finds its tool", () => {
    const hits = searchToolIndex(index, "add a wireguard peer");
    expect(hits[0]?.name).toBe("add_wireguard_peer");
  });

  test("natural-language intent maps to the right tool", () => {
    const hits = searchToolIndex(index, "import a TLS certificate");
    expect(hits[0]?.name).toBe("import_certificate");
  });

  test("IPv4 request is NOT shadowed by the IPv6 twin", () => {
    const hits = searchToolIndex(index, "add ipv4 firewall filter rule");
    const v4 = hits.findIndex((h) => h.name === "create_filter_rule");
    const v6 = hits.findIndex((h) => h.name === "create_ipv6_filter_rule");
    expect(v4).toBeGreaterThanOrEqual(0);
    // The generic (IPv4) tool must outrank its IPv6 twin for an IPv4 query.
    expect(v4).toBeLessThan(v6 === -1 ? Number.MAX_SAFE_INTEGER : v6);
  });

  test("IPv6 request prefers the IPv6 tool", () => {
    const hits = searchToolIndex(index, "add ipv6 firewall filter rule");
    expect(hits[0]?.name).toBe("create_ipv6_filter_rule");
  });

  test("empty query returns nothing; limit is respected", () => {
    expect(searchToolIndex(index, "   ")).toEqual([]);
    expect(searchToolIndex(index, "rule", 1).length).toBe(1);
  });

  test("a non-matching query returns no results", () => {
    expect(searchToolIndex(index, "zzzqqq nonsense")).toEqual([]);
  });

  test("OpenVPN usage, bandwidth, and daily accounting queries rank analyze_ovpn_usage first", () => {
    for (const q of [
      "openvpn usage statistics per user",
      "ovpn bandwidth consumption daily",
      "analyze openvpn traffic and session history",
      "openvpn accounting download upload bytes",
    ]) {
      const hits = searchToolIndex(index, q);
      expect(hits[0]?.name).toBe("analyze_ovpn_usage");
    }
  });
});
