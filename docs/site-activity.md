# Site Activity

The dashboard's **Site Activity** page stores observed destinations on the MCP host in `site-activity.db` beside `events.db`. It retains 30 days of five-minute aggregates. No page content, URL path, credentials or raw DNS packets are persisted. The database file is created with owner-only permissions.

This history is sensitive. If the dashboard listens beyond localhost, configure `dashboard.token` and restrict dashboard and UDP collector access to trusted clients and routers. The site-activity API uses the dashboard's existing token gate.

## What a row means

| Evidence      | Meaning                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS + traffic | A DNS reply for this exact client named this destination IP before the observed web flow began, within the reply TTL. This is a candidate hostname, not proof of the exact page visited. |
| IP only       | An HTTPS/HTTP flow reached this public IP; no unambiguous client DNS evidence was available. Shared/CDN IPs cannot be turned into a reliable site name by reverse lookup.                |
| Web Proxy     | RouterOS reported an active proxy connection or a proxy log message. A log with a CONNECT/HTTP host shows the host only; an active connection without a host shows the IP.               |

Each row shows the source IP. This is **not always a stable person identity**: DHCP addresses can be reassigned, WireGuard peers can share routes, and a NATed export can show the router instead of the original client. No identity is inferred from an IP alone. Flow byte counts are exporter-reported and can duplicate when several interfaces export the same traffic.

## Identity and reports

The dashboard samples OpenVPN tunnel owners from its existing session-history database and LAN/Wi-Fi names from RouterOS DHCP/ARP and Wi-Fi registration data. It keeps timestamped identity samples locally, then labels an activity row only when a recent sample matches its client IP. Missing or ambiguous identities remain **Unidentified**; RouterOS cannot prove who operated a shared device. IPv6 clients without a matching device record are also left unidentified. An IP reassignment inside an aggregate window may be ambiguous.

Use the connection-type, person/device, client-IP, period and destination filters to narrow the table and adjacent treemap. The summary cards and treemap use the complete filtered set rather than the current page. The CSV action exports up to 10,000 filtered aggregate rows. The chart can size areas by observation count or observed traffic bytes; its colors do not imply a traffic category. A Web Proxy source is labeled by its client IP unless the router supplies a matching local identity.

The **Collection** control on this page can stop and resume new Site Activity records, restrict collection to selected recognized people/devices, and optionally set an end date and time. Its default is enabled for all clients with no time limit. The policy is persisted in `site-activity.db` and survives MCP restarts. When names are selected, unknown clients are excluded from new records. The end time is enforced at ingestion even if the dashboard is closed. Old history remains available until normal 30-day retention expires. This control does not disable the separate Traffic Flow collector or change router-side exports/DNS mirroring; it stops Site Activity storage and proxy polling only.

## Setup

1. Enable `flows.enabled` in MCP config and restart the dashboard. The server now starts the UDP flow collector automatically when this setting is true. Point the home's RouterOS Traffic Flow target at the MCP host's **reachable LAN IP**, UDP 2055, using IPFIX or NetFlow v9. Verify `/api/flows/health` reports received and decoded records. Do not send router telemetry to a public IP.
2. To attach DNS names, mirror **only UDP replies with source port 53** to the MCP host on UDP 37009. RouterOS mangle `action=sniff-tzsp`, `sniff-target=<MCP-host-LAN-IP>`, `sniff-target-port=37009`, `protocol=udp`, `src-port=53`, and a narrowly scoped destination/client network can do this without occupying the global Packet Sniffer. Take a local configuration backup before changing firewall mangle, verify rule order and counters, and restrict the receiver with the host firewall. Do not mirror general traffic or DNS requests containing private query names. The receiver discards each TZSP frame after extracting public A/AAAA answers.
3. For the router Web Proxy, the collector reads current `/ip proxy connections` and `web-proxy` memory log entries at most once per 30 seconds. If RouterOS is not already logging requests, add a memory logging rule for `web-proxy,!debug`; confirm the actual log format on the deployed RouterOS version. Short proxy connections between samples may be missed. The collector limits each read to 250 KiB and stores only a host when the log gives both client and host.

The page does not promise a complete browsing history. Encrypted DNS, ECH, hardware offload, non-web ports, an unavailable collector, a missed DNS response, and traffic that bypasses the observed router can all leave gaps. A DNS answer alone is never shown as a visit.
