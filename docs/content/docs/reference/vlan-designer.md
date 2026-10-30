---
title: "VLAN Designer"
description: "Read VLAN design/safety knowledge and preview partial IPv4 scaffolding; full L2, dual-stack isolation and client verification remain explicit migration work."
---

## Tools

- [Read VLAN Segmentation Knowledge](#get_vlan_segmentation_guide)
- [Preview or Build Partial IPv4 VLAN Scaffolding](#design_network_segment)

## get_vlan_segmentation_guide

**Read VLAN Segmentation Knowledge** · Risk: **read**

Read the RouterOS homelab VLAN design guide before VLAN, guest Wi-Fi, IoT or management-network work. Covers bridge CPU/tagged/untagged/PVID, dual-stack IPv4/IPv6 isolation, SSIDs/CAPsMAN, VPN return routing, Safe Mode/rollback, validation and clean Device/Group/Shared memory. Reference only; no router contact, live audit, memory write or authorization. Select a topic for concise guidance, or all for the full checklist.

| Parameter | Required | Definition                                                                                                             |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `topic`   | Yes      | `{"default":"all","type":"string","enum":["all","overview","discovery","layer2","policy","migration","verification"]}` |

## design_network_segment

**Preview or Build Partial IPv4 VLAN Scaffolding** · Risk: **dangerous**

Preview partial IPv4 VLAN interface/gateway/DHCP scaffolding (apply=false, no router I/O). Read get_vlan_segmentation_guide first. Does NOT produce a complete isolated network. Optional NAT requires explicit wan_interface; isolation drops require a reviewed isolation_before .id. Bridge membership includes the CPU when ports are supplied, but port PVID/admission, filtering, Wi-Fi, INPUT and IPv6 policies remain separate work. apply=true runs sequential non-idempotent writes only after explicit approval, backup and a protected management/Safe Mode plan; failures may leave partial state. Read back and test clients; never retry blindly or claim isolation from command success.

| Parameter          | Required | Definition                                                                                                                                                                                                                                                                                   |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vlan_id`          | Yes      | `{"type":"integer","minimum":1,"maximum":4094}`                                                                                                                                                                                                                                              |
| `name`             | Yes      | Name for the VLAN interface, e.g. 'guest' `{"type":"string","pattern":"^\\S+$"}`                                                                                                                                                                                                             |
| `subnet`           | Yes      | Canonical IPv4 network CIDR, e.g. '192.168.30.0/24' `{"type":"string","format":"cidrv4","pattern":"^((25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\/([0-9]\|[1-2][0-9]\|3[0-2])$"}`                                   |
| `gateway`          | Yes      | Usable router address inside the subnet, excluded from the DHCP pool `{"type":"string","format":"ipv4","pattern":"^(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])$"}`                                            |
| `bridge`           | Yes      | Bridge to put the VLAN on `{"default":"bridge","type":"string"}`                                                                                                                                                                                                                             |
| `tagged_ports`     | No       | Comma-separated verified tagged ports; the bridge/CPU is included once automatically `{"type":"string"}`                                                                                                                                                                                     |
| `untagged_ports`   | No       | Comma-separated access/untagged ports `{"type":"string"}`                                                                                                                                                                                                                                    |
| `dhcp`             | Yes      | Create a DHCP server + pool for the segment `{"default":true,"type":"boolean"}`                                                                                                                                                                                                              |
| `dhcp_range`       | No       | Single start-end IPv4 range excluding gateway/network/broadcast. Required outside /24; /24 defaults to .10–.254 `{"type":"string"}`                                                                                                                                                          |
| `internet`         | Yes      | Add egress-scoped IPv4 masquerade (requires wan_interface); not a firewall allow. Set false to reuse existing NAT `{"default":true,"type":"boolean"}`                                                                                                                                        |
| `wan_interface`    | No       | Verified egress interface for new masquerade. Required when internet=true; never inferred `{"type":"string","minLength":1}`                                                                                                                                                                  |
| `isolate_from`     | No       | Subnets this segment must NOT reach, e.g. ['192.168.1.0/24'] `{"type":"array","items":{"type":"string","format":"cidrv4","pattern":"^((25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\/([0-9]\|[1-2][0-9]\|3[0-2])$"}}` |
| `isolation_before` | No       | Current enabled forward rule .id from a fresh read; insert drops before this reviewed rule, not after broad accepts. Required with isolate_from `{"type":"string","pattern":"^\\*[0-9a-f]+$"}`                                                                                               |
| `apply`            | Yes      | false = preview (default); true = build `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                 |
