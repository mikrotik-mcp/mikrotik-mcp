---
title: "Wake-on-LAN"
description: "Send Wake-on-LAN magic packets (`/tool wol`)."
---

## Tools

- [Send Wake-on-LAN Magic Packet](#wake_on_lan)

## wake_on_lan

**Send Wake-on-LAN Magic Packet** · Risk: **write**

Sends a Wake-on-LAN (WOL) magic packet to a target host by MAC address (`/tool wol`) — wakes a powered-off but WOL-enabled device on the local network without requiring its IP address. Optionally specify `interface` to control which router interface broadcasts the magic packet; omit it to let RouterOS choose automatically. This is a fire-and-forget write: returns confirmation that the packet was dispatched but does NOT verify that the target device actually powered on. `mac` must be a colon-separated MAC address string, e.g. 'AA:BB:CC:DD:EE:FF'.

| Parameter   | Required | Definition                                                       |
| ----------- | -------- | ---------------------------------------------------------------- |
| `mac`       | Yes      | Target MAC address, e.g. 'AA:BB:CC:DD:EE:FF' `{"type":"string"}` |
| `interface` | No       | Interface to send the magic packet from `{"type":"string"}`      |
