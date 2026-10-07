# OpenVPN connections

Open **Users & VPN → OpenVPN** (`#openvpn`) and select a router. The live view shows incoming,
authenticated OpenVPN connections from `/ppp active` with `service=ovpn`, including
RADIUS-authenticated users. It does not show outbound OpenVPN clients, other PPP
services, passwords or retained User Manager session history.

Each connection shows the username, client source address, assigned tunnel IP,
connection duration and reported encoding. Search by username, IP or session ID.
Multiple connections with the same username remain separate.

The source IP has a compact country flag with an approximate-location tooltip;
country names/codes are searchable too. Beneath the IP, a compact line shows the
reported **ASN organization** (the source network/operator); hover for its full
name and ASN, such as `AS44244`. Both the organization and ASN are searchable.
The same details appear when reviewing a disconnect. This is the location of the public **client source**, not the assigned
tunnel IP or a claim about the person's nationality/location.

Country lookups use the dashboard's existing `ipkit.ir` provider (with `ipquery.io`
fallback), from the MCP host. Only the public source IP is sent—not usernames,
session IDs or credentials. Private, loopback, link-local and invalid addresses
are never queried. Results are shared by IP across routers for 24 hours; failed
lookups retry after five minutes. At most four lookups run concurrently, with a
bounded cache/queue. Lookups do not block session reads: a globe indicates a
pending, unavailable or private source, with an explanatory tooltip. Flag SVGs
are served through the dashboard's existing same-origin `/api/flag/…` cache;
a missing image falls back to the two-letter country code.

ASN information comes from the same response and shares the country cache—no
extra lookup is made per session. The exact reported organization is shown, not
an inferred mobile-provider brand or subscriber identity. A missing organization
falls back to the ASN when available; otherwise the network is explicitly shown
as pending, private or unavailable without hiding the IP or country flag.

The page refreshes every five seconds while visible, without overlapping reads.
Backend reads coalesce and cache for two seconds. The clock advances between
successful reads; stale/error states freeze it and keep the last known rows.
Missing data is not displayed as zero connections. Reads are bounded to 1,000
sessions; unsupported JSON output or oversized/invalid responses show an error,
not a partial list. This workflow requires RouterOS v7 with JSON serialization.

## History & insights

With the dashboard service running, a read-only background collector records
incoming OpenVPN sessions even when no browser is open. It reads each enabled,
non-MAC router once per pass, waits 15 seconds after the pass, and does not overlap
passes. Active Safe Mode sessions are skipped. Failed routers back off up to five
minutes. The existing session reader's access policy, response limits and shared
in-flight cache also apply. No router settings or RADIUS accounting are changed.

Select **History & insights** for:

- An exact-username filter (suggested recorded users) and local-time **From / Through**
  pickers; 7/30/90-day shortcuts and **All recorded**. Click a journal username to
  focus on that user. Filters select **estimated session start time**, inclusively.
- Connections in the selected range alongside the selected user's all-recorded
  count; distinct users, source IPs, known ASNs and countries; accumulated last
  reported session uptime (not billable time or time clipped to the date range).
- A UTC daily-start chart showing at most the last 90 calendar days of the range,
  including zero-count days. Summary totals cover the entire selected range.
- Top-20 source-IP, ASN/organization and country lists with shares of all matching
  connections. Unknown networks/countries remain explicit, not dropped.
- A paginated journal of 50 connections with estimated start, last seen, end
  detection, tunnel IP, source network and continuity warnings.

History lives in `openvpn-history.db` beside the configured dashboard events DB
(normally `~/.mikrotik-mcp/`). It survives process restarts, and is separate from
event-log retention. **There is no automatic history deletion.** Include this DB
in your protected host backups; SQLite WAL/SHM files belong with the DB while it
is open. For Docker, persist the containing data directory as well as configuration.
The file contains usernames and connection metadata; it is created owner-only.
It does not contain credentials, disconnect tokens or raw router replies.

Each device/user/date/page report is cached for 30 seconds, with at most 128 cached
reports. History queries only read local SQLite; refresh and changing filters do
not issue router or GeoIP requests. Background GeoIP enrichment reuses the existing
bounded provider cache and stores the resulting country/ASN locally. A failed or
private-IP lookup remains unknown; successful lookups are approximate, not proof
of a person's location. Late enrichment can finish after a connection ends.

**Coverage matters:** this is an observed-session journal, not a lossless RADIUS
accounting ledger. Connections that start and end between samples, before first
installation, or during MCP downtime can be missed. Existing active sessions are
recorded when first seen with their uptime-derived start (which can predate
collection). Repeated samples update the same row; reused IDs with reset uptime
create a new row. Failed reads never disconnect or close stored sessions. Gaps
longer than 45 seconds are counted, and affected rows are marked uncertain.
An end time means “first observed absent,” bounded by the previous last-seen time,
not an exact disconnect timestamp. A stale collector shows unknown live state.

API: `GET /api/openvpn/history?device=…&user=…&from=…&to=…&offset=…`.
Dates are epoch milliseconds; bounds/user are optional; offset defaults to zero.
Authentication and the `list_ovpn_sessions` read policy apply even to cached results.
Storage failure returns an error rather than fabricated empty history.

Checks: `bun test tests/openvpn-history.bun.test.ts` covers the real SQLite store;
`bunx vp test run tests/openvpn-history.spec.ts` covers the collector and API.

## Disconnect one connection

1. Select **Disconnect** on the intended row.
2. Check the router, username, source address, tunnel address and session ID.
3. Acknowledge the impact, then select **Disconnect connection**.

**Warning:** disconnecting your own management tunnel can interrupt dashboard
access. This ends a runtime session, not its account. The client can immediately
reconnect, and RouterOS may run the profile's on-down hook.

The server uses a single-use, router-bound selection valid for 60 seconds. Before
removing anything, a guarded router command checks the exact internal ID, service,
session ID, username, addresses and non-reset uptime. It never removes all rows
sharing a username. A changed/expired selection requires a fresh read and review.
Read-back distinguishes a confirmed end from an uncertain outcome. A timeout is
not success, and disconnect requests are never automatically replayed.

Global read-only and per-device/tool access policies apply to both API and MCP.
The operation is blocked during an active Safe Mode session: runtime connection
termination cannot be rolled back. Missing session identity/uptime disables the
control. Authentication secrets and VPN/server settings are never changed.

## MCP tools

- `list_ovpn_sessions`: pass an explicit device; returns a structured snapshot and
  a short-lived `disconnectToken` for each identifiable connection.
- `disconnect_ovpn_session`: pass the same device, `token`, and `confirm: true`
  only after the operator approves the specific connection. For an uncertain
  outcome, read again; do not retry automatically.

Dashboard routes: `GET /api/openvpn/sessions?device=…` and
`POST /api/openvpn/disconnect?device=…` with `{ "token": "…", "confirm": true }`.
The dashboard's existing authentication applies; cross-origin mutation requests
are rejected. These endpoints do not expose account passwords.

Reference: [MikroTik PPP active connections](https://manual.mikrotik.com/docs/authentication-authorization-accounting/ppp-aaa/).
