---
title: "Prompt catalog"
description: "42 guided workflows and their supported arguments, generated from the prompt loader."
---

Select a workflow in your MCP client's prompt picker, supply its arguments, then review the assistant's plan. A prompt guides an LLM; it does not grant permission, guarantee rollback or bypass tool access controls. Confirm risky changes and verify their results. [Authoring and invocation](/docs/guides/prompts).

## audit-routeros-containers

**Audit RouterOS container readiness and isolation**

Read-only container architecture, storage, lifecycle, network policy and security audit with an evidence-based cleanup plan.

| Argument       | Required | Purpose                                               |
| -------------- | -------- | ----------------------------------------------------- |
| `device`       | No       | Exact configured router; omit to discover and ask.    |
| `requirements` | No       | Intended workloads, trusted clients and restrictions. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/audit-routeros-containers.md).

## audit-security-posture

**Run a compliance security audit**

Comprehensive security audit across SSH, services, firewall, users, DNS, certificates, SNMP, hardening, and VPN — scored A+ through F with actionable fix commands.

| Argument     | Required | Purpose                                                                                                         |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| `categories` | No       | Comma-separated categories to audit (e.g. "ssh,firewall,users"). Omit for a full audit across all 9 categories. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/audit-security-posture.md).

## audit-vlan-segmentation

**Audit VLAN isolation and migration readiness**

Read-only topology, IPv4/IPv6 isolation and management-path review with a prioritized cleanup plan; never applies changes.

| Argument       | Required | Purpose                                                                                                                                  |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `requirements` | No       | Desired zones, allowed services, remote sites and constraints. If omitted, discover facts and ask about policy rather than inventing it. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/audit-vlan-segmentation.md).

## backup-and-document

**Back up and document the configuration**

Create a safe restore point and produce a human-readable inventory of the router's configuration.

No required workflow arguments.

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/backup-and-document.md).

## build-tunnel-transactionally

**Build a site-to-site tunnel as one cross-device transaction**

Preferred coordinated workflow for both ends of an approved site-to-site tunnel — stage, verify, then commit with explicit approval; partial commits require manual recovery.

| Argument | Required | Purpose                                                                                                                                    |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `site_a` | Yes      | Configured device name of the first router (one end of the tunnel).                                                                        |
| `site_b` | Yes      | Configured device name of the second router (the other end).                                                                               |
| `tunnel` | No       | What to build (e.g. "WireGuard 10.99.0.0/30", "GRE over the existing WAN", "IPsec site-to-site"). If omitted, WireGuard is a good default. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/build-tunnel-transactionally.md).

## choose-vpn-solution

**Choose the right MikroTik VPN**

Recommend the best MikroTik VPN/tunnel technology for a given requirement, then outline the build.

| Argument   | Required | Purpose                                                                                                                                                                       |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use_case` | Yes      | What you need — e.g. "connect two offices", "remote access for laptops & phones", "site-to-site over the internet with another vendor's firewall", "L2 bridge between sites". |
| `clients`  | No       | What connects — e.g. "iOS/Android/Windows built-in clients", "other MikroTik routers", "a Cisco/Fortinet device", "our laptops only". Optional.                               |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/choose-vpn-solution.md).

## design-qos-policy

**Design a traffic shaping policy**

Build a QoS queue hierarchy from business requirements — define traffic classes, priorities, and bandwidth guarantees with preview before apply.

| Argument        | Required | Purpose                                                                                                                                                         |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wan_bandwidth` | Yes      | WAN bandwidth in download/upload format (e.g. "100M/50M", "1G/1G").                                                                                             |
| `classes`       | No       | Describe traffic classes and priorities (e.g. "VoIP=highest, video conferencing=high, web=normal, bulk downloads=low"). If omitted, a sensible default is used. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/design-qos-policy.md).

## detect-config-drift

**Detect and resolve config drift**

Compare live router config against a golden baseline, identify who changed what and when, then roll back or accept the drift.

