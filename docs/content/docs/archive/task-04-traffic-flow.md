---
title: "04 \u2014 Traffic Flow (NetFlow / IPFIX)"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 04 — Traffic Flow (NetFlow / IPFIX)

> **Status:** implemented — all 5 phases complete.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §8 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Configure `/ip traffic-flow` on the device, collect the exported NetFlow v5/v9 or
IPFIX stream on the MCP host, and turn it into continuous top-talker, per-conversation
and per-application analytics — the "who is using my bandwidth" question the packet
sniffer answers far too expensively.

## 1. Gap

`/ip traffic-flow` is entirely absent from the 111-module catalog. The existing
`Packet Sniffer` / `Packet Capture Studio` work at packet level over TZSP: precise,
heavy, point-in-time. Traffic Flow is the opposite — cheap, continuous, aggregate.
They complement rather than overlap, and the dashboard already proves the host can
receive a UDP stream (`src/observability/capture.ts`).

## 2. Domain grounding

- `/ip traffic-flow set enabled=yes interfaces=all cache-entries=4k
active-flow-timeout=30m inactive-flow-timeout=15s`
- `/ip traffic-flow target add dst-address=<host> port=2055 version=9`
  (`version` ∈ `1|5|9|ipfix`; **v9 or ipfix** are the useful ones — v5 is IPv4-only
  and has no template mechanism).
- v9/IPFIX are **template-based**: the exporter sends template records periodically
  and data records reference them. A collector that has not yet seen the template
  cannot decode data records — it must buffer or drop them. This is the single
  biggest correctness trap; handle it explicitly.
- Timestamps are relative to the exporter's `sysUpTime` in the header, not wall
  clock. Convert using header `unixSecs`.
- MikroTik quirk: `IPv6` flows require v9/IPFIX; `src-address`/`dst-address` field
  ids differ between v4 and v6 templates.

## 3. Architecture

```
src/flows/decode.ts     PURE — NetFlow v5/v9 + IPFIX packet → flow records
src/flows/templates.ts  PURE — template registry keyed by (sourceId, templateId)
src/flows/collector.ts  Bun.udpSocket on the configured port → decode → store
src/flows/store.ts      bun:sqlite (dynamic import), rolling retention
src/flows/aggregate.ts  PURE — top talkers, conversations, ports→app naming
src/tools/traffic-flow.ts  9 tools
```

The decoder is pure and takes a `Uint8Array`. Every wire-format test is a fixture
buffer — no socket, no device, fully offline. That is non-negotiable given how
fiddly template decoding is.

## 4. Tools (9)

| Tool                         | Risk             | Purpose                                                                        |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `get_traffic_flow_settings`  | READ             | Current `/ip traffic-flow` config                                              |
| `set_traffic_flow_settings`  | WRITE_IDEMPOTENT | Enable/disable, interfaces, cache, timeouts                                    |
| `list_traffic_flow_targets`  | READ             | Configured collectors                                                          |
| `add_traffic_flow_target`    | WRITE            | Point the device at this MCP host                                              |
| `remove_traffic_flow_target` | DESTRUCTIVE      | Remove a collector                                                             |
| `start_flow_collector`       | WRITE            | Start the local UDP collector                                                  |
| `stop_flow_collector`        | WRITE            | Stop it                                                                        |
| `flow_top_talkers`           | READ             | Top src/dst/conversation by bytes over a window                                |
| `analyze_flows`              | READ             | Rendered report: talkers, apps, protocol mix, anomalies vs the window baseline |

Module `src/tools/traffic-flow.ts`, label **"Traffic Flow"**, group `Tools`.

`setup_flow_monitoring` is deliberately **not** a tool — the composite (enable +
target + collector) belongs in a prompt where the model can explain what it is about
to point at the host. Add `prompts/setup-traffic-flow.md`.

## 5. Retention & cost

Flow volume is unbounded on a busy link. Defaults:

- Raw flow records: **24 h**, then dropped.
- Pre-aggregated 1-minute buckets (src, dst, port, proto → bytes/packets):
  **30 days**.
- Hard cap on rows; oldest evicted first. Log evictions at `info` so silent data
  loss is visible.
- Config: `flows.enabled`, `flows.port` (2055), `flows.retentionHours`,
  `flows.maxRows`, `flows.db` (default `~/.mikrotik-mcp/flows.db`).

Never store payload — Traffic Flow carries none, which is exactly why it is cheap
and privacy-preserving compared to the sniffer. Say so in the docs.

## 6. Dashboard — new page **Flows**

`ui/observability/flows.tsx`:

- **Sankey or chord of conversations** — the visual that makes flow data click:
  src networks → dst networks, thickness by bytes. `topology.tsx` already proves
  the repo can do custom layout maths without a graph dependency.
- **Top talkers** — ranked bars, toggle by source / destination / conversation /
  application, with a live-updating window selector (5 m / 1 h / 24 h).
- **Protocol & application mix** — donut by port→app naming, with the long tail
  collapsed into "other" rather than a 200-slice donut.
- **Timeline** — stacked area of bytes/s by top-N talkers, the rest as "other".
- **Collector health strip** — packets received, decode errors, **templates
  pending** (the diagnostic that explains an empty page), exporters seen.

Routes: `GET /api/flows/top`, `/api/flows/conversations`, `/api/flows/timeline`,
`/api/flows/health`. Given the count, use a sub-router `src/observability/flow-routes.ts`
following `drift-routes.ts`.

## 7. Raycast — new command **flows**

`raycast/src/flows.tsx`, mode `view`. Top-talkers list with bytes as accessory,
device + window dropdown, drill into a conversation. Sparklines via
`lib/charts.tsx`. Actions: copy address, open in dashboard, add to an address-list
(reuses existing catalog tools through the API).

