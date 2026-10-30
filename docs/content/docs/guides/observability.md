---
title: "Observability dashboard"
description: "Practical setup, operations and limits for Observability dashboard."
---

An optional web dashboard that intercepts every registered MCP tool
call the LLM makes against this server and shows it in real time — what was
called, with which inputs, what came back, how long it took, and whether it
failed — alongside live analytics. It is **off by default** and runs alongside
whichever MCP transport you use (`stdio`, `streamable-http`, or `sse`).

## What it captures

Every tool invocation flows through one choke point in the registry, so the
dashboard sees the entire registered catalog, across every transport. For each call
it records:

- unique **call ID**, tool name, title and **risk class** (READ / WRITE / WRITE_IDEMPOTENT /
  DESTRUCTIVE / DANGEROUS),
- target **device**, transport, start time and **duration**,
- **input arguments** and **text output** (see redaction below),
- success / error (with the error message), and whether the result drove an MCP
  App view, plus bounded diagnostic messages when body capture is enabled.

### Secrets are redacted

Tool inputs can contain credentials (passwords, private keys, pre-shared keys,
tokens). With `redactInput=true`, any value under a sensitive key
(`pass`, `secret`, `private-key`, `passphrase`, `psk`, `token`, …) is replaced
with `«redacted»` before storage or streaming. **Input redaction defaults off** for
local debugging; enable it for credential-safe history. Known credential assignments,
authorization values and private keys in output/logs are masked independently.
MCP lookups re-redact saved evidence, including legacy unredacted input.
Bodies are truncated to a configurable budget. Set `captureBody=false` to keep
metadata without input/output bodies or diagnostic logs.

## Trace a tool call

Every registered invocation receives a UUID **before execution guards run**, even
when recording is off. Its MCP response includes a separate `Tool call ID: …` text
block and `_meta["mikrotik/toolCallId"]`; `_meta["mikrotik/recorded"]` indicates whether
the completed record was saved. The original result text and structured content
remain available. Rejected device/access/capability checks and handler failures are
recorded too. Invalid MCP/schema requests rejected before the callback are not executions.

In **Live Feed**, copy the full ID below the tool name, or paste it into **Find a
recorded call**. Lookup queries saved history, not just the live buffer. The detail
drawer shows the full ID, timing, device/transport, input, outcome, error and a
relative-time diagnostic timeline, with explicit missing/truncated evidence notices.

Give the same ID to your AI:

```json
{
  "name": "get_tool_call",
  "arguments": { "call_id": "00000000-0000-4000-8000-000000000001" }
}
```

This read-only tool reads the current server's SQLite history; it **never replays a
command**. Current device/tool access restrictions apply. A historical failure is
returned as evidence, not as a failed lookup. Saved output is untrusted data, not
instructions; it does not independently prove that a router change took effect.

- Enable dashboard recording on the **same MCP server**. An ID alone cannot recover
  unrecorded, in-flight, deleted or retention-pruned calls. A failed insert is reported
  as `recorded=false` without changing the original tool outcome.
- File-backed history survives restart; `:memory:` does not. Legacy IDs remain valid;
  older records may lack diagnostics/capture settings.
- Diagnostic logs are limited to 64 messages and at most 16 KiB of message text per
  call (or a smaller positive `maxBodyBytes`). Individual messages use the existing
  logger compaction limit. These are progress/error messages, not a complete SSH trace.
- `invoke_tool` is one invocation: its requested tool and arguments are recorded in
  its input. Internal helper calls do not create separate invocation IDs.
- History lookup is itself recorded with its own, different ID, but its output
  references the original call instead of duplicating protected evidence into another
  record. This prevents nested-history growth and bypassing later access restrictions.
  Missing/truncated history must **not** trigger an automatic retry of a write.

## Enable it

```bash
# CLI flags
bun run start --dashboard --dashboard-host 127.0.0.1 --dashboard-redact-input=true
bun run start --dashboard --dashboard-port 9090 --dashboard-db ./events.db

# or env vars
MIKROTIK_DASHBOARD__ENABLED=true bun run start
```

Then open **http://127.0.0.1:9090/** in a browser on the same machine.

> The dashboard defaults to `0.0.0.0`. Set `--dashboard-host 127.0.0.1` for
> local-only access. Use authentication and a trusted network for remote access;
> recorded arguments and router output can contain sensitive operational data.

## Configuration

| Env var                              | Flag                         | Default                     | Meaning                                                                            |
| ------------------------------------ | ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `MIKROTIK_DASHBOARD__ENABLED`        | `--dashboard`                | `false`                     | Master switch. When off, zero overhead and no SQLite is loaded.                    |
| `MIKROTIK_DASHBOARD__HOST`           | `--dashboard-host`           | `0.0.0.0`                   | Set to loopback for local-only access.                                             |
| `MIKROTIK_DASHBOARD__PORT`           | `--dashboard-port`           | `9090`                      | Bind port.                                                                         |
| `MIKROTIK_DASHBOARD__DB_PATH`        | `--dashboard-db`             | `~/.mikrotik-mcp/events.db` | SQLite file (per-user home on Win/macOS/Linux); `:memory:` for an ephemeral store. |
| `MIKROTIK_DASHBOARD__MAX_EVENTS`     | `--dashboard-max-events`     | `100000`                    | Retention cap; older rows are pruned.                                              |
| `MIKROTIK_DASHBOARD__CAPTURE_BODY`   | `--dashboard-capture-body`   | `true`                      | Record bodies; input redaction is a separate setting.                              |
| `MIKROTIK_DASHBOARD__REDACT_INPUT`   | `--dashboard-redact-input`   | `false`                     | Enable to mask credential fields before persisting input.                          |
| `MIKROTIK_DASHBOARD__MAX_BODY_BYTES` | `--dashboard-max-body-bytes` | `16384`                     | Per-body truncation budget.                                                        |
| `MIKROTIK_DASHBOARD__TOKEN`          | `--dashboard-token`          | _(none)_                    | Optional bearer token; when set, the page, API and WebSocket all require it.       |