| Argument | Required | Purpose                                                                                                                                    |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `action` | No       | What to do — "check" (detect drift), "reconcile" (roll back to baseline), or "promote" (accept drift as new baseline). Default is "check". |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/detect-config-drift.md).

## diagnose-connectivity

**Diagnose a connectivity problem**

Systematically troubleshoot why a host, subnet, or the internet is unreachable from a MikroTik router.

| Argument           | Required | Purpose                                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------------------------- |
| `target`           | Yes      | What's unreachable — an IP, hostname, or subnet (e.g. 8.8.8.8, example.com, 192.168.50.0/24). |
| `source_interface` | No       | The interface/segment the affected clients are on (e.g. bridge, vlan50). Optional.            |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/diagnose-connectivity.md).

## disaster-recovery-drill

**Rehearse a disaster recovery scenario**

Simulate a failure in Safe Mode, verify the backup/restore path works, then auto-revert — proving your DR plan without risk.

| Argument   | Required | Purpose                                                                                                                                                                    |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenario` | No       | What failure to simulate (e.g. "lose WAN interface", "delete all firewall rules", "disable OSPF", "remove default route"). If omitted, a sensible scenario will be chosen. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/disaster-recovery-drill.md).

## fleet-health-check

**Fleet-wide health and compliance sweep**

Check reachability, resource usage, firmware currency, security posture, and config drift across all configured devices.

No required workflow arguments.

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/fleet-health-check.md).

## fleet-rollout

**Roll one change out across the fleet, safely**

Apply the same change to many routers as canary → wave → fleet, with a health gate and soak between waves and automatic revert of everything already changed on the first failure.

| Argument  | Required | Purpose                                                                                                                                                      |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `change`  | Yes      | What to change on every device (e.g. "set the NTP servers to 10.0.0.1 and 10.0.0.2", "add the management address-list entry", "disable the telnet service"). |
| `targets` | No       | Which devices — a list of names, "all", or a tag (e.g. "branch"). If omitted, ask before selecting anything.                                                 |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/fleet-rollout.md).

## harden-against-bruteforce

**Harden a router under SSH/Telnet brute-force attack**

Stop an active SSH/Telnet/Winbox brute-force flood on a MikroTik — block the attacking IPs, install an auto-ban ladder + management lock-down, disable telnet — WITHOUT locking the operator out (trusted-IP gate, snapshot, Safe Mode, preview-then-confirm), then check for a compromised admin account.

| Argument            | Required | Purpose                                                                                                                                                                                                                             |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device`            | No       | Which configured device is under attack (config key or label from list_mikrotik_devices). Omit to discover and choose.                                                                                                              |
| `management_ip`     | No       | The IP or CIDR you manage this router from (e.g. 203.0.113.5 or 203.0.113.0/24). This is the anti-lockout gate — it is accepted before any drop. Omit and you will be asked; never proceed without it.                              |
| `attacker_ips`      | No       | Comma-separated source IPs already known to be attacking (optional). Leave empty — this workflow reads the device's own error/critical/security logs and extracts the attacking IPs itself; anything you pass here is added on top. |
| `trusted_list_name` | No       | Name of the existing trusted/management address-list on this device (e.g. Trust-IP). Omit to use/create a list named "trusted".                                                                                                     |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/harden-against-bruteforce.md).

## harden-router

**Harden a RouterOS device**

Audit and tighten a MikroTik router's security posture — management services, firewall input chain, users, and DNS.

| Argument        | Required | Purpose                                                                                 |
| --------------- | -------- | --------------------------------------------------------------------------------------- |
| `wan_interface` | No       | The WAN-facing interface name (e.g. ether1, pppoe-out1). If unknown, discover it first. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/harden-router.md).

## manage-certificates

**Manage TLS certificates and Let's Encrypt**

Audit certificate expiry, issue or renew Let's Encrypt certificates via ACME, and deploy them to services.

