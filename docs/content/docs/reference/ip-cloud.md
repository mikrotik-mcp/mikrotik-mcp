---
title: "IP Cloud (DDNS)"
description: "RouterOS cloud DDNS — stable <serial>.sn.mynetname.net name that tracks the WAN IP, with force-update and advanced options (`/ip cloud`)."
---

## Tools

- [Get IP Cloud (DDNS) Status](#get_ip_cloud)
- [Configure IP Cloud (DDNS)](#set_ip_cloud)
- [Force IP Cloud DDNS Update](#force_cloud_update)
- [Set IP Cloud Advanced Options](#set_ip_cloud_advanced)

## get_ip_cloud

**Get IP Cloud (DDNS) Status** · Risk: **read**

Reads the RouterOS cloud DDNS status (`/ip cloud print`) — whether `ddns-enabled` is on, the assigned `dns-name` (`<serial>.sn.mynetname.net`), the detected public IPv4/IPv6 address, the last `update-time`, and the service `status`/warnings. Use this to find the router's stable cloud hostname or check why DDNS isn't updating. To change it use set_ip_cloud; to push an update now use force_cloud_update. Returns the full cloud status block.

No tool-specific parameters.

## set_ip_cloud

**Configure IP Cloud (DDNS)** · Risk: **write-idempotent**

Configures RouterOS cloud DDNS (`/ip cloud set`). Enable/disable the dynamic DNS name with `ddns_enabled`, optionally also sync the router clock from the cloud with `update_time`. When enabled the router registers a `<serial>.sn.mynetname.net` name that follows its public IP. To read the resulting name/status use get_ip_cloud; to force an immediate refresh use force_cloud_update; for the local-vs-public address behaviour use set_ip_cloud_advanced. Returns the updated cloud status.

| Parameter              | Required | Definition                                                                                     |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `ddns_enabled`         | No       | Enable (true) or disable (false) the DDNS name `{"type":"boolean"}`                            |
| `update_time`          | No       | Also sync the router clock from the cloud `{"type":"boolean"}`                                 |
| `ddns_update_interval` | No       | How often to push DDNS updates (e.g. '1m', '1h') or 'none' for the default `{"type":"string"}` |

## force_cloud_update

**Force IP Cloud DDNS Update** · Risk: **write**

Forces an immediate cloud DDNS refresh (`/ip cloud force-update`) — pushes the router's current public IP to the cloud now instead of waiting for the next scheduled update. Use after a WAN IP change or to test connectivity to the cloud service. Requires DDNS to be enabled (see set_ip_cloud). Returns the cloud status after the update.

No tool-specific parameters.

## set_ip_cloud_advanced

**Set IP Cloud Advanced Options** · Risk: **write-idempotent**

Sets advanced cloud options (`/ip cloud advanced set`). `use_local_address=true` makes the cloud DDNS publish the router's LOCAL address instead of the detected public one (useful behind a private WAN / when you reach the router over a VPN). For the main DDNS toggle use set_ip_cloud. Returns the updated cloud status.

| Parameter           | Required | Definition                                                                                  |
| ------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `use_local_address` | Yes      | Publish the local address (true) instead of the public address (false) `{"type":"boolean"}` |
