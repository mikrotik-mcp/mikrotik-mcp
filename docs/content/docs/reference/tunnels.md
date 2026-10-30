---
title: "Tunnels"
description: "GRE, IPIP, EoIP and VXLAN tunnels (`/interface gre|ipip|eoip|vxlan`)."
---

## Tools

- [Create GRE Tunnel Interface](#create_gre_tunnel)
- [List GRE Tunnel Interfaces](#list_gre_tunnels)
- [Get GRE Tunnel Interface Detail](#get_gre_tunnel)
- [Remove GRE Tunnel Interface](#remove_gre_tunnel)
- [Create IPIP Tunnel Interface](#create_ipip_tunnel)
- [List IPIP Tunnel Interfaces](#list_ipip_tunnels)
- [Get IPIP Tunnel Interface Detail](#get_ipip_tunnel)
- [Remove IPIP Tunnel Interface](#remove_ipip_tunnel)
- [Create EoIP Tunnel Interface](#create_eoip_tunnel)
- [List EoIP Tunnel Interfaces](#list_eoip_tunnels)
- [Get EoIP Tunnel Interface Detail](#get_eoip_tunnel)
- [Remove EoIP Tunnel Interface](#remove_eoip_tunnel)
- [Create VXLAN Tunnel Interface](#create_vxlan_tunnel)
- [List VXLAN Tunnel Interfaces](#list_vxlan_tunnels)
- [Get VXLAN Tunnel Interface Detail](#get_vxlan_tunnel)
- [Remove VXLAN Tunnel Interface](#remove_vxlan_tunnel)

## create_gre_tunnel

**Create GRE Tunnel Interface** · Risk: **write**

Creates an IPv4 GRE (Generic Routing Encapsulation) L3 tunnel interface (`/interface gre`). Use to encapsulate routed traffic between two endpoints for site-to-site connectivity when IPsec encryption is not needed. GRE is L3-only and not bridgeable; for bridgeable L2 Ethernet-over-IP tunnels use create_eoip_tunnel; for raw IP-in-IP with less overhead use create_ipip_tunnel; for L2 VXLAN overlays use create_vxlan_tunnel; for VPN client interfaces use create_l2tp_client, create_pptp_client, create_sstp_client, or create_ovpn_client. Keepalive format: '<interval>,<retries>', e.g. '10s,3'. Returns the created interface detail including name, remote-address, and run-time status.

| Parameter         | Required | Definition                                                                                     |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`            | Yes      | Name for the new GRE tunnel interface, e.g. 'gre-to-hq' `{"type":"string","pattern":"^\\S+$"}` |
| `remote_address`  | Yes      | Remote endpoint IP address `{"type":"string"}`                                                 |
| `local_address`   | No       | Local endpoint IP address `{"type":"string"}`                                                  |
| `keepalive`       | No       | Keepalive interval/retries, e.g. '10s,3' `{"type":"string"}`                                   |
| `dont_fragment`   | No       | Don't-fragment behavior `{"type":"string","enum":["inherit","no"]}`                            |
| `clamp_tcp_mss`   | No       | Clamp TCP MSS to the tunnel MTU `{"type":"boolean"}`                                           |
| `allow_fast_path` | No       | Allow FastPath processing for this tunnel `{"type":"boolean"}`                                 |
| `ipsec_secret`    | No       | Pre-shared key to auto-create an IPsec policy securing the tunnel `{"type":"string"}`          |
| `dscp`            | No       | DSCP for encapsulated packets: 'inherit' or 0-63 `{"type":"string"}`                           |
| `mtu`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                    |
| `comment`         | No       | `{"type":"string"}`                                                                            |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                           |

## list_gre_tunnels

**List GRE Tunnel Interfaces** · Risk: **read**

Lists all GRE tunnel interfaces (`/interface gre print`). Use to inventory or audit existing GRE tunnels and their remote endpoints. Supports optional partial name filter via name_filter. For full detail on one tunnel use get_gre_tunnel; for IPIP tunnels use list_ipip_tunnels; for EoIP tunnels use list_eoip_tunnels; for VXLAN use list_vxlan_tunnels. Returns name, remote-address, local-address, MTU, and run-time status for each interface.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_gre_tunnel

**Get GRE Tunnel Interface Detail** · Risk: **read**

Fetches full detail for a single GRE tunnel interface by name (`/interface gre print detail where name=...`). Use to inspect all parameters of one tunnel — remote-address, local-address, keepalive, MTU, dont-fragment, and status. For a summary list of all GRE tunnels use list_gre_tunnels. For IPIP detail use get_ipip_tunnel; for EoIP detail use get_eoip_tunnel; for VXLAN detail use get_vxlan_tunnel. Returns the complete property set for the named interface, or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_gre_tunnel

**Remove GRE Tunnel Interface** · Risk: **destructive**

Permanently deletes a GRE tunnel interface by name (`/interface gre remove [find name=...]`). Verifies existence via count-only before removal and returns a not-found message if the interface does not exist. This is destructive and immediately disconnects any traffic using the tunnel. For IPIP removal use remove_ipip_tunnel; for EoIP use remove_eoip_tunnel; for VXLAN use remove_vxlan_tunnel.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_ipip_tunnel

**Create IPIP Tunnel Interface** · Risk: **write**

Creates an IPv4 IPIP (IP-in-IP) L3 tunnel interface (`/interface ipip`). Use for lightweight point-to-point IP encapsulation with minimal overhead when GRE's extra header byte is undesirable. IPIP is L3-only and not bridgeable; for GRE encapsulation (with dont-fragment support) use create_gre_tunnel; for L2 Ethernet-over-IP tunnels use create_eoip_tunnel; for VXLAN L2 overlays use create_vxlan_tunnel. Keepalive format: '<interval>,<retries>', e.g. '10s,3'. Returns the created interface detail including name, remote-address, and run-time status.

| Parameter         | Required | Definition                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`            | Yes      | Name for the new IPIP tunnel interface, e.g. 'ipip-to-hq' `{"type":"string","pattern":"^\\S+$"}` |
| `remote_address`  | Yes      | Remote endpoint IP address `{"type":"string"}`                                                   |
| `local_address`   | No       | Local endpoint IP address `{"type":"string"}`                                                    |
| `keepalive`       | No       | Keepalive interval/retries, e.g. '10s,3' `{"type":"string"}`                                     |
| `dont_fragment`   | No       | Don't-fragment behavior `{"type":"string","enum":["inherit","no"]}`                              |
| `clamp_tcp_mss`   | No       | Clamp TCP MSS to the tunnel MTU `{"type":"boolean"}`                                             |
| `allow_fast_path` | No       | Allow FastPath processing for this tunnel `{"type":"boolean"}`                                   |
| `ipsec_secret`    | No       | Pre-shared key to auto-create an IPsec policy securing the tunnel `{"type":"string"}`            |
| `dscp`            | No       | DSCP for encapsulated packets: 'inherit' or 0-63 `{"type":"string"}`                             |
| `mtu`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                      |
| `comment`         | No       | `{"type":"string"}`                                                                              |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                             |

## list_ipip_tunnels

**List IPIP Tunnel Interfaces** · Risk: **read**

Lists all IPIP tunnel interfaces (`/interface ipip print`). Use to inventory existing IPIP tunnels and their remote endpoints. Supports optional partial name filter via name_filter. For full detail on one tunnel use get_ipip_tunnel; for GRE tunnels use list_gre_tunnels; for EoIP tunnels use list_eoip_tunnels; for VXLAN use list_vxlan_tunnels. Returns name, remote-address, local-address, MTU, and run-time status for each interface.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_ipip_tunnel

**Get IPIP Tunnel Interface Detail** · Risk: **read**

Fetches full detail for a single IPIP tunnel interface by name (`/interface ipip print detail where name=...`). Use to inspect all parameters of one tunnel — remote-address, local-address, keepalive, MTU, and status. For a summary list of all IPIP tunnels use list_ipip_tunnels. For GRE detail use get_gre_tunnel; for EoIP detail use get_eoip_tunnel; for VXLAN detail use get_vxlan_tunnel. Returns the complete property set for the named interface, or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_ipip_tunnel

**Remove IPIP Tunnel Interface** · Risk: **destructive**

Permanently deletes an IPIP tunnel interface by name (`/interface ipip remove [find name=...]`). Verifies existence via count-only before removal and returns a not-found message if the interface does not exist. This is destructive and immediately disconnects any traffic using the tunnel. For GRE removal use remove_gre_tunnel; for EoIP use remove_eoip_tunnel; for VXLAN use remove_vxlan_tunnel.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_eoip_tunnel

**Create EoIP Tunnel Interface** · Risk: **write**

Creates an EoIP (Ethernet over IP) L2 tunnel interface (`/interface eoip`). Use when you need a bridgeable L2 link between two MikroTik devices — traffic appears as raw Ethernet frames over IP. Each tunnel requires a unique tunnel_id (0-65535) that must match identically on both peers; mismatched IDs are the most common misconfiguration. EoIP is MikroTik-proprietary — both endpoints must run RouterOS. For L3-only encapsulation use create_gre_tunnel or create_ipip_tunnel; for open-standard L2 overlays use create_vxlan_tunnel. Keepalive format: '<interval>,<retries>', e.g. '10s,3'. Returns the created interface detail including name, remote-address, tunnel-id, and run-time status.

| Parameter         | Required | Definition                                                                                                                                      |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | Name for the new EoIP tunnel interface, e.g. 'eoip-to-hq' `{"type":"string","pattern":"^\\S+$"}`                                                |
| `remote_address`  | Yes      | Remote endpoint IP address `{"type":"string"}`                                                                                                  |
| `tunnel_id`       | Yes      | Unique tunnel ID, must match on both peers `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                          |
| `local_address`   | No       | Local endpoint IP address `{"type":"string"}`                                                                                                   |
| `keepalive`       | No       | Keepalive interval/retries, e.g. '10s,3' `{"type":"string"}`                                                                                    |
| `dont_fragment`   | No       | Don't-fragment behavior `{"type":"string","enum":["inherit","no"]}`                                                                             |
| `clamp_tcp_mss`   | No       | Clamp TCP MSS to the tunnel MTU `{"type":"boolean"}`                                                                                            |
| `allow_fast_path` | No       | Allow FastPath processing for this tunnel `{"type":"boolean"}`                                                                                  |
| `ipsec_secret`    | No       | Pre-shared key to auto-create an IPsec policy securing the tunnel `{"type":"string"}`                                                           |
| `dscp`            | No       | DSCP for encapsulated packets: 'inherit' or 0-63 `{"type":"string"}`                                                                            |
| `mac_address`     | No       | MAC address of the EoIP interface `{"type":"string"}`                                                                                           |
| `arp`             | No       | Address Resolution Protocol mode for the interface `{"type":"string","enum":["disabled","enabled","local-proxy-arp","proxy-arp","reply-only"]}` |
| `arp_timeout`     | No       | ARP entry timeout, e.g. '30s' or 'auto' `{"type":"string"}`                                                                                     |
| `mtu`             | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                     |
| `comment`         | No       | `{"type":"string"}`                                                                                                                             |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                                                                            |

## list_eoip_tunnels

**List EoIP Tunnel Interfaces** · Risk: **read**

Lists all EoIP tunnel interfaces (`/interface eoip print`). Use to inventory existing EoIP tunnels and check their tunnel-id assignments to detect duplicates or mismatches. Supports optional partial name filter via name_filter. For full detail on one tunnel use get_eoip_tunnel; for GRE tunnels use list_gre_tunnels; for IPIP tunnels use list_ipip_tunnels; for VXLAN use list_vxlan_tunnels. Returns name, remote-address, tunnel-id, MTU, and run-time status for each interface.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_eoip_tunnel

**Get EoIP Tunnel Interface Detail** · Risk: **read**

Fetches full detail for a single EoIP tunnel interface by name (`/interface eoip print detail where name=...`). Use to inspect the tunnel-id, remote-address, local-address, keepalive, MTU, and status of one tunnel. For a summary list of all EoIP tunnels use list_eoip_tunnels. For GRE detail use get_gre_tunnel; for IPIP detail use get_ipip_tunnel; for VXLAN detail use get_vxlan_tunnel. Returns the complete property set for the named interface, or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_eoip_tunnel

**Remove EoIP Tunnel Interface** · Risk: **destructive**

Permanently deletes an EoIP tunnel interface by name (`/interface eoip remove [find name=...]`). Verifies existence via count-only before removal and returns a not-found message if the interface does not exist. This is destructive and immediately severs the L2 bridge link using this tunnel. For GRE removal use remove_gre_tunnel; for IPIP use remove_ipip_tunnel; for VXLAN use remove_vxlan_tunnel.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_vxlan_tunnel

**Create VXLAN Tunnel Interface** · Risk: **write**

Creates a VXLAN (Virtual Extensible LAN) L2 overlay interface (`/interface vxlan`). Use to build scalable L2 overlays across L3 networks — the VNI (VXLAN Network Identifier) scopes the broadcast domain, suited for multi-tenant or data-centre scenarios. VXLAN is an open standard and works with non-MikroTik peers; for MikroTik-proprietary L2 tunnels use create_eoip_tunnel; for L3-only encapsulation use create_gre_tunnel or create_ipip_tunnel. UDP port defaults to 8472; VNI must match on all participating VTEPs. Returns the created interface detail including name, VNI, port, and run-time status.

| Parameter          | Required | Definition                                                                                                                                      |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | Yes      | Name for the new VXLAN interface, e.g. 'vxlan1' `{"type":"string","pattern":"^\\S+$"}`                                                          |
| `vni`              | Yes      | VXLAN Network Identifier (VNI) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                      |
| `port`             | Yes      | UDP port (default 8472) `{"default":8472,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                              |
| `local_address`    | No       | Local source IP address `{"type":"string"}`                                                                                                     |
| `interface`        | No       | Source interface `{"type":"string"}`                                                                                                            |
| `group`            | No       | Multicast group address for broadcast/unknown-unicast flooding `{"type":"string"}`                                                              |
| `vteps_ip_version` | No       | IP version used for VTEP addressing `{"type":"string","enum":["ipv4","ipv6"]}`                                                                  |
| `mac_address`      | No       | MAC address of the VXLAN interface `{"type":"string"}`                                                                                          |
| `arp`              | No       | Address Resolution Protocol mode for the interface `{"type":"string","enum":["disabled","enabled","local-proxy-arp","proxy-arp","reply-only"]}` |
| `arp_timeout`      | No       | ARP entry timeout, e.g. '30s' or 'auto' `{"type":"string"}`                                                                                     |
| `max_fdb_size`     | No       | Maximum forwarding database (FDB) size `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                              |
| `allow_fast_path`  | No       | Allow FastPath processing for this interface `{"type":"boolean"}`                                                                               |
| `mtu`              | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                     |
| `comment`          | No       | `{"type":"string"}`                                                                                                                             |
| `disabled`         | Yes      | `{"default":false,"type":"boolean"}`                                                                                                            |

## list_vxlan_tunnels

**List VXLAN Tunnel Interfaces** · Risk: **read**

Lists all VXLAN interfaces (`/interface vxlan print`). Use to inventory existing VXLAN overlays and check their VNI and UDP port assignments. Supports optional partial name filter via name_filter. For full detail on one interface use get_vxlan_tunnel; for EoIP tunnels use list_eoip_tunnels; for GRE tunnels use list_gre_tunnels; for IPIP tunnels use list_ipip_tunnels. Returns name, VNI, port, local-address, MTU, and run-time status for each interface.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_vxlan_tunnel

**Get VXLAN Tunnel Interface Detail** · Risk: **read**

Fetches full detail for a single VXLAN interface by name (`/interface vxlan print detail where name=...`). Use to inspect the VNI, UDP port, local-address, source interface, MTU, and status of one VXLAN interface. For a summary list of all VXLAN interfaces use list_vxlan_tunnels. For EoIP detail use get_eoip_tunnel; for GRE detail use get_gre_tunnel; for IPIP detail use get_ipip_tunnel. Returns the complete property set for the named interface, or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## remove_vxlan_tunnel

**Remove VXLAN Tunnel Interface** · Risk: **destructive**

Permanently deletes a VXLAN interface by name (`/interface vxlan remove [find name=...]`). Verifies existence via count-only before removal and returns a not-found message if the interface does not exist. This is destructive and immediately severs all L2 overlay traffic using this VNI endpoint. For EoIP removal use remove_eoip_tunnel; for GRE use remove_gre_tunnel; for IPIP use remove_ipip_tunnel.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |
