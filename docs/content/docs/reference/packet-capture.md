---
title: "Packet Capture Studio"
description: "Live TZSP capture: stream mirrored packets to this host, decode them in the dashboard, add per-flow mirrors, and export pcap (`/tool sniffer` streaming + `sniff-tzsp`)."
---

## Tools

- [Start Packet Capture (TZSP Streaming)](#start_packet_capture)
- [Mirror Specific Traffic Flow to Capture](#mirror_traffic_to_capture)
- [Get Packet Capture Status and Recent Packets](#packet_capture_status)
- [Stop Packet Capture and Remove Mirror Rules](#stop_packet_capture)

## start_packet_capture

**Start Packet Capture (TZSP Streaming)** · Risk: **write**

Opens a host-side TZSP receiver and configures the device's `/tool sniffer` (`/tool sniffer set` + `/tool sniffer start`) to stream mirrored packets to it — enables live capture of router traffic for protocol debugging or traffic inspection. Call this before `mirror_traffic_to_capture`, which adds per-flow `/ip firewall mangle action=sniff-tzsp` rules for surgical filtering of specific flows; `start_packet_capture` must be running first for those mirrors to deliver packets here. `receiver_host` must be the IP this host has on a segment the device can reach (the TZSP UDP destination). Optional `interface` sets `filter-interface`, `protocol` sets `filter-ip-protocol`, `port_filter` sets `filter-port`. View packets live in the dashboard Packet Capture panel or poll with `packet_capture_status`. Stop and tear down everything with `stop_packet_capture`.

| Parameter       | Required | Definition                                                                                      |
| --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `receiver_host` | Yes      | IP this host is reachable at from the device (the TZSP stream destination). `{"type":"string"}` |
| `port`          | Yes      | `{"default":37008,"type":"integer","minimum":1,"maximum":65535}`                                |
| `interface`     | No       | Capture interface, or omit for all (`filter-interface`). `{"type":"string"}`                    |
| `protocol`      | No       | Limit to an IP protocol, e.g. "tcp", "icmp". `{"type":"string"}`                                |
| `port_filter`   | No       | Limit to a TCP/UDP port number. `{"type":"string"}`                                             |

## mirror_traffic_to_capture

**Mirror Specific Traffic Flow to Capture** · Risk: **write**

Adds a per-flow packet mirror (`/ip firewall mangle add action=sniff-tzsp`) that copies only matching packets to the active TZSP capture receiver without affecting the original traffic. Use after `start_packet_capture` to focus on a specific host, port, or protocol — `start_packet_capture` must already be running; without it, packets have nowhere to go. For broad unfiltered capture without per-flow selection, use only `start_packet_capture` with its built-in interface/protocol/port filters. Accepts `chain` (forward/input/output/prerouting/postrouting, default forward), optional `src_address`, `dst_address`, `protocol`, and `dst_port` to match the desired flow. Rules are tagged `mcp-capture` so `stop_packet_capture` removes them all automatically. Returns confirmation of the chain and destination.

| Parameter       | Required | Definition                                                                                             |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `receiver_host` | Yes      | TZSP stream destination (this host's IP). `{"type":"string"}`                                          |
| `port`          | Yes      | `{"default":37008,"type":"integer","minimum":1,"maximum":65535}`                                       |
| `chain`         | Yes      | `{"default":"forward","type":"string","enum":["forward","input","output","prerouting","postrouting"]}` |
| `src_address`   | No       | `{"type":"string"}`                                                                                    |
| `dst_address`   | No       | `{"type":"string"}`                                                                                    |
| `protocol`      | No       | `{"type":"string"}`                                                                                    |
| `dst_port`      | No       | `{"type":"string"}`                                                                                    |

## packet_capture_status

**Get Packet Capture Status and Recent Packets** · Risk: **read**

Reads the current state of the in-process TZSP capture receiver — whether it is running, cumulative packet and byte totals, per-protocol breakdown, top talker IP addresses, and the most recently decoded packets (up to `limit`, default 40, max 500) with timestamps, byte lengths, and info strings. Does not query the device; reads only the local capture session started by `start_packet_capture`. Works headlessly without the dashboard. To start or stop the session use `start_packet_capture` or `stop_packet_capture`.

| Parameter | Required | Definition                                                                             |
| --------- | -------- | -------------------------------------------------------------------------------------- |
| `limit`   | Yes      | Recent packets to include. `{"default":40,"type":"integer","minimum":1,"maximum":500}` |

## stop_packet_capture

**Stop Packet Capture and Remove Mirror Rules** · Risk: **destructive**

Tears down the entire capture session: stops the device sniffer (`/tool sniffer stop`), disables streaming (`/tool sniffer set streaming-enabled=no`), removes all per-flow mirror rules that were added by `mirror_traffic_to_capture` (`/ip firewall mangle remove [find action=sniff-tzsp and comment="mcp-capture"]`), and closes the host-side TZSP receiver. Returns the final cumulative packet and byte totals from the session. To inspect the session without stopping it use `packet_capture_status`.

No tool-specific parameters.
