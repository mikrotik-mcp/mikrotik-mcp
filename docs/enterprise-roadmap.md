# Outcome-driven operations delivery tracker

This is an implementation tracker, not a claim that planned features are shipped.
Each completed feature needs an end-to-end surface, tests, its own documentation,
a README link and a separate commit using the repository owner's Git identity.
Production-router checks are read-only; disruptive verification belongs in a lab.

| ID  | Capability                                        | Status                                                                                                                 |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| U01 | Client/service investigation cases                | Implemented: router-evidence scope; [boundaries and verification](client-investigations.md)                            |
| U02 | Live service health contracts                     | Implemented: MCP-host probes, optional fresh packet suite and rollout gates; [boundaries](service-contracts.md)        |
| U03 | Multi-router round-trip path                      | Implemented: explicit static IPv4 transit over snapshots; NAT/dynamic state UNKNOWN; [boundaries](round-trip-paths.md) |
| U04 | Incident/change evidence timeline                 | Planned                                                                                                                |
| U05 | Unified, freshness-checked change workbench       | Planned                                                                                                                |
| U06 | Historical WAN quality and capacity advisor       | Planned                                                                                                                |
| U07 | Router replacement and migration assistant        | Planned                                                                                                                |
| U08 | Dependency-aware configuration cleanup            | Planned                                                                                                                |
| U09 | Expiring access with verified revocation          | Planned                                                                                                                |
| U10 | Shareable, minimised incident evidence bundle     | Planned                                                                                                                |
| E01 | Isolated tenant workspaces                        | Planned                                                                                                                |
| E02 | Organisational identity and unified authorisation | Planned                                                                                                                |
| E03 | Exact-plan approvals and separation of duties     | Planned                                                                                                                |
| E04 | Durable operation coordination and HA fencing     | Planned                                                                                                                |
| E05 | Outbound site agents                              | Planned                                                                                                                |
| E06 | Tamper-evident audit evidence                     | Planned                                                                                                                |
| E07 | Organisation-managed secrets                      | Planned                                                                                                                |
| E08 | Ownership-aware GitOps reconciliation             | Planned                                                                                                                |
| E09 | Compatibility laboratory and restore rehearsal    | Planned                                                                                                                |
| E10 | Compliance evidence and expiring exceptions       | Planned                                                                                                                |
| UI  | Enterprise dashboard redesign                     | Planned after feature integration                                                                                      |

External integrations require operator configuration, not invented credentials or
unverified production deployment claims. A successful offline test is recorded
separately from a read-only live check or a disruptive laboratory rehearsal.