| Argument | Required | Purpose                                                                                                                       |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `domain` | No       | Domain name for Let's Encrypt issuance (e.g. "router.example.com"). Required for issuing new certificates.                    |
| `action` | No       | What to do — "audit" (check expiry), "issue" (new Let's Encrypt cert), or "renew" (renew expiring certs). Default is "audit". |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/manage-certificates.md).

## safe-change-workflow

**Safe change workflow (snapshot → plan → verify)**

Take a local restore point, dry-run a change, apply it safely, and confirm exactly what changed — with zero footprint on the device's disk.

| Argument | Required | Purpose                                                                                        |
| -------- | -------- | ---------------------------------------------------------------------------------------------- |
| `intent` | No       | What you want to change, in plain language (e.g. "add a drop rule for inbound WAN on ether1"). |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/safe-change-workflow.md).

## security-hardening-sweep

**Security hardening sweep (pick device → audit → fix by finding)**

Discover the configured MikroTik devices, let the user choose which one to harden, then run the granular Security Hardening suite — per-category, evidence-based findings with a stable finding_id — and remediate only the findings the user approves, safely (snapshot + Safe Mode).

| Argument     | Required | Purpose                                                                                                                                                                                                                                        |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device`     | No       | Which configured device to harden (its config key or friendly label from list_mikrotik_devices). Omit to discover the devices and let the user choose.                                                                                         |
| `categories` | No       | Comma-separated category slugs to scope the sweep (e.g. "firewall_default_deny,dns_resolver_exposure"). Omit to let the user pick a hardening goal (All / DDoS / port-scanning / remote-management / …), which you translate into these slugs. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/security-hardening-sweep.md).

## setup-bgp-peering

**Set up BGP peering**

Configure a BGP connection to a peer — upstream provider, IX, or another router — with templates, filters, and session verification.

| Argument       | Required | Purpose                                                                                 |
| -------------- | -------- | --------------------------------------------------------------------------------------- |
| `peer_address` | Yes      | Neighbor IP address (e.g. "198.51.100.1").                                              |
| `remote_as`    | Yes      | Peer AS number (e.g. "65000").                                                          |
| `local_as`     | No       | Local AS number. If omitted, defaults to the existing BGP AS or the router-id-based AS. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-bgp-peering.md).

## setup-eoip-tunnel-between-sites

**Build an EoIP (Layer-2) tunnel between two MikroTik devices**

Configure BOTH routers of an EoIP site-to-site tunnel — a bridgeable Ethernet-over-IP link that puts two sites on the SAME L2 broadcast domain — with matching tunnel-id, bridging, MTU/MSS, and (recommended) IPsec encryption, then verify. Includes DPI/censorship-bypass notes.

| Argument    | Required | Purpose                                                                                                         |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `device_a`  | No       | First configured device (config key or label from list_mikrotik_devices), e.g. site-a.                          |
| `device_b`  | No       | Second configured device, e.g. site-b.                                                                          |
| `tunnel_id` | No       | EoIP tunnel ID (0–65535). MUST be identical on both peers and unique per EoIP tunnel. Omit to let you pick one. |
| `encrypt`   | No       | Secure EoIP with IPsec (shared secret). Recommended — EoIP is cleartext. "yes" (default) or "no".               |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-eoip-tunnel-between-sites.md).

## setup-gre-tunnel-between-sites

**Build a GRE tunnel between two MikroTik devices**

Configure BOTH routers of a GRE site-to-site tunnel from one conversation — endpoints, addressing, routing, MTU/MSS, and (strongly recommended) IPsec encryption — then verify end to end. Includes DPI/censorship-bypass transport options.

| Argument        | Required | Purpose                                                                                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_a`      | No       | First configured device (config key or label from list_mikrotik_devices), e.g. site-a.                                                                  |
| `device_b`      | No       | Second configured device, e.g. site-b.                                                                                                                  |
| `tunnel_subnet` | No       | Small transit subnet for the GRE link itself in CIDR, e.g. 10.255.255.0/30 (A=.1, B=.2). Omit to let you pick one that doesn't collide with either LAN. |
| `encrypt`       | No       | Whether to secure GRE with IPsec (a shared secret). Strongly recommended — GRE alone is cleartext. "yes" (default) or "no".                             |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-gre-tunnel-between-sites.md).

