---
title: "Config Snapshots & Time-Travel Diff"
description: "Practical setup, operations and limits for Config Snapshots & Time-Travel Diff."
---

Capture point-in-time snapshots of a device's full `/export` and diff any two —
or one against the live device — to see exactly what changed, and when. Unlike a
`/export` to a file on the router, snapshots are stored on the **MCP host**
(`~/.mikrotik-mcp/snapshots.db`, Bun-native SQLite), so they survive reboots and
factory resets and accumulate a configuration history you can reason over.

Independent of the dashboard — snapshots work whether or not `--dashboard` is set.

## Tools (Config Snapshots module, System & Ops)

| Tool                      | Risk        | What it does                                            |
| ------------------------- | ----------- | ------------------------------------------------------- |
| `capture_config_snapshot` | WRITE       | Stores the current `/export` (terse by default).        |
| `list_config_snapshots`   | READ        | Lists a device's snapshots, newest first.               |
| `get_config_snapshot`     | READ        | Returns a stored snapshot body (a re-appliable `.rsc`). |
| `diff_config_snapshots`   | READ        | Time-travel diff between two refs.                      |
| `remove_config_snapshot`  | DESTRUCTIVE | Deletes stored snapshots by id.                         |

## Capture & diff

```
capture_config_snapshot label="pre-firewall-change"
# … make changes …
diff_config_snapshots from=latest to=live
```

`from`/`to` each accept a snapshot **id**, `latest` (the newest stored), or
`live` (capture the device right now). Common patterns:

- **Drift check** — `from=latest to=live`: what changed since the last snapshot?
- **Compare two points in time** — `from=<id-a> to=<id-b>`.

The diff is a unified diff with added/removed counts, rendered by the shared
line-diff engine.

### Why it's accurate

- Captures use `/export terse` (one self-contained line per item) for clean,
  stable diffs.
- The volatile timestamp header RouterOS writes (`# … by RouterOS …`) is
  **stripped before hashing/diffing**, so two captures of an _unchanged_ device
  diff to nothing — and `capture_config_snapshot` will tell you "no change since
  the last snapshot" instead of storing a duplicate (pass `force=true` to store
  anyway).

## Tips

- `capture_config_snapshot` can scope to one section, e.g.
  `section="ip firewall filter"`.
- Sensitive values are hidden unless you pass `show_sensitive=true`.
- The snapshot body returned by `get_config_snapshot` is itself a RouterOS `.rsc`
  script suitable for review or manual re-application.
