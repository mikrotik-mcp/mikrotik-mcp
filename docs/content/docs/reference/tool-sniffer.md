---
title: "Packet Sniffer"
description: "Packet capture: settings, start/stop/save, captured hosts/protocols/packets (`/tool sniffer`)."
---

## Tools

- [Get Packet Sniffer Settings](#get_sniffer_settings)
- [Update Packet Sniffer Settings](#update_sniffer_settings)
- [Start Packet Sniffer](#start_sniffer)
- [Stop Packet Sniffer](#stop_sniffer)
- [Save Packet Sniffer Capture to File](#save_sniffer)
- [List Captured Sniffer Packets](#list_sniffer_packets)
- [List Sniffer Observed Hosts](#list_sniffer_hosts)
- [List Sniffer Protocol Distribution](#list_sniffer_protocols)
- [List Sniffer Observed Connections](#list_sniffer_connections)

## get_sniffer_settings

**Get Packet Sniffer Settings** · Risk: **read**

Reads the current packet sniffer configuration and running state (`/tool sniffer`). Use this to inspect active filter rules (interface, IP/CIDR, port, MAC protocol), TZSP streaming target, memory buffer limit, and file output name before starting a capture. To change settings use update_sniffer_settings; to start or stop the sniffer use start_sniffer / stop_sniffer. Returns the full `/tool sniffer print` output.

No tool-specific parameters.

## update_sniffer_settings

**Update Packet Sniffer Settings** · Risk: **write-idempotent**

Configures the packet sniffer (`/tool sniffer set`) — sets capture filters, TZSP streaming, buffer size, and output file before a capture session. Call this before start_sniffer to narrow what traffic is captured or where it is forwarded. For reading already-captured data use list_sniffer_packets, list_sniffer_hosts, list_sniffer_protocols, or list_sniffer_connections. Returns the updated sniffer settings after applying.

Notes:
streaming_enabled + streaming_server: forward captured packets as
TZSP to a remote analyzer (e.g. Wireshark); streaming_server e.g. '192.168.88.2'.
memory_limit: capture buffer size, e.g. '10M'.
filter_ip_address: match IP/CIDR, e.g. '10.0.0.0/24'.
only_headers: capture packet headers only (smaller buffer).
file_name: file name for continuous on-disk packet output during capture (RouterOS writes
packets to this file while the sniffer runs); save_sniffer takes its own independent
file_name parameter and does not use this value.

| Parameter                         | Required | Definition                                                                                               |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `filter_interface`                | No       | `{"type":"string"}`                                                                                      |
| `filter_ip_address`               | No       | Match IP/CIDR, e.g. '10.0.0.0/24' `{"type":"string"}`                                                    |
| `filter_ipv6_address`             | No       | Match IPv6/prefix, e.g. '2001:db8::/64' `{"type":"string"}`                                              |
| `filter_mac_address`              | No       | Match MAC address `{"type":"string"}`                                                                    |
| `filter_port`                     | No       | `{"type":"string"}`                                                                                      |
| `filter_mac_protocol`             | No       | `{"type":"string"}`                                                                                      |
| `filter_direction`                | No       | Capture direction: any, rx, or tx `{"type":"string","enum":["any","rx","tx"]}`                           |
| `filter_operator_between_entries` | No       | How filter entries combine: and / or `{"type":"string","enum":["and","or"]}`                             |
| `filter_stream`                   | No       | Capture only TZSP-streamed packets `{"type":"boolean"}`                                                  |
| `streaming_enabled`               | No       | `{"type":"boolean"}`                                                                                     |
| `streaming_server`                | No       | TZSP target, e.g. '192.168.88.2' `{"type":"string"}`                                                     |
| `memory_limit`                    | No       | Buffer size, e.g. '10M' `{"type":"string"}`                                                              |
| `memory_scroll`                   | No       | Overwrite oldest packets when buffer is full `{"type":"boolean"}`                                        |
| `file_name`                       | No       | Capture file name (.pcap) `{"type":"string"}`                                                            |
| `file_limit`                      | No       | Max capture file size in KiB `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `only_headers`                    | No       | `{"type":"boolean"}`                                                                                     |

## start_sniffer

**Start Packet Sniffer** · Risk: **write**

Starts the packet sniffer (`/tool sniffer start`) — begins capturing packets into the in-memory ring buffer (and to file if file_name was set via update_sniffer_settings). Required before list_sniffer_packets, list_sniffer_hosts, list_sniffer_protocols, or list_sniffer_connections can return live data. Stop the capture with stop_sniffer.

No tool-specific parameters.

## stop_sniffer

**Stop Packet Sniffer** · Risk: **write**

Stops the packet sniffer (`/tool sniffer stop`) — halts an active capture session started with start_sniffer. The in-memory buffer remains readable via list_sniffer_packets, list_sniffer_hosts, list_sniffer_protocols, and list_sniffer_connections after stopping. To save the buffer to a .pcap file on the device filesystem use save_sniffer.

No tool-specific parameters.

## save_sniffer

**Save Packet Sniffer Capture to File** · Risk: **write**

Saves the current in-memory sniffer buffer to a .pcap file on the device filesystem (`/tool sniffer save`) — use after stop_sniffer to persist a capture for later download or off-device analysis. The file is stored on the router's local storage. To read individual packets from the in-memory buffer without saving use list_sniffer_packets. Requires file_name (basename without extension, e.g. 'capture').

| Parameter   | Required | Definition                                           |
| ----------- | -------- | ---------------------------------------------------- |
| `file_name` | Yes      | Output file name, e.g. 'capture' `{"type":"string"}` |

## list_sniffer_packets

**List Captured Sniffer Packets** · Risk: **read**

Lists individual packets from the sniffer's in-memory ring buffer (`/tool sniffer packet print`) — use to inspect packet-level detail (src/dst address, protocol, size, timestamp) after start_sniffer. Optionally filter by partial src/dst address (address_filter) or protocol name (protocol_filter). For per-host byte/packet aggregates use list_sniffer_hosts; for protocol distribution use list_sniffer_protocols; for connection-pair (flow) view use list_sniffer_connections. Requires an active or recently stopped sniffer session.

| Parameter         | Required | Definition                                        |
| ----------------- | -------- | ------------------------------------------------- |
| `address_filter`  | No       | Partial src/dst address match `{"type":"string"}` |
| `protocol_filter` | No       | `{"type":"string"}`                               |

## list_sniffer_hosts

**List Sniffer Observed Hosts** · Risk: **read**

Lists hosts observed by the packet sniffer with per-host byte and packet counts (`/tool sniffer host print`) — use to identify the most active talkers in the current capture. Optionally filter by partial address string (address_filter). For individual packet detail use list_sniffer_packets; for protocol breakdown use list_sniffer_protocols; for connection-pair (flow) view use list_sniffer_connections. Requires an active or recently stopped sniffer session started with start_sniffer.

| Parameter        | Required | Definition          |
| ---------------- | -------- | ------------------- |
| `address_filter` | No       | `{"type":"string"}` |

## list_sniffer_protocols

**List Sniffer Protocol Distribution** · Risk: **read**

Lists the protocol breakdown of traffic observed by the packet sniffer (`/tool sniffer protocol print`) — returns each protocol with its byte and packet share. Use to identify which protocols dominate the captured traffic. For per-host statistics use list_sniffer_hosts; for individual packet detail use list_sniffer_packets; for connection-pair (flow) view use list_sniffer_connections. Requires an active or recently stopped sniffer session started with start_sniffer.

No tool-specific parameters.

## list_sniffer_connections

**List Sniffer Observed Connections** · Risk: **read**

Lists connection pairs (src/dst address and port tuples) observed by the packet sniffer (`/tool sniffer connection print`) — use to identify active or recent flows at a session level. For individual packet detail use list_sniffer_packets; for per-host byte/packet aggregates use list_sniffer_hosts; for protocol breakdown use list_sniffer_protocols. Requires an active or recently stopped sniffer session started with start_sniffer.

No tool-specific parameters.
