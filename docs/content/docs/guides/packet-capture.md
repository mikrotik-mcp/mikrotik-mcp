---
title: "Packet Capture Studio"
description: "Practical setup, operations and limits for Packet Capture Studio."
---

Turn the router into a remote Wireshark probe. RouterOS mirrors packets to this
host as **TZSP** (TaZmen Sniffer Protocol, UDP 37008); the server decodes them
live, shows a real-time view in the dashboard — protocol mix, top talkers, a
scrolling packet list — and exports `.pcap` for offline analysis.

No hardware needed: works against a CHR VM, a hardware RouterBoard, or anything
that can stream TZSP to your host.

## Tools (Packet Capture Studio module, under Tools)

| Tool                        | Risk        | What it does                                                 |
| --------------------------- | ----------- | ------------------------------------------------------------ |
| `start_packet_capture`      | WRITE       | Opens the host TZSP receiver + points `/tool sniffer` at it. |
| `mirror_traffic_to_capture` | WRITE       | Adds a per-flow `sniff-tzsp` mangle mirror (surgical).       |
| `packet_capture_status`     | READ        | Stats + recent decoded packets (works headless).             |
| `stop_packet_capture`       | DESTRUCTIVE | Stops the sniffer/mirrors and closes the receiver.           |

## Quick start

`receiver_host` is the IP **this** host has on a segment the **device** can reach
— that's where TZSP is streamed.

```
start_packet_capture receiver_host=10.10.10.50 interface=ether1 protocol=icmp
# … generate/observe traffic …
packet_capture_status limit=40
stop_packet_capture
```

`start_packet_capture` configures the device with
`/tool sniffer set streaming-enabled=yes streaming-server=<host>:37008
filter-stream=yes` (plus any interface/protocol/port filters) and runs
`/tool sniffer start`. `filter-stream=yes` keeps the sniffer from capturing its
own TZSP stream (no feedback loop).

### Surgical per-flow mirror

Instead of (or in addition to) the interface sniffer, mirror just one flow with a
firewall mangle rule — it copies matching packets and leaves the originals
untouched:

```
mirror_traffic_to_capture receiver_host=10.10.10.50 chain=forward protocol=tcp dst_port=443
```

Mirror rules are tagged `comment=mcp-capture` and removed by
`stop_packet_capture`.

## The dashboard panel

With the [observability dashboard](/docs/guides/observability) running
(`serve --dashboard`), the **Packet capture** panel shows the live stream from
the same receiver:

- a running indicator + packet/byte totals,
- a **protocol breakdown** (TCP/UDP/ICMP/ARP/…) and **top talkers**,
- a scrolling, colour-coded **packet list** (time · protocol · length · `src:port → dst:port`),
- **⤓ pcap** to download everything captured, and **■ Stop**.

The receiver runs in the same process as the dashboard, so the tools and the
panel share one capture session. The dashboard's capture API:

```
GET  /api/capture/status      stats (running, port, packets, protocols, top talkers)
GET  /api/capture/packets     recent decoded summaries + stats
GET  /api/capture/pcap        download the retained frames as classic pcap
POST /api/capture/start       {port}  — start the host receiver
POST /api/capture/stop        stop the host receiver
```

## How it works

```
device  /tool sniffer (streaming)  ──TZSP/UDP 37008──▶  host receiver
        or mangle action=sniff-tzsp                      decode → summarise → live view + pcap
```

The decoder unwraps the TZSP envelope, parses the inner Ethernet / IPv4 / IPv6 /
TCP / UDP / ICMP / ARP headers into a summary, keeps a bounded ring of the latest
packets plus raw frames for pcap, and tallies per-protocol and top-talker stats.

## Notes & gotchas

- **Reachability** — the device must be able to send UDP 37008 to
  `receiver_host`; a host firewall that drops inbound UDP will show 0 packets.
- **Hardware-offloaded bridge traffic** isn't visible to the sniffer (only
  flooded/unknown-unicast/broadcast may appear) — use the mangle mirror or
  capture on the routed path.
- **pcap retention** is bounded (last few thousand frames / 16 MiB) to keep memory
  flat; download periodically for long captures.
- Always `stop_packet_capture` when done — it disables streaming and removes the
  mirror rules.
