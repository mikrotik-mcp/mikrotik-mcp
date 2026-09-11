# Client and service investigations

An investigation collects a historical case for one IPv4/MAC client and a named
service. It joins DHCP, ARP and bridge-host records, preserves VLAN/interface,
DNS, route, filter and NAT context, and runs three ICMP probes from each selected
router. It never changes router configuration or starts a packet capture.

## Use

Open **Investigations** in the observability dashboard. Select the access router,
client IPv4 or colon-separated MAC, destination hostname/IPv4 and service label.
The client picker automatically reads the selected router's DHCP/ARP list once.
Search by name, IP, MAC or interface and select a record, or enter any IPv4/MAC
manually. Selecting a record fills its IPv4 (or MAC if no valid IPv4 is available)
without starting an investigation. Changing routers clears the client selection;
Refresh explicitly reloads the list. No traffic polling or configuration writes
are performed by the picker. Records are not proof of current connectivity.
Optionally select up to two additional routers. Click **Create investigation**.
Opening saved cases does not contact a router.

Saved cases include a step-by-step **Client journey**, a collapsible tunnel inventory
and a grouped **Evidence explorer** using the dashboard's syntax-coloured JSON
component. The journey separates physical bridge-host attachment from the logical
bridge/ARP interface. Multiple attachment records are alternatives, not a fabricated
sequence. It shows the policy decision gap before branching into route candidates.

Supply the destination IPv4 actually used by the client and explicitly choose an
assumed routing table. Comparison is offline: a hostname is never silently resolved
from the MCP host. Candidate ranking uses the longest matching prefix followed by
lowest recorded distance, within that table only. Inactive routes are excluded;
equal-ranked candidates remain plural. Missing distance or incomplete route evidence
withholds ranking. A best recorded candidate is **not the client's observed route**:
policy routing, NAT, connection state and runtime route liveness remain unverified.

Explicit gateway/interface references are preferred; a unique connected interface
subnet can provide a clearly labelled inferred link. Truncated/ambiguous addresses,
recursive or unresolved gateways remain unknown. Data from another perspective is
never silently used to resolve the access router's gateway. Neither absent routes
nor router ICMP loss prove a client's blocking hop. IPsec policies and VPN handshakes
are outside the recorded evidence.

Newly created cases include three additional read-only sources: interface IPv4
addresses, mangle and routing rules. They retain only allowlisted fields and do not
evaluate policy or install packet captures. The existing 90-second collection launch
budget is unchanged. Older cases remain immutable: missing fields/sources are shown
as missing. Load the updated server and create a new case for the extra evidence;
refreshing the UI alone does not enrich existing history.

Tunnel icon motion is decorative, can be paused and respects reduced-motion
preferences. Opening results does not launch any additional reads or probes.

Journey verification: `bunx vp test run tests/investigations` includes regression
coverage for physical/logical ingress, conditional prefix/distance ranking, table
isolation, equal-cost candidates, gateway mapping, incomplete evidence and collection
of address/policy fields without secrets. These are offline tests, not client packet
captures or proof of live path selection.

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
- Thirteen evidence reads per router; an 8-second read budget is passed to the shared
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

## Exported flow path

The separate **Flow evidence desk** can inspect recent exact-tuple NetFlow/IPFIX
records and look up named ingress/exit interfaces, including VPN candidates. It does
not start a capture or alter this historical case. See [Client flow paths](client-flow-paths.md)
for prerequisites, exporter ownership, NAT/visibility limits and the MCP tools.
