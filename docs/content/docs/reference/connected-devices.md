---
title: "Connected Devices"
description: "Manage devices on the network: unified list (DHCP lease + ARP), live traffic, block/allow by MAC, pin/change IP, and labels."
---

## Tools

- [List Connected Devices](#list_connected_devices)
- [Get Connected Device Detail](#get_connected_device)
- [Get Device Live Traffic (Download/Upload)](#get_device_traffic)
- [Pin a Device's IP (Make Lease Static)](#make_device_static)
- [Set a Device's Reserved IP](#set_device_ip)
- [Label a Device](#set_device_label)
- [Set a Device's Download/Upload Rate Limits](#set_device_limits)
- [Block a Device (Deny Network Access)](#block_device)
- [Allow a Device (Restore Network Access)](#allow_device)
- [Remove a Device's DHCP Lease](#remove_device_lease)

## list_connected_devices

**List Connected Devices** · Risk: **read**

Show every device on the network as a unified table — merges `/ip dhcp-server lease` (IP, MAC, host-name, status), `/ip arp` (interface, reachability) and lease flags. For each device returns its IP, MAC, hostname, interface, lease status (bound/waiting), whether its IP is STATIC (pinned), whether it is BLOCKED, last-seen activity and comment/label. In an MCP App host this renders an interactive table with per-device Download/Upload charts and one-click block/allow + make-static. Use make_device_static to pin a device's IP, block_device/allow_device to deny/permit network access, set_device_ip to change the reserved IP, set_device_label to name it, and get_device_traffic for live ↓/↑ rate. Filter with status_filter, name_filter (host/comment), static_only or blocked_only.

| Parameter       | Required | Definition                                                                |
| --------------- | -------- | ------------------------------------------------------------------------- |
| `name_filter`   | No       | Match host-name or comment (substring) `{"type":"string"}`                |
| `status_filter` | No       | e.g. "bound", "waiting", "arp-only" `{"type":"string"}`                   |
| `static_only`   | Yes      | Only devices with a pinned/static IP `{"default":false,"type":"boolean"}` |
| `blocked_only`  | Yes      | Only blocked devices `{"default":false,"type":"boolean"}`                 |

## get_connected_device

**Get Connected Device Detail** · Risk: **read**

Full detail for one device by MAC (preferred) or IP — its DHCP lease record (`/ip dhcp-server lease print detail`) plus its ARP entry (interface, reachability). Use list_connected_devices to find the MAC/IP; use get_device_traffic for live throughput.

| Parameter | Required | Definition                                                     |
| --------- | -------- | -------------------------------------------------------------- |
| `mac`     | No       | Device MAC address `{"type":"string"}`                         |
| `ip`      | No       | Device IP address (used if mac is omitted) `{"type":"string"}` |

## get_device_traffic

**Get Device Live Traffic (Download/Upload)** · Risk: **read**

Live download/upload throughput for one device, sampled for the connected-devices charts. Reads a matching `/queue simple` entry's stats (rate + cumulative bytes) when one targets the device's IP; otherwise reports source='none' (create_simple_queue with target=<ip> to enable tracking). Returns rx/tx bits-per-second and cumulative bytes so the MCP App can plot the ↓/↑ chart over time.

| Parameter | Required | Definition                            |
| --------- | -------- | ------------------------------------- |
| `ip`      | Yes      | Device IP address `{"type":"string"}` |

## make_device_static

**Pin a Device's IP (Make Lease Static)** · Risk: **write**

Pin a device's current IP so it always gets the same address (`/ip dhcp-server lease make-static`) — converts its dynamic DHCP lease to a static reservation bound to its MAC. Use this to 'fix' a device's IP. To then change the reserved IP use set_device_ip. Identify the device by MAC.

| Parameter | Required | Definition                             |
| --------- | -------- | -------------------------------------- |
| `mac`     | Yes      | Device MAC address `{"type":"string"}` |

## set_device_ip

**Set a Device's Reserved IP** · Risk: **write-idempotent**

Change the IP reserved for a device (`/ip dhcp-server lease set address=`). If the device's lease is still dynamic it is made static first so the address sticks. Identify the device by MAC. The new IP must be within the DHCP server's network. Use make_device_static to pin the current IP without changing it.

| Parameter | Required | Definition                                  |
| --------- | -------- | ------------------------------------------- |
| `mac`     | Yes      | Device MAC address `{"type":"string"}`      |
| `ip`      | Yes      | New reserved IP address `{"type":"string"}` |

## set_device_label

**Label a Device** · Risk: **write-idempotent**

Set a friendly label/comment on a device's DHCP lease (`/ip dhcp-server lease set comment=`) so it is easy to recognise in list_connected_devices (e.g. "Ali phone", "Living-room TV"). Identify by MAC.

| Parameter | Required | Definition                                                             |
| --------- | -------- | ---------------------------------------------------------------------- |
| `mac`     | Yes      | Device MAC address `{"type":"string"}`                                 |
| `label`   | Yes      | Friendly name, e.g. "Ali phone". Pass "" to clear. `{"type":"string"}` |

## set_device_limits

**Set a Device's Download/Upload Rate Limits** · Risk: **write-idempotent**

Throttle (or unthrottle) a device's bandwidth by managing a `/queue simple` targeting its IP — sets the max download and upload rate. RouterOS rate strings: e.g. `10M`, `512k`; pass `0` or omit a side to leave it unlimited. Updates the device's existing simple queue if there is one, otherwise creates it (which also enables the per-device traffic counter the Connected Devices charts read). Identify the device by IP (the queue target).

| Parameter        | Required | Definition                                                              |
| ---------------- | -------- | ----------------------------------------------------------------------- |
| `ip`             | Yes      | Device IP address (the queue target) `{"type":"string"}`                |
| `download_limit` | No       | Max download rate, e.g. "10M". "0"/omit = unlimited `{"type":"string"}` |
| `upload_limit`   | No       | Max upload rate, e.g. "2M". "0"/omit = unlimited `{"type":"string"}`    |
| `name`           | No       | Optional name for a newly created queue `{"type":"string"}`             |

## block_device

**Block a Device (Deny Network Access)** · Risk: **write**

Deny a device all network access by its MAC — installs tagged `/ip firewall filter` drop rules in the forward chain (traffic through the router) and the input chain (access to the router itself), and sets its DHCP lease block-access=yes. Blocking by MAC survives the device changing IP. Idempotent. Reverse with allow_device. Identify by MAC.

| Parameter | Required | Definition                                                      |
| --------- | -------- | --------------------------------------------------------------- |
| `mac`     | Yes      | Device MAC address to block `{"type":"string"}`                 |
| `comment` | No       | Optional reason, appended to the rule label `{"type":"string"}` |

## allow_device

**Allow a Device (Restore Network Access)** · Risk: **destructive**

Restore network access for a previously blocked device — removes the tagged `mcp-blocked` drop rules for its MAC from `/ip firewall filter` and clears its DHCP lease block-access. Reverses block_device. Identify by MAC.

| Parameter | Required | Definition                                        |
| --------- | -------- | ------------------------------------------------- |
| `mac`     | Yes      | Device MAC address to unblock `{"type":"string"}` |

## remove_device_lease

**Remove a Device's DHCP Lease** · Risk: **destructive**

Delete a device's DHCP lease (`/ip dhcp-server lease remove`) — forgets a static reservation or clears a stale dynamic lease. Does NOT block the device (use block_device for that). Identify by MAC. Verifies the lease exists first.

| Parameter | Required | Definition                             |
| --------- | -------- | -------------------------------------- |
| `mac`     | Yes      | Device MAC address `{"type":"string"}` |