## 8. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Pure decoder

- [x] `src/flows/templates.ts` — registry keyed `(sourceId, templateId)`, with
      explicit "template not yet seen" handling and a bounded pending-data buffer.
- [x] `src/flows/decode.ts` — v5, v9 and IPFIX headers + data records → `FlowRecord[]`.
- [x] `tests/flows/decode.spec.ts` — **37 cases** from fixture buffers, covering every
      listed trap plus: same template id from two exporters (must not collide), a
      re-sent template replacing the old layout, IPFIX variable-length and
      enterprise fields, 64-bit counters past 2^32, and an unset exporter clock.
- **Exit gate:** global gate green (960 tests).

Decisions carried forward:

- A buffered data set keeps **its own** packet context, so a flow replayed when the
  template arrives is dated from the packet it came in, not the template's packet.
- A malformed datagram returns `{ error }`; nothing throws. A collector that dies on
  junk is a collector anyone can stop by sending it junk.
- An exporter reporting `unixSecs=0` (clock unset) has its flows dated to arrival
  time, with a warning — otherwise every flow lands in 1970 and no window shows it.

### [x] Phase 2 — Collector + store + aggregation

- [x] `src/flows/collector.ts` — **`node:dgram`** (not `Bun.udpSocket` — see
      Blockers), decode, batched insert, periodic prune, health counters.
- [x] `src/flows/store.ts` — raw flows + 1-minute rollups, retention eviction and
      a hard row cap (both logged); `bun:sqlite` dynamic import only.
- [x] `src/flows/aggregate.ts` — PURE top-N, conversations, port→app map,
      timeline and the baseline-deviation check for `analyze_flows`.
- [x] `tests/flows/aggregate.spec.ts` — 31 cases: top-N ties, `other` folding,
      window boundaries, timeline time-spreading, anomaly threshold + suppression.
- [x] Config block (`flows.*`) + regenerated `schemas/config.schema.json`.
- **Exit gate:** global gate green (991 tests).

Decisions:

- A flow spans time, so the timeline **spreads its bytes across every bucket it
  covers** instead of spiking the start bucket — a 30-minute flow (the default
  active timeout) would otherwise draw one spike and an empty chart. A flow ending
  exactly on a boundary does not paint the next bucket.
- Anomalies are a **ratio against the baseline mean**, not a z-score: flow volume
  is bursty and skewed, and "8× its usual traffic" is actionable where a standard
  deviation over a few windows is noise. `minBytes` suppresses the tiny-talker
  ratio explosion; `baselineWindows` averages a long baseline against a short
  window (without it, a 24 h baseline makes everything look quiet).
- Conversations fold A→B and B→A by default, keyed with the lower address first.

### [x] Phase 3 — Tools

- [x] `src/tools/traffic-flow.ts` (9 tools) + `src/tools/index.ts` (label **Traffic
      Flow**, slug `traffic-flow`, group Tools) + 9 schemas.
- [x] `prompts/setup-traffic-flow.md` — with the "explain before you point a router
      at a collector" step made explicit.
- [x] `docs/traffic-flow.md` + README + `docs/README.md` rows.
- **Exit gate:** global gate + `bun run gen` (9 new schemas only; the
  tools-reference reflow churn was reverted per README).

Decision: every "no flows" answer **names the reason** rather than returning an
empty list — collector not running / nothing received / templates pending /
decode errors. An empty flow page is otherwise indistinguishable from an idle
link, which is the single most common way this feature wastes someone's evening.

### [x] Phase 4 — Dashboard

- [x] `src/observability/flow-routes.ts` — `/api/flows/top`, `/conversations`,
      `/timeline`, `/health` — mounted in `dashboard.ts`.
- [x] `ui/observability/flows.tsx` (collector-health strip, ranked bars with
      dimension + window selectors, chord diagram, stacked timeline, protocol and
      application mix) + `main.tsx` wiring + `types.ts`.
- **Exit gate:** global gate + `bun run build:ui` (observability.html 1.28 MB).

Notes: the health strip is at the TOP of the page, not the bottom — an empty flow
page and an idle link look identical, and `templatesPending` is what tells them
apart. `/health` answers even when the store cannot be opened, since that is
exactly when someone is looking at it. The chord diagram is plain SVG + trig
(same approach as `topology.tsx`) rather than a new charting dependency.

### [x] Phase 5 — Raycast

- [x] `raycast/src/flows.tsx` — talker list with per-row sparklines, window and
      group-by selectors, drill-in detail with a conversations bar chart; empty
      view states the CAUSE, not just "no data".
- [x] `package.json` command entry + `lib/types.ts`.
- **Exit gate:** global gate + `npm run lint` (0 errors) + `tsc --noEmit`
  (0 errors in the new file; `src/lib/diff.tsx` keeps its pre-existing
  duplicate-React type error).

**All phases complete.** Known gaps, none blocking:

- No test drives the live collector against a real socket — by design; the pure
  decoder and aggregation carry all the logic and are covered by 68 offline cases.
- `analyze_flows` compares against the preceding four windows only; there is no
  day-of-week seasonality, so a Monday-morning spike still reads as an anomaly.
- The dashboard polls `/api/flows/*` every 10 s rather than streaming; flow data
  only changes on the exporter's timeout, so a push channel would add nothing.

### Blockers / notes

- ~~Confirm `Bun.udpSocket`…~~ **Resolved before Phase 1:** `src/observability/capture.ts`
  receives TZSP through **`node:dgram`** (`createSocket({ type: "udp4", reuseAddr: true })`),
  not `Bun.udpSocket`. The collector reuses that API — one UDP mechanism, already proven
  under the vendored runtime, and importing the module never binds a port.

_(no other blockers)_
