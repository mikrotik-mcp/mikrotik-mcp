# Client and service investigations

An investigation collects a historical case for one IPv4/MAC client and a named
service. It joins DHCP, ARP and bridge-host records, preserves VLAN/interface,
DNS, route, filter and NAT context, and runs three ICMP probes from each selected
router. It never changes router configuration or starts a packet capture.

## Use

Open **Investigations** in the observability dashboard. Select the access router,
client IPv4 or colon-separated MAC, destination hostname/IPv4 and service label.
Optionally select up to two additional routers. Click **Create investigation**.
Opening saved cases does not contact a router.

MCP tools:

- `create_investigation`: required `client`, `target`, `service`; optional
  `vantage_devices` (up to two), plus the usual `device` selector.
- `list_investigations`: the latest 100 visible cases for the selected primary router.
- `get_investigation`: a case UUID plus its primary `device`.

```json
{
  "device": "branch",
  "client": "192.168.88.20",
  "target": "payments.example.com",
  "service": "Checkout",
  "vantage_devices": ["core"]
}
```

Device names above are examples, not configured devices. Resolve actual names
with `list_mikrotik_devices`. All vantage names and permissions are checked before
any query. Permission is rechecked before each read and when retrieving history.
Creation is annotated WRITE because it persists local state; the router is read-only.

## Evidence semantics

Each source has device identity, start/end timestamps, state, selected records and
a truncation flag. Failed or unrecognised sources are `unknown`. Missing DNS or
ping output is never a healthy zero. Only allowlisted properties are stored;
comments, credentials and raw exception messages are excluded. IP/MAC addresses
and network topology remain sensitive operational data: restrict dashboard access
and protect the local database.

The current collector emits observed/unknown evidence. It does not manufacture
causal inferences. A configuration row is context, not proof that a packet matched
that row. Next experiments are recommendations, not actions already performed.
`clientOutcome` remains `unverified`, even when every router ping succeeds.

## Storage and limits

Cases are immutable UUID-keyed records in the `investigations` table of the local
snapshot database (`~/.mikrotik-mcp/snapshots.db`). Saving errors fail the operation;
there is no in-memory fallback masquerading as durable history. No automatic case
deletion is configured. Back up/protect this database with the existing local
operational procedures; saved evidence is historical, not a live health assertion.

- At most three explicit router perspectives, queried serially.
- One collecting investigation per device per server process.
- Ten evidence reads per router; an 8-second read budget is passed to the shared
  connector. Connection setup/Safe Mode/transport timeouts remain connector-owned.
- After 90 seconds, no further reads are launched; unfinished sources are unknown.
  This is a launch budget, not a guaranteed wall-clock cancellation deadline.
- At most 150 records per source and 512 characters per property are persisted.
  Full read output can be larger; a truncated case is not a complete config model.
- IPv4/MAC clients only in this version; no endpoint agent, TLS/HTTP service probe,
  packet capture, automatic fix or inference of the client's exact route.

## Verification

`bunx vp test run tests/investigations/collect.spec.ts` covers identity joins,
property minimisation, unknown/error semantics, exact target resolution,
multi-device access checks, injection rejection, table limits and concurrency.
Tests inject a reader and never contact a router.

Live production checks must remain read-only. Do not use failover, reboot,
upgrade or configuration writes to demonstrate an investigation.

Verification recorded on 2026-09-11:

- 14 focused collector/HTTP tests; SQLite smoke check using an in-memory database.
- Full offline suite: 1,659 tests passed. Server/UI typechecks and production build passed.
- Existing repository lint warnings remain; no errors or new investigation warnings.
- Read-only MCP identity and DNS retrieval succeeded on `home-ax3` and `netherlands`.
  Both real DNS responses were replayed through the new collector successfully;
  client health correctly remained unverified. No production configuration changed.
- The running MCP instance does not yet expose the new tools. Full live invocation
  of this new feature, and interactive visual browser QA, have not been verified.
