---
title: "Flood Ping"
description: "ICMP flood ping with summary statistics (`/tool flood-ping`)."
---

## Tools

- [Flood Ping Host](#flood_ping)

## flood_ping

**Flood Ping Host** · Risk: **read**

Sends a burst of ICMP echo requests as fast as possible to a target host or IP (`/tool flood-ping`). Use to stress-test packet loss and measure raw round-trip latency under maximum-rate load rather than at a timed interval; the run terminates after `count` packets (default 1000) so it does not stream indefinitely. Returns sent/received packet counts and min/avg/max round-trip times. Optional: `size` (packet size in bytes), `interface` (outgoing interface), `src_address` (source IP address to use).

| Parameter     | Required | Definition                                                                                                   |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `address`     | Yes      | Target host or IP `{"type":"string"}`                                                                        |
| `count`       | Yes      | Number of packets to send (bounds the run) `{"default":1000,"type":"integer","minimum":1,"maximum":1000000}` |
| `size`        | No       | Packet size in bytes `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`             |
| `interface`   | No       | Outgoing interface `{"type":"string"}`                                                                       |
| `src_address` | No       | Source address `{"type":"string"}`                                                                           |