## setup-guest-wifi

**Set up an isolated guest network**

Create a segmented guest VLAN/network with its own DHCP, internet access, and isolation from the LAN.

| Argument        | Required | Purpose                                                                     |
| --------------- | -------- | --------------------------------------------------------------------------- |
| `subnet`        | Yes      | The guest subnet in CIDR, e.g. 192.168.80.0/24.                             |
| `vlan_id`       | No       | VLAN ID for the guest segment, e.g. 80. Optional if using a flat interface. |
| `wan_interface` | Yes      | The interface that reaches the internet (for the masquerade rule).          |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-guest-wifi.md).

## setup-hotspot

**Build a captive portal hotspot**

Deploy a complete guest hotspot with captive portal, DHCP, per-user bandwidth limits, and optional voucher codes.

| Argument    | Required | Purpose                                                                                                    |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `interface` | Yes      | The interface for the hotspot (e.g. "wlan1", "ether5", "vlan-guest"). This is where guest clients connect. |
| `dns_name`  | No       | DNS name for the captive portal (e.g. "hotspot.local"). Optional.                                          |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-hotspot.md).

## setup-ipip-tunnel-between-sites

**Build an IPIP tunnel between two MikroTik devices**

Configure BOTH routers of an IP-in-IP (IPIP) site-to-site tunnel from one conversation — endpoints, addressing, routing, MTU/MSS, and (recommended) IPsec encryption — then verify end to end. Includes DPI/censorship-bypass notes.

| Argument        | Required | Purpose                                                                                                                                             |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_a`      | No       | First configured device (config key or label from list_mikrotik_devices), e.g. site-a.                                                              |
| `device_b`      | No       | Second configured device, e.g. site-b.                                                                                                              |
| `tunnel_subnet` | No       | Small transit subnet for the tunnel link in CIDR, e.g. 10.255.255.0/30 (A=.1, B=.2). Omit to let you pick one that doesn't collide with either LAN. |
| `encrypt`       | No       | Secure IPIP with IPsec (shared secret). Recommended — IPIP is cleartext. "yes" (default) or "no".                                                   |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-ipip-tunnel-between-sites.md).

## setup-ipsec-site-to-site

**Build an IPsec IKEv2 site-to-site tunnel**

Stand up an interoperable IPsec IKEv2 tunnel between this router and a remote site/peer.

| Argument        | Required | Purpose                                                               |
| --------------- | -------- | --------------------------------------------------------------------- |
| `local_subnet`  | Yes      | The local network behind this router, in CIDR (e.g. 192.168.10.0/24). |
| `remote_subnet` | Yes      | The remote network behind the peer, in CIDR (e.g. 192.168.20.0/24).   |
| `peer_address`  | Yes      | The public IP / hostname of the remote peer.                          |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-ipsec-site-to-site.md).

## setup-l2tp-ipsec-roadwarrior

**Set up L2TP/IPsec remote access (road warrior)**

Configure an L2TP-over-IPsec server so laptops and phones can connect with their built-in VPN client.

| Argument        | Required | Purpose                                                                                      |
| --------------- | -------- | -------------------------------------------------------------------------------------------- |
| `vpn_pool`      | Yes      | The address range handed to VPN clients, e.g. 192.168.89.10-192.168.89.254.                  |
| `local_gateway` | Yes      | The router's address on the VPN/LAN side that clients use as gateway/DNS, e.g. 192.168.89.1. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-l2tp-ipsec-roadwarrior.md).

## setup-multi-wan

**Set up multi-WAN failover or load balancing**

Configure resilient multi-WAN with health-checked active-passive failover or ECMP load balancing across two or more uplinks.

| Argument         | Required | Purpose                                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `wan_interfaces` | Yes      | Comma-separated WAN interface names (e.g. "ether1,ether2" or "ether1,lte1").                     |
| `mode`           | No       | failover" for active-passive with health checks, or "loadbalance" for ECMP. Default is failover. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-multi-wan.md).

## setup-openvpn-tunnel-between-sites

**Build an OpenVPN (TLS) tunnel between two MikroTik devices**

Configure a MikroTik-to-MikroTik OpenVPN site-to-site link — certificates, PPP profile + secret, server + client, L3 (ip) or L2 (ethernet) mode, routing, firewall — over TCP/UDP 443 for HTTPS-like camouflage. Verified end to end, with DPI/censorship-bypass guidance.

| Argument        | Required | Purpose                                                                                                                                 |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server_device` | No       | The device that will run the OpenVPN SERVER — reachable public IP/DDNS + a certificate. Config key or label from list_mikrotik_devices. |
| `client_device` | No       | The device that will run the OpenVPN CLIENT (may be behind NAT). Config key or label.                                                   |
| `mode`          | No       | Tunnel mode — "ip" (L3 routed, default) or "ethernet" (L2 TAP, bridgeable across sites). Omit for ip.                                   |
| `protocol`      | No       | Transport — "tcp" (works with 443 camouflage, survives more DPI) or "udp" (faster). Omit for tcp when bypassing blocks, udp otherwise.  |
| `port`          | No       | Port for OpenVPN. 1194 is default; use 443 to look like HTTPS through restrictive networks. Omit for 1194.                              |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-openvpn-tunnel-between-sites.md).

