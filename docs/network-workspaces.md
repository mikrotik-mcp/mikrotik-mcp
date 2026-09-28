# Client checks, router migration and support evidence

Three device-scoped dashboard workspaces share their handlers with 13 MCP tools.
Build the UI once, then start the server with the dashboard:

```bash
bun run build:ui
bun run start --dashboard --dashboard-port 9091 --config /absolute/path/devices.json
```

Open **Investigate → Client Check**, **Operate → Router Migration**, or
**Investigate → Support Bundles**. Their route fragments are `#client-checks`,
`#router-migration` and `#support-bundles`. Release badges use the existing
version-aware navigation mechanism and are registered for 5.17.0.

## Client Check

1. Select a router, name the check and optionally attach an investigation.
2. Enter the reachable **origin of this MCP host**, not a third-party URL. A phone
   cannot reach this computer through `127.0.0.1`; use its existing trusted LAN/VPN
   address or an operator-configured HTTPS origin. Do not expose an unauthenticated
   dashboard to the internet merely to run a check.
3. Create the invitation; scan its locally generated QR or copy the link.
4. On the affected device, select the connection type and approve the transfer.
   Run once over Wi-Fi and again over VPN with the **same endpoint**.
5. Select two saved results in the dashboard to compare them. Revoke the invitation
   when finished. Revocation retains historical evidence.

Each run sends up to 16 MiB downstream and 4 MiB upstream, plus HTTP control traffic.
It collects idle HTTP timings and concurrent loaded timings, median latency,
successive-sample jitter and transfer rates. The UI distinguishes incomplete phases
from zero throughput. Connection labels are user-declared, not VPN detection.
The server records its observed peer address/address family; proxies/NAT can change
that perspective. Only one address family is exercised per connection.

**Measurement boundary:** this is browser → MCP-host HTTP performance, not an
unlimited Speedtest replacement, ICMP ping, loss measurement, PMTU discovery,
DNS-leak detection, separate IPv4/IPv6 probes or proof that an application works.
A local MCP host measures LAN/VPN access. For a WAN path, the test host must already
be across that WAN. Small bounded transfers and HTTP overhead limit accuracy at high
speeds; sequential runs also vary with radio conditions and server load.

Invitations default to 15 minutes (MCP: 5–60), permit six saved runs, and hold a
random 256-bit bearer capability. Only its hash is persisted. The browser removes
the token-bearing fragment from its address/history entry after loading; reopening
requires the original link. Ordinary activity logs omit invitation outputs.
The public check API cannot read dashboard/configuration data or execute tools.
It rechecks expiry, revocation and access scope; cross-origin requests are rejected.
Per-process limits are 300 requests, four active handlers and 128 MiB per session;
restarting resets those transfer counters, but not expiry or the six-run limit.
Runs stop after 90 seconds; individual transfers have timeouts. HTTP is unencrypted:
use trusted LAN/VPN or HTTPS, and keep the invitation private.

Tools: `create_client_check`, `list_client_checks`, `compare_client_checks`,
`close_client_check`. WRITE on creation/revocation means local persistence, not a
router configuration write. Stored browser measurements are untrusted evidence.

## Router Migration

This is a conservative **replacement staging assistant**, not a full export import
or automatic cutover. Keep source and target reachable through independent management
connections; use an unmapped physical Ethernet port for target management. Both must
run the same RouterOS 7 version and expose distinct physical Ethernet MAC addresses.
SSH Safe Mode is required for target writes; MAC-Telnet cannot stage migrations.

The workflow is inspect → port mapping → select sections → exact command preview →
review blockers/manual work → explicit approval → rehearse or stage. Previews expire
after five minutes and are bound to fresh source/target exports and interface state.

Supported literal `add` records, subject to per-property validation:

| Scope                                                        | Boundaries                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Bridge, VLAN, interface lists/members, bridge ports          | Ethernet mapping; no VLAN-filtering bridge without its full VLAN table; no occupied target ports     |
| IPv4 pools/addresses and DHCP networks/servers/static leases | Explicit dependencies; static leases bound to an included server; target DHCP networks must be empty |
| Routing tables and IPv4 routes                               | Literal IPv4 next hop only; recursive/interface/ECMP paths require manual review                     |
| Address lists, filter and NAT rules                          | Limited supported actions/built-in chains; dependency checks; existing names cannot be overwritten   |