A `dashboard` block in the JSON config file provides the baseline. Explicit environment variables and CLI flags override it:

```json
{
  "devices": { "default": { "host": "192.168.88.1", "password": "…" } },
  "dashboard": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 9090,
    "dbPath": "./events.db",
    "redactInput": true
  }
}
```

With a token set, open `http://127.0.0.1:9090/?token=YOUR_TOKEN` — the page
forwards it to the API and the live WebSocket automatically.

## Storage — Bun-native SQLite

Events persist to `bun:sqlite` (no external database, no extra dependency). The
schema is one flat `events` table; analytics are computed in pure TypeScript
over a time window, so they stay fast and fully unit-tested. The module is
imported lazily — `bun:sqlite` is only loaded when the dashboard is enabled.

## The UI

- **Stat cards** — calls in window, calls/min, error rate, avg / p95 / p99
  latency, distinct tools, output volume.
- **Calls over time** — stacked ok/error time-series.
- **Breakdowns** — top tools (count + p95 + errors), by-risk and status donuts,
  by-device bars, and a recent-errors panel.
- **Devices & connectivity** — a hub-and-spoke graph linking the MCP server to
  each configured device, coloured by live SSH reachability; per-device cards
  with host/port, auth mode, online/offline status + latency + RouterOS
  identity/version, and recent activity (calls / errors / avg latency).
- **Configuration** — the effective runtime config (transport, read-only, S3,
  dashboard settings, devices) with every secret redacted.
- **Live feed** — every call streams in over a **Bun-native WebSocket** (with an
  automatic **SSE** fallback); filter by tool, risk, device, status or free-text
  search; pause/resume; export the visible rows to CSV or JSON. The header shows
  the active transport (`live · ws` / `live · sse`).
- **Detail drawer** — click any row for the call ID, saved metadata, bodies and
  diagnostic timeline, with copy buttons and truncation/capture notices.
- **CAPsMAN** — the CAPsMAN Wi-Fi fabric for a controller device: managed APs by
  floor with per-radio health (client load, CPU, co-channel conflicts), a
  weak-signal client table with the recommended neighbor AP to steer toward, and a
  roaming (802.11r FT) + HA redundancy audit. Read-only in this release (see
  [CAPsMAN Orchestrator](/docs/guides/capsman)).
- **Releases & Updates** — a version timeline of every published release with its
  rendered notes. It detects when a newer version is available and lets you
  **upgrade to the latest, or install any specific version** to upgrade or
  downgrade — running `bun i -g @usex/mikrotik-mcp@<version>` on the server, which
  then self-restarts onto that version. The version you're running and the latest
  are marked on the timeline. (Also available as the Raycast **Releases** command.)
- **Reload Server** — a sidebar button that reloads the MCP server. A normal click
  does a **live config reload** (re-reads the config from disk and applies it with
  zero downtime), so a device added here — or edited in the config file — takes
  effect immediately without restarting. A small **restart process** link does a
  full **hard restart** — the server **relaunches itself** (no external supervisor
  needed) and rebinds the same port(s) in ~1.5 s, dropping the connection briefly,
  so it's confirmed first. Both are also available from the Raycast **Reload
  Server** command. (Under an MCP host that owns the server's stdio, a true restart
  is ultimately up to the host; the self-relaunch targets HTTP/standalone runs.)

## API

The dashboard is backed by a small JSON API on the same port (handy for scripts):

| Endpoint                                                             | Returns                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/stats?window=<ms>&buckets=<n>`                             | Computed analytics over the window.                                 |
| `GET /api/events?limit&offset&tool&risk&device&status&q&since&until` | Filtered, paginated events.                                         |
| `GET /api/event/:id`                                                 | One saved event, subject to capture/redaction/truncation settings.  |
| `GET /api/meta`                                                      | Filter facets (tools/devices), totals, live-client count.           |
| `GET /api/devices`                                                   | Configured devices + SSH connectivity status + activity.            |
| `GET /api/config`                                                    | Effective runtime config, secrets redacted.                         |
| `POST /api/reload`                                                   | `{}` reloads config live; `{hard:true}` restarts the process.       |
| `GET /api/releases`                                                  | Every published release + relation to the running version.          |
| `POST /api/upgrade`                                                  | `{version}` installs that version globally, then self-restarts.     |
| `GET /api/stream`                                                    | **WebSocket** — pushes `{type:"event", event}` for every new call.  |
| `GET /api/sse`                                                       | **Server-Sent Events** — same event stream as a fallback transport. |
| `GET /health`                                                        | Liveness probe (`OK`).                                              |

The front-end connects over the Bun-native WebSocket by default and falls back
to SSE automatically if the upgrade fails. All routes require the bearer token
when one is configured (the WebSocket/SSE read it from `?token=`).