## setup-ospf-peering

**Set up OSPF dynamic routing**

Configure OSPF instances, areas, and interface templates for dynamic route exchange between MikroTik routers.

| Argument     | Required | Purpose                                                                                                      |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `router_id`  | Yes      | The OSPF router ID for this device (e.g. "10.0.0.1"). Typically a loopback or management IP.                 |
| `area`       | No       | OSPF area ID (e.g. "0.0.0.0" for backbone, "0.0.0.1" for a stub area). Default is backbone.                  |
| `interfaces` | No       | Which interfaces to run OSPF on (comma-separated, e.g. "ether1,ether2,bridge"). If omitted, you'll be asked. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-ospf-peering.md).

## setup-port-knocking

**Hide management behind port knocking**

Conceal SSH/Winbox/API behind a secret port-knock sequence that temporarily opens access from the knocking IP.

| Argument      | Required | Purpose                                                                                                   |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `services`    | No       | Which services to protect (comma-separated, e.g. "ssh,winbox,api"). Default is SSH and Winbox.            |
| `knock_ports` | No       | Comma-separated port sequence for the knock (e.g. "1234,5678,9012"). If omitted, random ports are chosen. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-port-knocking.md).

## setup-port-scan-detection

**Set up port-scan detection (detect + tag, never block)**

Pick a device, present the six port-scan signatures, let the user choose which to enable, validate the trust list, then install them into a trust-excluding detect-portscan jump-gate — snapshotted and applied under Safe Mode. Detects and tags scanners; never blocks.

| Argument            | Required | Purpose                                                                                                                                                                                                |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `device`            | No       | Which configured device to protect (config key or label from list_mikrotik_devices). Omit to discover the devices and let the user choose.                                                             |
| `trusted_list_name` | No       | The existing management/trusted address-list on that device (e.g. Trust-IP). Omit to discover it and confirm with the user — it must already exist and contain the address you manage the device from. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-port-scan-detection.md).

## setup-routeros-container

**Plan and safely deploy a RouterOS container**

Version-aware image, storage, isolated VETH network and lifecycle workflow with explicit approval and application verification.

| Argument       | Required | Purpose                                                                      |
| -------------- | -------- | ---------------------------------------------------------------------------- |
| `device`       | No       | Exact configured router; omit to discover and ask.                           |
| `image`        | No       | Reviewed image and pinned version/digest, or uploaded image archive.         |
| `requirements` | No       | Application, client access, ports, persistent data and downtime constraints. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-routeros-container.md).

## setup-sstp-tunnel-between-sites

