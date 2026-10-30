---
title: "Site Activity"
description: "Observed destinations by client, DNS and Web Proxy"
---

## What is recorded

Site Activity correlates observed web flows, per-client DNS replies and Web Proxy observations. It keeps 30 days of five-minute aggregates in the MCP host's local `site-activity.db`. Page content, URL paths, credentials and raw DNS packets are not stored.

| Evidence label | Meaning                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| DNS + traffic  | This client recently received a DNS answer naming the destination IP, within the reply TTL. It is a candidate hostname.             |
| IP only        | Traffic reached the public destination without an unambiguous hostname match. Shared hosting prevents reliable site identification. |
| Web Proxy      | An active proxy connection or proxy log supplies the observed host/IP. Very short connections can be missed between reads.          |

## Control collection

Use **Configure** to choose all clients or search and select recognized people/devices. **Until turned off** has no expiration; **End on a date** uses the date/time picker. **Save changes** persists the policy across restarts.

**Pause collection** stops new Site Activity storage; it keeps existing history until normal retention expires. **Start collection** resumes it. These controls do not disable router exports, DNS mirroring or the separate Flow collector. A restricted selection excludes unidentified clients. The deadline is enforced even while the page is closed.

## Explore and export

- Search by domain or destination IP.
- Combine connection type, person/device, client-IP and 24-hour/7-day/30-day filters.
- Read observations, destinations, client IPs and observed MiB over the complete filtered range.
- Switch the destination treemap between observation count and traffic. Tiles and tooltips show a value and percentage; traffic values use MiB.
- Review each row's evidence, source identity/IP, observation count, byte total and last-seen time. Page through results and **Export filtered CSV** (up to 10,000 aggregate rows).

OpenVPN names come from recent session ownership; LAN/Wi-Fi labels come from DHCP/ARP/Wi-Fi samples. Missing or conflicting identity stays unidentified. An address does not prove who operated a shared device.

Encrypted DNS, ECH, hardware offload, missing exports and traffic outside the observed path leave gaps. A DNS answer alone is never a recorded visit. Follow the [collector setup and privacy guide](/docs/guides/site-activity) before expecting data.

## Screen preview

![Full-page dashboard preview with IP addresses and snapshot/backup names blurred](/screenshots/site-activity.jpg)

IP addresses, snapshot/backup names and AAA/OpenVPN usernames are blurred in this full-page capture.

## Additional screens

### Collection audience and schedule

![Collection audience and schedule; full-page capture with IPs and snapshot/backup names blurred](/screenshots/site-activity-collection.jpg)
