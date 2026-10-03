# Network Flight Recorder

Open **Investigate → Flight Recorder**, select a router, then **Capture settings**.
Recording is opt-in. Enabling it authorizes periodic read-only SSH collection, not
router configuration changes. The Bun server must remain running. No listener or
public port is created, and existing router logging configuration is untouched.

## What is preserved

- CPU/memory and management-read outcomes; available interface state/counters.
- At most 50 recent router log entries per poll, converted to classified metadata.
  Raw messages are deliberately discarded: arbitrary scripts can log credentials.
- Completed MCP write/failure metadata when the dashboard recorder is enabled.
  Tool arguments, outputs, credentials and actor guesses are excluded.
- A host-receipt timeline; original router-time text remains separate and uncorrected.

Two consecutive failed management reads, an observed interface-down transition, or
three CPU samples at or above 90% freeze an incident (five-minute trigger cooldown).
These are observations, **not root-cause conclusions**. You can also freeze a manual
incident. Its available pre-event window and two minutes of subsequent observations
are retained; stopping capture finalizes the available window. JSON exports include
coverage limits. Review device/interface names before sharing.

## Bounds and gaps

Interval: 30–300 seconds. Rolling window: 15–360 minutes. Incident retention: 1–30
days. Hard caps per router: 720 samples/window, 500 events/window, 30 incidents.
The durable `operations.db` beside the snapshot database survives server restarts
and belongs in the persistent Docker state volume. Capture settings live in that
workspace database, not the connection configuration file.

No capture takes place while MCP is stopped, a router is denied by access scope,
or another process holds its capture lock. Safe Mode pauses router reads. Missing
and stale data are never displayed as zero/healthy. The latest attempted read and
its gaps are visible. A crash-held lock requires operator reconciliation; there
is no unsafe automatic ownership takeover.

This is **SSH-polled off-router log metadata**, not a lossless syslog collector.
Bursts, router buffer rollover, clock ambiguity, events between polls and unsupported
JSON serialization can leave gaps. Stored evidence cannot reconstruct uncaptured
history. Unavailable traffic counters remain absent; no billing/throughput claim.

## MCP workflow

1. `get_flight_recorder`: inspect current state without contacting the router.
2. `configure_flight_recorder`: explicitly enable/change/pause local collection.
3. `freeze_network_incident`: preserve the available window with a short title.
4. `export_network_incident`: retrieve a device-scoped incident by ID.

LLMs must cite timestamps, distinguish management reachability from client-path
health, report gaps, and label temporal associations as hypotheses—not attribution.
Never enable capture, disclose exports, or make router changes merely because an
incident exists. Test coverage is offline; an actual outage is not induced by tests.