**Build an SSTP (TLS/443) tunnel between two MikroTik devices**

Configure a MikroTik-to-MikroTik SSTP site-to-site link — server certificate, PPP profile + secret, client, routing, firewall — over TCP 443 so it looks like HTTPS. The go-to transport for bypassing VPN blocks / DPI. Verified end to end.

| Argument        | Required | Purpose                                                                                                                                                           |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server_device` | No       | The device that will run the SSTP SERVER — the one with a reachable public IP / DDNS and (ideally) a certificate. Config key or label from list_mikrotik_devices. |
| `client_device` | No       | The device that will run the SSTP CLIENT (may be behind NAT). Config key or label.                                                                                |
| `tunnel_subnet` | No       | Transit subnet for the PPP link, e.g. 10.255.255.0/30 (server=.1 local, client=.2 remote). Omit to let you pick one that collides with neither LAN.               |
| `port`          | No       | TCP port for SSTP. Default and recommended 443 (looks like HTTPS, survives most DPI). Omit for 443.                                                               |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-sstp-tunnel-between-sites.md).

## setup-threat-feeds

**Subscribe to threat intelligence feeds**

Import external threat-intel IP blocklists into firewall address-lists with automatic scheduled updates.

| Argument    | Required | Purpose                                                                                            |
| ----------- | -------- | -------------------------------------------------------------------------------------------------- |
| `feed_url`  | No       | URL of the threat feed (one IP per line). If omitted, a well-known public feed will be suggested.  |
| `list_name` | No       | Firewall address-list name to populate (e.g. "threat-blocklist"). Default is chosen automatically. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-threat-feeds.md).

## setup-traffic-flow

**Set up continuous traffic analytics (NetFlow/IPFIX)**

Enable /ip traffic-flow, point the router at this host's collector, and start answering "who is using my bandwidth" continuously — cheap flow metadata, no packet payload.

| Argument            | Required | Purpose                                                                                                                                           |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collector_address` | No       | The IP address of THIS MCP host as the router sees it (e.g. 192.168.88.50). If omitted, work it out from the router's neighbour/ARP table or ask. |
| `interfaces`        | No       | Which interfaces to sample (e.g. "ether1", "bridge"). Defaults to all.                                                                            |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-traffic-flow.md).

## setup-tunnel-between-sites

**Build a tunnel between two MikroTik devices**

Configure BOTH routers of a site-to-site tunnel from one conversation, then verify it end to end.

