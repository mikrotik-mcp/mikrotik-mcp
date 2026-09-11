# Client flow path evidence

Investigations includes a **Flow evidence desk** alongside the historical configuration
journey. It answers which ingress/egress indexes an exporter reported for one exact
IPv4 TCP/UDP five-tuple. It does not run a packet capture or prove application delivery.

## Use the dashboard

1. Open a saved investigation. Nothing is queried merely by opening the evidence desk.
2. Enter the actual client IPv4. For a MAC-only case, supply its current IPv4 explicitly.
3. Click **Find recent flows**, then select a recent tuple. The list shows destination
   IP, source port, destination port and protocol; it does not associate IPs with a hostname.
   Alternatively enter all tuple fields manually, including the client's ephemeral port.
4. Expand **Resolve interface names** and select up to eight candidates. Known tunnels
   from the saved case are selected initially. This affects name lookup, not packet routing.
5. Click **Check exported path**. Matching forward and reverse exports have separate
   diagrams. Multiple exits are alternatives reported by the exporter, not sequential hops.
   Repeat explicitly to refresh the last-five-minute view; there is no background polling.

The highlighted exit maps the reported ifIndex to a _current_ interface name and type.
A WireGuard/OpenVPN label is not cryptographic verification. A saved case is not modified;
the live lookup and export timestamps remain separate from its historical evidence.

## Prerequisites and safety

- An existing running collector and RouterOS Traffic Flow target are required for new
  evidence. Setup is a separate authorized workflow: see [Traffic Flow](traffic-flow.md).
  This feature never enables exports, adds firewall rules, starts/stops a sniffer,
  changes FastTrack, writes router files or generates client traffic.
- The UDP sender must equal a unique configured IPv4 router host. DNS-only hosts,
  alternate export source addresses and shared/NAT host bindings are not guessed.
  Records from another exporter are never selected as a substitute.
- NetFlow/IPFIX UDP is unauthenticated. Use a trusted network/collector; the UI says
  **exporter-reported**, not capture-confirmed. Protect the collector from spoofed senders.
- Names come from explicit `print detail` / `print oid` queries for the chosen names.
  The documented ifDescr OID suffix supplies ifIndex, never CLI row positions.
  Missing, ambiguous, failed or incomplete mappings retain numeric indexes. Index reuse
  since an export remains possible; a current lookup is not a historical identity guarantee.
- Name lookup is unavailable in Safe Mode or over MAC-Telnet. Empty flow results do not
  contact the router. A single-device concurrency guard and eight-name limit bound lookup work.

## What cannot be concluded

No matching export does **not** mean dropped traffic. Export delay, sampling, FastTrack,
hardware offload, missing templates, retention, wrong tuple or NAT can hide records.
NAT aliases are deliberately not inferred. Only an exact reverse tuple is shown as return
evidence. No firewall rule, VPN peer delivery, IPsec policy, application success or precise
blocking hop is proven. Active bounded packet capture remains a separate, unimplemented
investigation workflow; this panel does not promise a real-time packet trace.

## MCP and storage

- `list_client_flow_candidates`: client IPv4; at most 50 candidate tuples from at most 500
  recent source-side records. Local storage only.
- `inspect_flow_path`: `client`, `destination`, `source_port`, `destination_port`,
  `protocol` (`tcp`/`udp`), optional `interface_names` (at most eight).
  At most 500 records per direction; JSON sample at most 20 per direction. Limits and
  rejected timestamp/counter records are disclosed. Both handlers recheck device access.
- Dashboard POST routes: `/api/investigations/client-flows` and
  `/api/investigations/flow-path`, with explicit `?device=`; existing authentication,
  same-origin and bounded-body guards apply.
- Raw flow storage gains nullable `input_if` / `output_if` columns via an additive
  migration. Existing records survive but have unknown indexes; new exports preserve
  decoded indexes. Template namespaces are isolated by sender and wire version.

Offline checks: `bunx vp test run tests/investigations/flow-path.spec.ts
tests/flows/exporter-decoder.spec.ts`, and
`bun test tests/flows/store.bun.test.ts` for a real SQLite migration/reopen test.
Production export arrival and router name lookup require separate live validation.

References: [MikroTik Traffic Flow](https://manual.mikrotik.com/docs/diagnostics-monitoring-and-troubleshooting/traffic-flow/),
[MikroTik OID lookup](https://manual.mikrotik.com/docs/diagnostics-monitoring-and-troubleshooting/snmp/).
