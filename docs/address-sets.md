# Versioned address sets

Open **Network → Service Routing → Address sets**. Compose IPv4 or IPv6 prefixes
using union (A ∪ B), intersection (A ∩ B), or difference (A − B). Canonicalization
clears host bits, removes duplicates and compacts adjacent ranges without adding
addresses. Counts use exact integer arithmetic, including IPv6 /0.

## Workflow

1. Enter prefixes and a provenance label. Preview is pure computation, with no
   network requests. Source labels/URLs are never fetched or executed.
2. Save an immutable revision in the device-scoped local `operations.db`. A new
   revision can name a parent; the UI shows added/removed address coverage.
3. Select existing filter/mangle rules and address-list fields from the routing
   inventory. Publication changes only these references, preserving negation.
4. Preview reads live rule/list state. The exact commands and two-minute expiry
   are shown. `/0` or a >50% parent-coverage change requires additional acknowledgement.
5. Explicitly confirm publication. The server captures a local configuration
   backup, takes the shared operation lock, acquires Safe Mode, checks for drift,
   creates a separately named generation, verifies its checksum **before**
   switching references, verifies the final rules and commits.
6. Preview rollback to restore the original references. Original lists must still
   have their recorded contents. Neither rollback nor publication deletes lists.

## MCP tools

- `compose_address_set`: pure composition and checksum.
- `create_address_set`: save a non-empty revision; local write only.
- `list_address_sets`: newest 100 device-scoped revisions; no router polling.
- `preview_address_set`: state-bound publication/rollback preview.
- `apply_address_set`: explicit `confirm=true` plus the fresh preview ID.

Do not interpret a draft as permission to publish. Read-back proves configuration,
not application connectivity. Verify client traffic separately after an approved
publication. A backup is a local RouterOS export, not a binary full-system image.

## Safety and current bounds

- Composition accepts up to 2,048 prefixes per operand and 4,096 resulting prefixes.
- Publication is deliberately limited to **64 compacted prefixes + 8 references**
  to stay below RouterOS Safe Mode's finite undo history. Larger compositions may
  be saved, but cannot be published by this release. Never bypass the guard by
  creating one giant RouterOS script and claiming it is one undo operation.
- Only static original lists, IPv4/IPv6 filter and mangle, and SSH are supported.
  Dynamic lists, empty originals and an existing Safe Mode session are rejected.
- Changes across references are sequential, **not packet-atomic**. Existing
  conntrack/marks are not cleared. This is recoverable configuration publication,
  not a guarantee of uninterrupted policy transition.
- An ambiguous write/commit is persisted as `uncertain`, never automatically
  replayed. Inspect the router, backup and any pending Safe Mode session manually.
  An interrupted process can retain the shared workspace lock pending reconciliation.
- Old generations are retained for recovery; no garbage collector silently removes
  them. Archive/cleanup is a separate reviewed operation. Revisions are immutable
  in content; publication metadata and preview tokens are updated.
- Automatic feed fetching, ASN discovery and scheduled publication are not part of
  this workflow. Existing router feed automation is not changed or adopted.