| Argument     | Required | Purpose                                                                                                                                                                                                                 |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_a`   | No       | First configured device (config key or label from list_mikrotik_devices), e.g. site-a. Omit to discover and choose.                                                                                                     |
| `device_b`   | No       | Second configured device, e.g. site-b. Omit to discover and choose.                                                                                                                                                     |
| `technology` | No       | Tunnel type — wireguard, ipsec, gre, ipip, eoip, vxlan, sstp, ovpn, or "recommend" to let you choose. For a deep, tech-specific walkthrough use setup-wireguard-tunnel-between-sites or setup-gre-tunnel-between-sites. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-tunnel-between-sites.md).

## setup-v2ray-container-proxy

**Plan a V2Ray/Xray or sing-box container gateway on RouterOS**

Audit prerequisites, then plan an isolated proxy container with explicit approval, dual-stack policy, bounded lifecycle checks and end-to-end verification.

| Argument   | Required | Purpose                                                                |
| ---------- | -------- | ---------------------------------------------------------------------- |
| `device`   | No       | Exact configured router; omit to discover and ask.                     |
| `protocol` | No       | Desired protocol supported by the selected image and remote server.    |
| `image`    | No       | Reviewed architecture-compatible image and pinned version/digest.      |
| `scope`    | No       | Selective destinations or all traffic for explicitly selected clients. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-v2ray-container-proxy.md).

## setup-vlan-network

**Design a safe dual-stack VLAN migration**

Audit the existing topology and plan VLAN ports, SSIDs, management access, IPv4/IPv6 policy and staged verification before any approved change.

| Argument          | Required | Purpose                                                                                                                          |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `vlans`           | Yes      | Describe the VLANs you need — e.g. "management=10, staff=20, IoT=30, guest=40" (name=VLAN-ID).                                   |
| `trunk_interface` | No       | Optional proposed physical trunk. If omitted, discover and confirm the port map; never assume a bridge or WAN port is the trunk. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-vlan-network.md).

## setup-vxlan-tunnel-between-sites

**Build a VXLAN overlay between two (or more) MikroTik devices**

Configure a VXLAN L2 overlay across MikroTik routers — VNI, VTEP peering, bridging, MTU — for multi-site / multi-tenant L2. Honest about RouterOS VTEP tooling limits; recommends EoIP for a simple two-site link.

| Argument   | Required | Purpose                                                                                                         |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `device_a` | No       | First configured device (config key or label from list_mikrotik_devices), e.g. site-a.                          |
| `device_b` | No       | Second configured device, e.g. site-b.                                                                          |
| `vni`      | No       | VXLAN Network Identifier (VNI, 1–16777215). MUST match on every VTEP in this overlay. Omit to let you pick one. |
| `port`     | No       | VXLAN UDP port. Default 8472 (Linux/MikroTik); 4789 is the IANA standard. Pick one that suits the path.         |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-vxlan-tunnel-between-sites.md).

## setup-wireguard-tunnel-between-sites

**Build a WireGuard tunnel between two MikroTik devices**

Configure BOTH routers of a WireGuard site-to-site tunnel from one conversation — keys, peers, addressing, routes, firewall, MTU/MSS — then verify end to end. Includes DPI-resistant / censorship-bypass transport options.

| Argument        | Required | Purpose                                                                                                                                                    |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_a`      | No       | First configured device (config key or label from list_mikrotik_devices), e.g. site-a.                                                                     |
| `device_b`      | No       | Second configured device, e.g. site-b.                                                                                                                     |
| `tunnel_subnet` | No       | Small transit subnet for the tunnel link itself in CIDR, e.g. 10.255.255.0/30 (A=.1, B=.2). Omit to let you pick one that doesn't collide with either LAN. |
| `listen_port`   | No       | UDP port WireGuard listens on. Default 13231. Consider 443/53/500 to survive restrictive networks (see the bypass section).                                |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-wireguard-tunnel-between-sites.md).

## setup-wireguard-vpn

**Set up a WireGuard VPN + first peer**

Stand up a WireGuard server interface on the router and generate a ready-to-use client config for one peer.

| Argument      | Required | Purpose                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `vpn_subnet`  | Yes      | The VPN tunnel subnet in CIDR, e.g. 10.10.0.0/24.                               |
| `endpoint`    | Yes      | The public hostname/IP clients will connect to (your WAN address or DDNS name). |
| `listen_port` | No       | UDP port for WireGuard (default 13231).                                         |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/setup-wireguard-vpn.md).

## troubleshoot-network

**Intelligent root-cause diagnosis**

Autonomously investigate a network problem across connectivity, routing, firewall, NAT, DHCP, DNS, and system resources — ranked hypotheses with fix commands.

| Argument  | Required | Purpose                                                                                                                                                                                 |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `symptom` | Yes      | Describe the problem in plain language (e.g. "users on VLAN 20 can't reach the internet", "BGP session to 10.0.0.1 keeps dropping").                                                    |
| `scope`   | No       | Limit investigation to specific dimensions (comma-separated). Options — connectivity, interfaces, routing, firewall, nat, dhcp, dns, resources, logs, vpn. Omit for full investigation. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/troubleshoot-network.md).

## upgrade-firmware

**Upgrade RouterOS firmware safely**

Check for updates, capture a health baseline, stage packages, and apply the upgrade with automatic rollback on failure.

| Argument  | Required | Purpose                                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------------------------- |
| `channel` | No       | Update channel — "stable", "long-term", or "testing". Default is the device's current channel. |

[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/upgrade-firmware.md).
