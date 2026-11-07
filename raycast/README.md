# MikroTik MCP — Raycast Extension

Operate your MikroTik fleet from Raycast. This extension is a **client of the
[MikroTik MCP](https://github.com/mikrotik-mcp/mikrotik-mcp) observability dashboard** — it
mirrors every dashboard view using the native Raycast UI kit. It never talks to RouterOS
directly; it reads and acts through the dashboard's `/api/*` HTTP endpoints (the MCP server
does the SSH/RouterOS work).

## Prerequisites

Run the MCP server with the dashboard enabled:

```bash
mikrotik-mcp serve --dashboard          # binds 0.0.0.0:9090 by default
```

Set a token if you want the dashboard gated (recommended if it's reachable on your LAN).

## Setup

Open any command's preferences (⌘,) and set:

- **Dashboard URL** — e.g. `http://127.0.0.1:9090`
- **Access Token** — the dashboard bearer token (leave empty if unset)

## Commands

| Command            | What it does                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Overview**       | Tool-call volume, latency, error rate and per-risk / per-tool breakdowns                                 |
| **Prompt Library** | Search workflows, fill inputs, preview/copy/paste a request; optionally ask Raycast AI for a plan          |
| **Devices**        | Router connectivity, CPU/MEM/DISK gauges, health sparklines, SSH pool, enable/disable                    |
| **Tunnel Bandwidth** | Create/edit bounded tunnel tests, preflight, run/disable schedules and compare stored results |
| **Clients**        | LAN devices on a router — live traffic, block/allow, pin IP, set IP, label, rate limits, usage           |
| **RADIUS & UM**    | RADIUS client + User Manager — users, profiles, limitations, NAS, assignments, sessions, settings, usage |
| **Topology**       | Configured devices and discovered Layer-2 neighbours (MNDP/CDP/LLDP), onboard stubs                      |
| **Packet Capture** | Live decoded TZSP capture — protocols, top talkers, start/stop, pcap export                              |
| **Snapshots**      | Browse stored config snapshots and time-travel diff any two                                              |
| **Drift Guard**    | Golden-config baselines and live drift detection with attribution                                        |
| **Change Plan**    | Dry-run intended RouterOS commands — risk-scored and safely ordered                                      |
| **S3 Backups**     | List, download (presigned) and delete S3 backup objects                                                  |
| **Backups**        | Local config vault — create, upload, rename, download, restore, delete                                   |
| **Modules**        | Enable/disable tool modules — curate the exposed MCP surface                                             |
| **Config**         | Effective config editor (validate / preview / safe-apply), version history, field guide                  |
| **Memory**         | Knowledge graph — entities, relations, observations, activity                                            |
| **Live Feed**      | Every MCP tool call in real time (WebSocket, SSE fallback)                                               |

## Notes

- **Prompt Library** reads the server's `/api/catalog` and is also in the Fleet Menu
  Bar's Quick access menu and the Catalog's prompt actions. Compose → Preview →
  Copy/Paste sends no router commands. Copy & Open ChatGPT/Claude prepares a manual
  handoff; the selected assistant needs a MikroTik MCP connection to execute tools.
  **Ask Raycast AI for a Plan** appears only with AI access, explicitly sends the
  composed request to Raycast AI, and produces advice only (no MCP tools).

- **Real-time** views (Live Feed, client traffic, packet capture) stream over the dashboard's
  WebSocket (`/api/stream`) with an SSE fallback, using the Node runtime's global `WebSocket`.
- **Destructive** actions (client block, config apply/restore, backup restore/delete, drift
  baseline removal, entity/event deletion, counter reset) always ask for confirmation.
- Charts are rendered with native substitutes (progress-icon gauges, unicode sparklines,
  colored tags) since Raycast has no chart kit.

## Development

This extension has its own npm dependencies and lockfile, separate from the
Bun MCP server. Run these commands from `raycast/`:

`react` and `react-dom` are pinned to `19.2.1`, matching the React runtime of the
installed Raycast host. Charts use `react-dom/server` to render SVG, so upgrading
React DOM independently of the host causes an incompatible-versions error.
When updating these packages, verify the host runtime version first and keep
both exact versions aligned with it.

```bash
npm ci           # install the extension's locked dependencies
npm run dev      # ray develop (hot reload)
npm run build    # type-check, then build command executables
npm run lint     # ray lint
```

If Raycast reports **Missing executable. You might need to build the extension**,
run `npm run build` in this directory. Then run `npm run dev` to import this
checkout into Raycast and refresh its development commands. Installing packages
alone does not compile the command entry points. See the
[Raycast CLI documentation](https://developers.raycast.com/information/developer-tools/cli).

## Tunnel Bandwidth

Create and edit multiple tunnel test definitions with explicit source/destination routers
and a destination tunnel IPv4 address. New definitions are disabled by default. Source
interface/address fields are preflight expectations, not source binding; no undocumented
`local-address` parameter is sent. Use **Load Source Addresses (Live Read)** explicitly
to discover source addresses, and **Read-Only Preflight** to check the form before saving.
Neither action starts bandwidth traffic.

Tests support TCP/UDP and transmit/receive/both (from the source), duration 5–60 seconds,
interval 300–604800 seconds, and integer local/remote TX caps of 1–100000000000 bits/sec (100 Gbps).
**Run Now** and enabling a schedule require confirmation: tests generate traffic and may
saturate links or increase router CPU load. Server/firewall settings are never changed
automatically. Destination credentials come from server runtime configuration; the command
has no password fields and stores no router credentials locally.

Disable a schedule independently, or delete its definition while retaining history.
Results refresh every five seconds from stored host state without router I/O, showing
TX/RX charts, status/error and packet-loss tables, and selected-job/time-range comparisons with TX/RX min/mean/max and outcome counts.
Compare protocol, direction, caps and timestamps before interpreting differences. Historical
runs remain available through **Compare Jobs and History**, including deleted jobs.

Advanced test fields include UDP packet sizes (28–64000 bytes), TCP connection count
(1–255), report interval (0.02–5 seconds, whole-millisecond precision), and random data.

### Background bandwidth notifications

Enable **Monitor Bandwidth Results** background refresh for native macOS Notification Center alerts for completed manual and scheduled bandwidth tests, including failed and interrupted runs. Polling is approximately once per minute, with up to 50 retained completions per pass. The persisted per-dashboard/database cursor advances only after dispatch; retries use a stable notification group. A crash between dispatch and cursor persistence can repeat a notification. This uses the existing bundled `raycast-notifier` integration, not a toast or HUD.

Raycast must be running, background refresh enabled, the dashboard reachable, and macOS notifications allowed. Disabled Raycast cannot deliver notifications; polling resumes retained backlog when re-enabled. Dispatch acceptance does not prove banner visibility. See the [bandwidth guide](../docs/content/docs/guides/bandwidth-tests.md).
