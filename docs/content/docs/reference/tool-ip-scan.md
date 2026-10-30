---
title: "IP Scan"
description: "Discover live hosts on a range or interface (`/tool ip-scan`)."
---

## Tools

- [Scan IPv4 Range for Live Hosts](#ip_scan)

## ip_scan

**Scan IPv4 Range for Live Hosts** · Risk: **read**

Actively probe an IPv4 address range or an interface's connected subnet for live hosts (`/tool ip-scan`). Use this to discover which IPv4 addresses are reachable — the router sends active probes and collects responding hosts' IP addresses, MAC addresses, round-trip times, and reverse-DNS names. This is an active network scan, not a passive table read. This server does not expose an IPv6 scan tool; for IPv6 neighbor-cache entries consult the IPv6 neighbor table tools (`list_ipv6_neighbors`, `get_ipv6_neighbor`). Returns a list of discovered live hosts (address, MAC, latency, DNS name), or a notice that no hosts were found. At least one of `address_range` or `interface` is required; both may be provided together. `address_range` accepts a CIDR or range string (e.g. '192.168.1.0/24'); `interface` names the interface whose connected subnet is scanned (e.g. 'ether1'); `duration` (default 5) bounds the scan run in seconds.

| Parameter       | Required | Definition                                                                                                        |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `address_range` | No       | Range/CIDR to scan, e.g. '192.168.1.0/24' `{"type":"string"}`                                                     |
| `interface`     | No       | Scan the subnet on this interface, e.g. 'ether1' `{"type":"string"}`                                              |
| `duration`      | Yes      | Scan duration in seconds (bounds the run) `{"default":5,"type":"integer","minimum":1,"maximum":9007199254740991}` |
