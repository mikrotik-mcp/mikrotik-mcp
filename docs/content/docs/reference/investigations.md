---
title: "Client Investigations"
description: "Persistent client/service cases with multi-router evidence, explicit unknowns and next experiments; never equates router ICMP with application health."
---

## Tools

- [Inspect Exported Client Flow Path](#inspect_flow_path)
- [List Recent Client Flow Tuples](#list_client_flow_candidates)
- [Investigate a Client and Service](#create_investigation)
- [List Client Investigations](#list_investigations)
- [Read a Client Investigation](#get_investigation)

## inspect_flow_path

**Inspect Exported Client Flow Path** · Risk: **read**

Read the last five minutes of exact IPv4 TCP/UDP five-tuple NetFlow/IPFIX evidence for the selected router. Reports exporter input/output ifIndex and resolves up to eight explicitly named interfaces with read-only OID queries. Requires a unique configured IPv4 host matching the exporter sender. Never enables capture, changes configuration or generates traffic. Unauthenticated UDP exports, current name mappings and no-match results are not proof of VPN encryption, packet loss or application delivery. NAT aliases are not inferred.

| Parameter          | Required | Definition                                                                                                                                                                   |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`           | Yes      | `{"type":"string","format":"ipv4","pattern":"^(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])$"}` |
| `destination`      | Yes      | `{"type":"string","format":"ipv4","pattern":"^(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])$"}` |
| `source_port`      | Yes      | `{"type":"integer","minimum":1,"maximum":65535}`                                                                                                                             |
| `destination_port` | Yes      | `{"type":"integer","minimum":1,"maximum":65535}`                                                                                                                             |
| `protocol`         | Yes      | `{"type":"string","enum":["tcp","udp"]}`                                                                                                                                     |
| `interface_names`  | Yes      | `{"default":[],"maxItems":8,"type":"array","items":{"type":"string","minLength":1,"maxLength":128}}`                                                                         |

## list_client_flow_candidates

**List Recent Client Flow Tuples** · Risk: **read**

List up to 50 recent exported TCP/UDP tuples originating from an exact client IPv4 on the selected router, including ephemeral source ports, for inspect_flow_path. Reads local NetFlow/IPFIX storage only; does not query the client or router. Requires unambiguous exporter host binding. Missing records do not mean no traffic.

| Parameter | Required | Definition                                                                                                                                                                   |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`  | Yes      | `{"type":"string","format":"ipv4","pattern":"^(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])$"}` |

## create_investigation

**Investigate a Client and Service** · Risk: **write**

Read client DHCP/ARP/bridge evidence and VLAN/interface/DNS/route/firewall/NAT context from the selected router and up to two explicit additional routers. Run three router-originated ICMP probes and save a local case. Never changes router configuration or starts captures. WRITE reflects local persistence. Application health remains UNVERIFIED; no endpoint probe is installed. IPv4 or colon-separated MAC clients only. Returns JSON evidence with timestamps, unknowns and next tests.

| Parameter         | Required | Definition                                                                                                                                                                                                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`          | Yes      | `{"anyOf":[{"type":"string","format":"ipv4","pattern":"^(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])\\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9][0-9]\|[1-9][0-9]\|[0-9])$"},{"type":"string","pattern":"^(?:[\\da-f]{2}:){5}[\\da-f]{2}$"}]}` |
| `target`          | Yes      | `{"type":"string","minLength":1,"maxLength":253,"pattern":"^[a-z\\d](?:[a-z\\d.-]*[a-z\\d])?$"}`                                                                                                                                                        |
| `service`         | Yes      | `{"type":"string","minLength":1,"maxLength":120}`                                                                                                                                                                                                       |
| `vantage_devices` | Yes      | `{"default":[],"maxItems":2,"type":"array","items":{"type":"string","minLength":1}}`                                                                                                                                                                    |

## list_investigations

**List Client Investigations** · Risk: **read**

List up to 100 saved cases for the selected primary device. Cases requiring denied device access are omitted. No router I/O.

No tool-specific parameters.

## get_investigation

**Read a Client Investigation** · Risk: **read**

Read a case by UUID under its primary device. Rechecks access to all evidence devices. Historical evidence is not a current health check.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
