---
title: "Packets"
description: "Live TZSP capture & decode"
---

## Inspect a bounded packet capture

Open **Diagnostics → Packet Capture** (`#packets`). The page displays packets sent to this MCP host's TZSP receiver. It does not start router mirroring automatically.

1. Use `start_packet_capture` with an address the router can reach, plus narrow interface/protocol/port filters. This changes the router's sniffer configuration.
2. Observe the running indicator, UDP port, packet/byte totals, protocol mix and top talkers.
3. Read the latest 150 decoded summaries: capture time, protocol, length and endpoints. The display refreshes every 1.5 seconds.
4. Download **pcap** to inspect retained frames in Wireshark.
5. End the router capture with `stop_packet_capture` when finished.

The dashboard **Stop** button stops the local receiver. Use the MCP stop tool to also clean up router-side sniffer streaming and managed mirror rules; closing the page is not cleanup.

### Limits

Capture retention is bounded; pcap is the retained frame buffer, not an unlimited archive. Offloaded traffic may never reach the router CPU, and UDP loss can omit packets. Captures can contain payload and credentials: review access and storage before sharing them.

See [Packet Capture Studio](/docs/guides/packet-capture) for setup, targeted mirrors, retention and cleanup.

## Screen preview

![Full-page dashboard preview with IP addresses and snapshot/backup names blurred](/screenshots/packets.jpg)

IP addresses, snapshot/backup names and AAA/OpenVPN usernames are blurred in this full-page capture.