Unsupported properties, expressions, collisions or unresolved dependencies block
the entire plan. Unselected/unsupported export sections are listed explicitly as
manual work. Scripts, secrets, certificates, users, Wi-Fi drivers, VPN credentials,
IPv6 and dynamic routing are not replayed. Renamed interfaces, hardware-offload and
platform-specific defaults need operator review. This is not hardware equivalence.

Before any apply, hidden-secret export snapshots are captured locally for **both**
routers. These exports are **not** complete disaster-recovery backups: they do not
contain certificates, private keys, passwords or all runtime data. Export those
separately using an appropriate protected process before retiring hardware.

The target gets a new owned Safe Mode session, at most 60 additive objects (below
RouterOS's history ceiling), per-object read-back and a bounded write phase.
Rehearsal rolls back and compares the original export; staging commits network
objects disabled. Pools, interface lists/members, routing tables and DHCP network
definitions have passive metadata semantics, but are still genuine router changes.
Source configuration is not changed.

After staging, download the activation checklist. Move physical links, review rule
order, secrets and platform differences, then activate only in a separately approved
maintenance window. This UI **never automatically activates duplicate addresses,
DHCP servers or routes**. Connectivity/application testing after cutover is manual.

Undo removes only unchanged objects owned by the staged plan, under Safe Mode, and
requires the resulting export to match the target backup before committing. It first
captures another target snapshot. Edited/activated objects cannot be auto-removed.
An uncertain write/commit is recorded durably and is never blindly retried. An
`applying`, `undoing` or `uncertain` record fences other migration writes for that
target across local MCP processes. Interrupted operations require manual inspection;
there is deliberately no automatic takeover/reset button. Do not edit either router
concurrently. This is not an HA coordinator for arbitrary external administrators.

Tools: `inspect_router_migration`, `preview_router_migration`,
`list_router_migrations`, `apply_router_migration`, `undo_router_migration`.
Rehearsal is a real write followed by rollback, not a read-only simulator.
Undo requires the DESTRUCTIVE access tier.

## Support Bundles

Choose a router and a time window of up to seven days, select saved investigation
cases and optional event metadata, snapshot inventory and client-check summaries.
Prepare the report, inspect **the exact export**, acknowledge the privacy notice,
then download JSON or self-contained script-free HTML. No automatic upload, live
router command, support ticket submission or raw-log collection occurs.

Before persistence, the builder uses an allow-list to remove tool arguments/output,
free-form logs, configuration values, comments, personal labels, passwords, keys,
browser tokens and user agents. Included IP/MAC/name fields become bundle-local
aliases; their reverse mapping is discarded. Counts, timestamps and relationships
remain visible: minimisation does **not** promise anonymity. SHA-256 covers the JSON
report for comparison, not cryptographic attestation or tamper-proof storage.

Limits are 200 events, 20 snapshot inventories from the latest 500 snapshots, ten
cases with 100 rows per evidence source, and 100 client runs from the latest 100
sessions. This is a bounded sample, not a complete forensic archive. Missing sources
and historical/measurement limitations remain visible in the report.

Tools: `create_support_bundle`, `list_support_bundles`, `export_support_bundle`,
`delete_support_bundle`. Deletion affects the saved local report only, not original
evidence or already downloaded copies.

## Persistence, access and verification

Workflow records share `~/.mikrotik-mcp/snapshots.db` in the `operation_workspaces`
table. They are local operator data, not separate tenants or login accounts. Access
scope and server read-only policy apply to the shared MCP/dashboard service paths.
Lists return the latest 100 records per router. Client histories contain observed IPs;
migration plans contain configuration values. Protect this database like snapshots.
Invitation expiry does not purge history; there is no automatic retention purge.

Run offline checks with:

```bash
bunx vp test run tests/workspaces tests/observability/navigation.spec.ts
bun run tests/workspaces/store.bun.ts
bun run test:types
bunx tsc --noEmit -p ui/tsconfig.json
bun run build:ui
```

Checks exercise privacy canaries, bounded capabilities, concurrent result handling,
SQLite isolation/fencing, mapping/dependency guards, backup ordering, rehearsal,
staging and ambiguous Safe Mode outcomes with mocked device I/O. These tests do not
prove a hardware migration on a real router. Perform that rehearsal on an isolated
target before a production maintenance window.
