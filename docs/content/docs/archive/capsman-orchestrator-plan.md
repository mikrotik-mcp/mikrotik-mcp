---
title: "CAPsMAN Orchestrator \u2014 Design Plan"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# CAPsMAN Orchestrator — Design Plan

> **Status:** approved blueprint, implementation not started. This document is both
> the design AND the live build tracker for an enterprise CAPsMAN control-plane
> suite + a dedicated Observability dashboard page. Implementation is phased (§7),
> gated by the decisions in §8, and tracked box-by-box in **§10 — the source of
> truth for a `/loop` implementation run**.

## 0. Scope in one line

A CAPsMAN control-plane suite for a **multi-floor office, ~300 clients, many APs**:
manage the controller + provisioning, **report weak-signal clients and steer them
to the better-frequency neighbor AP**, **resource-aware load-balance users across
radios and both bands (2.4/5 GHz)**, and stand up **FT (802.11r fast roaming) + HA
(dual-manager failover)** — with a creative dashboard page for reports, graphs,
audits, and management.

## 1. Domain grounding (RouterOS, both stacks)

The suite supports **both** wireless stacks the repo already probes, auto-detected
per device (mirror `V7_WIFI` / the path-resolution in `src/tools/wireless.ts`):

- **v7 "wifi" CAPsMAN** — `/interface wifi capsman` (manager), `/interface wifi cap`
  (agent), `/interface wifi provisioning`, `/interface wifi configuration`,
  `/interface wifi channel`, `/interface wifi steering` (802.11k `rrm` / 802.11v
  `wnm` / neighbor-group), `/interface wifi security` (802.11r `ft`, `ft-over-ds`,
  `ft-mobility-domain`), `/interface wifi capsman remote-cap`,
  `/interface wifi registration-table`, `/interface wifi radio`,
  `/interface wifi access-list` (signal-range steering, connect-priority).
- **legacy `/caps-man`** (v6 / older v7) — `manager`, `configuration`,
  `provisioning`, `channel`, `datapath`, `security`, `access-list`,
  `registration-table`, `radio`, `interface`.

A path-resolver helper picks the family once per device; every tool + the engine
speak through it. **Decision (§8.2): support both stacks; test v7 `wifi` first.**

### Honest mechanism constraint (encode everywhere)

RouterOS has **no true "force-move a client to AP X"** primitive. Steering is
achieved by:

- **soft** — 802.11k (`rrm`) neighbor reports + 802.11v (`wnm`) BSS-transition
  hints; the client decides. Never disconnects anyone.
- **hard** — access-list `signal-range` + `allow-signal-out-of-range` (an AP
  _rejects_ a too-weak client so it re-associates elsewhere) and `connect-priority`.
  Can briefly disconnect a client.

**Decision (§8.3): support BOTH, with a configurable signal threshold**; every
steer/balance action is labeled **advisory-with-mechanism**, never "guaranteed
move", carrying `confidence: proven | needs_live_verification` (same discipline as
the security-hardening engine).

## 2. Architecture (mirror the proven repo pattern)

```
src/core/capsman.ts          PURE engine, zero device I/O. Parses reg-tables / CAPs /
                             resources → coverage model, weak-signal findings,
                             steer/balance plans, FT/HA audit. Fully unit-tested.
src/utils/wifi-query.ts      Reusable fetch/parse (reg-table, remote-cap, radios,
                             per-CAP resources, channel plan) — like utils/firewall-query.
src/tools/capsman.ts         Thin tool layer: fetch state → engine → apply writes via
                             snapshot + Safe Mode.
ui/observability/capsman.tsx The dashboard page.
GET/POST /api/capsman/*      Read + apply endpoints for the page.
```

Reuses existing infrastructure — nothing re-invented:

- `src/snapshots/capture.ts` → `captureSnapshot` (pre-change rollback point).
- `src/utils/safe-mode-apply.ts` → `applyWritesSafely` (Safe-Mode-or-report; NOT
  the direct-fallback — Wi-Fi writes can lock out, so fallback stays **off**).
- `src/core/routeros-parse.ts` → `parseRecords` / `parseKeyValues`.
- `get_system_resources` (`src/tools/system.ts`) → per-CAP CPU/mem.
- The auto-detected wifi path from `wireless.ts`.
- The usage-sampler's "skip devices that don't support this command" memoization
  (the fix from the `user-manager` log-spam bug) for the trend sampler.

## 3. Topology / floor model (Decision §8.1: **A + C**)

RouterOS doesn't know "which AP is on floor 3." Two complementary sources, merged:

- **A — explicit tag.** Each CAP carries a floor/zone in a parsable place
  (`/system identity` name convention like `AP-F3-E` or a `;;; floor=3 zone=east`
  comment on the cap/configuration). The engine parses it into `{ ap, floor, zone }`.
- **C — inferred adjacency.** From **mutual signal**: which APs see each other (and
  how strongly a client on AP-X also appears in AP-Y's neighbor/reg data) yields a
  physical-adjacency graph. Used to (a) validate/fill gaps in the A tags and (b)
  compute the "best neighbor AP" for a weak client even when tags are missing.

The floor map is **A when present, C to fill/verify**; the dashboard lets the admin
correct a tag (writes back the identity/comment). The `neighbor AP` recommendation
uses the adjacency graph, never a guess.

## 4. Tool suite (audit → report → manage), grouped by the four asks

Every write tool: **dry-run default, explicit `confirm`, snapshot before write,
Safe Mode (fallback off), idempotent, returns snapshot id.** Read tools issue only
`print`/`export`. Findings carry `finding_id`, `severity`, `confidence`.

### A. Coverage & manual frequency (ask #1)

- `audit_capsman_coverage` (READ) — inventory every CAP + radio: band, **manual
  channel/frequency/width**, tx-power, client count. Detect **co-channel overlap**
  between adjacent APs (same 2.4/5 channel on one floor/zone via the §3 adjacency
  graph), **DFS exposure**, **channel-plan gaps**. Output: per-floor frequency map +
  a proposed non-overlapping manual plan (2.4 → 1/6/11; 5 → DFS-aware) as a preview.
- `apply_capsman_channel_plan` (DANGEROUS) — apply proposed manual channels to
  selected CAPs. Snapshot + Safe Mode. Idempotent.

### B. Weak-signal report + neighbor steering (ask #2)

- `report_weak_signal_clients` (READ) — merge every CAP's registration-table on the
  manager. Per client: MAC, current AP, **signal (dBm)**, band, tx/rx rate, uptime.
  Flag clients under a threshold (default `-70 dBm`, configurable). For each, compute
  the **best neighbor AP** (stronger predicted signal, from the §3 adjacency graph)
  and the exact steer mechanism (soft vs. hard).
- `steer_client` (DANGEROUS) — install the access-list `signal-range` /
  `connect-priority` (+ 802.11k/v nudge) that pushes one weak client toward the
  better AP. `mode: soft | hard` (§8.3), configurable threshold. Scoped to one
  client, confirm-gated, snapshot + Safe Mode. Labeled advisory.

### C. Resource-aware load balancing across radios + bands (ask #3)

- `audit_capsman_load` (READ) — per radio: client count, airtime/utilization, and
  the **owning CAP's CPU/mem** (`get_system_resources` per remote-cap). Detect
  overloaded radios and resource-constrained CAPs beside idle neighbors. Compute a
  **rebalance plan**: spread clients toward the least-loaded radio _that has spare
  CPU_, and steer dual-band-capable clients to 5 GHz (band steering).
- `apply_capsman_load_balance` (DANGEROUS) — enact the plan via band-steering +
  per-radio signal thresholds / connect-priority. Preview-first.

### D. FT + HA (ask #4, confirmed)

- `audit_capsman_ft` (READ) — 802.11r check: `ft` enabled on the security config,
  `ft-over-ds`, a **consistent `ft-mobility-domain` across all CAPs**, 802.11k/v
  steering on. Report per-SSID roam-readiness.
- `enable_capsman_ft` (DANGEROUS) — turn on FT + k/v with a shared mobility domain
  across selected configuration(s).
- `audit_capsman_ha` (READ) — is there a **backup manager**? Are CAPs pointed at
  both managers (`caps-man-addresses` / discovery)? Certificates in place
  (`require-peer-certificate`)? Report single-points-of-failure. Covers **both HA
  topologies (§8.4): one MikroTik as backup manager, and a CHR/router controller
  pair.**
- `setup_capsman_ha` (DANGEROUS) — provision a second manager + point CAPs at both,
  cert-based. Highest blast radius → snapshot, Safe Mode, explicit confirm +
  required `reason`.

### Orchestrator

- `run_capsman_audit` (READ) — runs A–D, returns one severity-ranked report
  (`finding_id`, `severity`, `confidence`) — same shape as
  `run_security_hardening_audit`, so the dashboard + any agent consume it uniformly.
- `apply_capsman_fixes` (DANGEROUS) — apply specific `finding_id`s in a safe order,
  one snapshot + one Safe-Mode session, per-finding result + snapshot id. No blanket
  "fix everything".

## 5. The dashboard page — "CAPsMAN" (the creative part)

New `ViewId: "capsman"` (a `capsman.tsx` view + a nav entry in `main.tsx`, same
wiring as the Releases page). Sections:

1. **Floor/coverage heatmap (hero).** A building-by-floor grid; each AP a node
   colored by health (client load × signal quality × CPU headroom). Red edges =
   co-channel conflicts between neighbors (from the §3 adjacency graph). 2.4/5 band
   overlay toggle. You _see_ the manual frequency plan for the whole building.
2. **Live client constellation.** Each associated client a dot orbiting its AP,
   radius = signal; weak clients (< threshold) pulse red with a one-click
   **"→ steer to AP-N"**. Hover = MAC / band / rate / uptime.
3. **Weak-signal report table.** Sortable/filterable (band, floor, AP, threshold).
   Per row: current AP, signal, **recommended AP + Δsignal**, **Steer** action
   (preview → confirm).
4. **Load-balance board.** Per-radio bars: client count vs. **CPU/mem of the owning
   CAP**, a 2.4-vs-5 split gauge. An **auto-balance plan** panel: proposed moves +
   one-click apply (dry-run modal → Safe-Mode apply → toasts).
5. **Roaming & HA audit strip.** FT / 802.11k / 802.11v status per SSID
   (green/amber), mobility-domain consistency, and an **HA topology mini-map**
   (manager → backup → CAPs) flagging single points of failure. Each finding links
   to its fix tool.
6. **Trends / graphs.** Time-series from a light sampler: clients-per-AP,
   weak-signal count, per-band airtime, roam / FT-success events — the building's
   Wi-Fi "breathing" across a day of 300 people moving between floors.

App conventions: shadcn + **sonner** toasts, **AlertDialog** confirm on every apply,
theme-aware, search/filter on tables. Mirrored later as **Raycast** commands
(`capsman` browse + audit), like the Catalog/Releases commands.

## 6. Data / API

- `GET /api/capsman/overview` — CAPs, radios, channels, per-radio client count + CAP
  resources, co-channel graph, floor map.
- `GET /api/capsman/clients` — merged reg-table with weak-signal flags + recommended
  AP.
- `GET /api/capsman/audit` — the orchestrator report (findings).
- `POST /api/capsman/apply` — `{ finding_ids | plan, confirm }` → dispatch to the
  right fix tool (snapshot + Safe Mode), per-item result + snapshot id.
- `POST /api/capsman/floor` — write back a corrected floor/zone tag (identity/comment).
- Optional `capsman_samples` (bun:sqlite) for §5.6 trends, filled by a slow sampler
  that reuses the usage-sampler's unsupported-command memoization so non-CAPsMAN
  devices aren't polled forever.

## 7. Phasing (land it safely, value first)

1. **Read-only first** — path-resolver + `wifi-query` utils + engine +
   `run_capsman_audit` + all `audit_*` / `report_*` tools + the dashboard page in
   **view-only** mode (heatmap, weak-signal table, load board, FT/HA audit, floor
   model A+C). Zero write risk, immediate value.
2. **Steering + load-balance apply** (access-list / steering writes, Safe Mode).
3. **Channel-plan apply.**
4. **FT enable.**
5. **HA setup** (highest blast radius, last).
6. **Trend sampler + graphs**, then the **Raycast** mirror.

## 8. Decisions (recorded) & remaining detail

| #   | Question                | Decision                                                                                                                         |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | Floor/topology source   | **A + C** — explicit tag (identity/comment) primary, mutual-signal adjacency to fill/verify + power the neighbor recommendation. |
| 8.2 | Target stack            | **Both** v7 `/interface wifi` CAPsMAN and legacy `/caps-man`; test v7 first.                                                     |
| 8.3 | Steering aggressiveness | **Both** soft (802.11k/v) and hard (signal-range rejection), with a configurable signal threshold (default −70 dBm).             |
| 8.4 | HA scope                | **Yes** — support both: one MikroTik as backup manager, and a CHR/router controller pair.                                        |

Detail still to settle during Phase 1 (non-blocking):

- Exact tag convention to parse first (identity regex vs. comment key) — start with a
  documented convention, allow dashboard override.
- Weak-signal default threshold and per-band overrides (−70 dBm 5 GHz may differ from
  2.4 GHz) — expose as tool args + a dashboard setting.
- Trend-sample interval + retention (reuse usage-sampler clamps: default ~1 min,
  93-day retention).

## 9. Testing

Pure engine ⇒ heavy unit coverage with realistic fixtures: reg-table exports at
various signals; a co-channel conflict; a resource-starved CAP beside an idle one;
an FT-misconfigured SSID (inconsistent mobility domain); a single-manager (no-HA)
topology; a floor-tag-missing case that must fall back to signal adjacency; and an
already-optimal fleet (must yield **zero findings** — the idempotency guarantee).
Tool-layer contract (dry-run default, confirm gate, Safe-Mode envelope) tested via
the pure select/plan helpers, like `port-scan-detection`.

## 10. Implementation progress (loop state — the source of truth)

> **How the loop uses this section.** Each iteration: read this section, do the
> FIRST phase whose box is unchecked, tick its sub-tasks as they land, then tick the
> phase box only when its **Exit gate** passes, commit, and stop. The loop ends when
> every phase box is checked. If blocked, leave the box unchecked and write the
> blocker under **Blockers / notes**. This on-disk checklist is the ONLY reliable
> memory across iterations (context is summarized between them).

**Global exit gate — every phase must pass before its box is ticked** (run each
un-piped; the pre-existing `tests/mcpb-manifest.spec.ts` version failure is the ONLY
tolerated failure):

```
bun run test:types && bun run test && bun run lint
```

Plus, when a phase adds/changes tools: register in `src/tools/index.ts`, run
`bun run gen`, and keep ONLY the new/changed per-tool schemas (revert the wholesale
formatter drift — see the gen-drift memory). Commit under the user's git identity, no
Claude trailers, conventional-commit message.

### [x] Phase 1 — Read-only foundation

- [x] `src/utils/wifi-query.ts` — wifi-path resolver (v7 `wifi` → `wifiwave2` →
      legacy `/caps-man`), fetch every slice → `fetchCapsmanState`. (Pure wire→model
      mapping lives in `src/core/capsman-normalize.ts` so it's testable + keeps the
      core→utils dependency direction clean.)
- [x] `src/core/capsman.ts` — PURE engine: floor model (A tag-parse + C signal
      adjacency), coverage/co-channel + `proposeChannelPlan`, weak-signal findings +
      neighbor recommendation, resource-aware load, FT audit, HA audit; typed
      findings (`finding_id`/`severity`/`confidence`); `runCapsmanAudit` + renderer.
- [x] Read tools in `src/tools/capsman.ts`: `audit_capsman_coverage`,
      `report_weak_signal_clients`, `audit_capsman_load`, `audit_capsman_ft`,
      `audit_capsman_ha`, `run_capsman_audit` (READ only).
- [x] Register the module in `src/tools/index.ts` (import + "CAPsMAN Orchestrator"
      catalog entry) + 6 generated per-tool schemas.
- [x] `tests/core/capsman.spec.ts` — 28 cases: co-channel, resource-starved CAP,
      FT-misconfig (mobility-domain mismatch), no-HA, floor-tag-missing fallback,
      already-optimal → zero findings, + the wire normaliser.
- [x] Dashboard: `GET /api/capsman/overview|clients|audit` routes +
      `ui/observability/capsman.tsx` VIEW-ONLY (floor coverage/load grid, weak-signal
      table, FT/HA audit strip), wired into `main.tsx` (ViewId + nav + icon + help),
      themed. Structured payload via `capsmanOverview` in the engine.
- [x] Docs: `docs/capsman.md` + README + observability.md rows.
- **Exit gate:** ✅ global gate green (615 pass, only the pre-existing mcpb-manifest
  failure) + `bun run build:ui` succeeds. **PHASE 1 COMPLETE.**

### [x] Phase 2 — Steering + load-balance apply

- [x] `steer_client` (DANGEROUS) — soft (k/v advisory, no write) + hard
      (signal-range reject on the current radio); dry-run default, confirm, snapshot + `applyWritesSafely` (fallback OFF), idempotent (`steerAlreadyPresent`).
- [x] `apply_capsman_load_balance` (DANGEROUS) — `loadBalancePlan` + connect-priority
      nudge per overloaded radio; preview-first, idempotent.
- [x] Dashboard: §5.2 per-client **Steer** button + §5.4 **Auto-balance** button
      (AlertDialog confirm → `POST /api/capsman/apply/steer|load-balance` → sonner).
- [x] `POST /api/capsman/apply/steer` + `/load-balance` routes (snapshot + Safe Mode).
      _(Floor-tag write-back deferred — floors are read from tags + signal adjacency;
      the write-back endpoint is a nice-to-have, tracked in Blockers.)_
- [x] Tests: 8 new cases — steer builders (hard/soft/legacy path), idempotency,
      load-balance plan + builder + idempotent skip + empty plan.
- **Exit gate:** ✅ global gate green (623 pass, only pre-existing mcpb failure) +
  `build:ui` succeeds. **PHASE 2 COMPLETE.**

### [x] Phase 3 — Channel-plan apply

- [x] `apply_capsman_channel_plan` (DANGEROUS) — sets each radio's frequency to the
      proposed non-overlapping plan (`buildChannelPlanCommands` + `channelToFrequencyMhz`);
      dry-run default, confirm, snapshot + Safe Mode; idempotent (skips radios already
      on target); v7 `/interface wifi` only.
- [x] Dashboard: §5.1 heatmap **Apply channel plan** button (shown when co-channel
      conflicts exist) → `POST /api/capsman/apply/channel-plan`.
- [x] Tests: 6 new cases — channel→freq mapping, builder emits/skips, radio scope,
      caps-man returns none.
- **Exit gate:** ✅ green (629 pass, only pre-existing mcpb) + build:ui. **PHASE 3 COMPLETE.**

### [x] Phase 4 — FT enable

- [x] `enable_capsman_ft` (DANGEROUS) — sets ft=yes + ft-over-ds + a SINGLE shared
      ft-mobility-domain across the security configs (`buildFtCommands` +
      `resolveMobilityDomain`); dry-run, confirm, snapshot + Safe Mode; idempotent.
      (802.11k/v steering is a separate config object — noted in the tool.)
- [x] Dashboard: §5.5 **Enable FT** button in the roaming/HA strip (shown when an FT
      finding exists) → `POST /api/capsman/apply/ft`.
- [x] Tests: 6 new cases — enable on ft-off, converge mismatched domains, override,
      idempotent skip, config scope, legacy caps-man menu.
- **Exit gate:** ✅ green (635 pass, only pre-existing mcpb) + build:ui. **PHASE 4 COMPLETE.**

### [x] Phase 5 — HA setup (highest blast radius — last)

- [x] `setup_capsman_ha` (DANGEROUS, requires `reason`) — second manager +
      cert-based; point CAPs at both managers; both topologies (§8.4).
- [x] `apply_capsman_fixes` orchestrator apply (safe order, one snapshot + one
      Safe-Mode session, per-finding result).
- [x] Dashboard: §5.5 HA mini-map → guided setup.
- [x] Tests: HA command builder for both topologies; apply ordering.
- **Exit gate:** global gate green.

### [x] Phase 6 — Trends + Raycast mirror

- [x] `capsman_samples` (bun:sqlite) + a slow sampler reusing the usage-sampler's
      unsupported-command memoization; `capsman` trend API + §5.6 graphs.
- [x] Raycast: `capsman` browse + audit command(s) (+ package.json + CHANGELOG).
- [x] Tests: sampler store; Raycast `tsc --noEmit` clean.
- **Exit gate:** global gate green; build:ui + raycast tsc green.

### Blockers / notes (loop appends here)

- **Phase 1 DONE** (2 iterations). Iter 1: backend (utils + engine + normaliser +
  6 read tools + 28 tests). Iter 2: view-only dashboard page + 3 `/api/capsman/*`
  routes + `main.tsx` wiring + `docs/capsman.md` + README/observability rows;
  `build:ui` green. Next: Phase 2 (steering + load-balance apply).
- **Phase 2 DONE** (iteration 3). `steer_client` + `apply_capsman_load_balance`
  tools, access-list slice added to state/normaliser/wifi-query, dashboard Steer +
  Auto-balance buttons + `POST /api/capsman/apply/steer|load-balance` routes, 8 new
  tests. Deferred (nice-to-have): `POST /api/capsman/floor` tag write-back so the
  admin can correct an AP's floor from the UI. Next: Phase 3 (channel-plan apply).
- **Phase 3 DONE** (iteration 4). `apply_capsman_channel_plan` + channel→freq builder,
  dashboard Apply-channel-plan button + `POST /api/capsman/apply/channel-plan`, 6 tests.
  Next: Phase 4 (FT enable).
- **Phase 4 DONE** (iteration 5). `enable_capsman_ft` + FT builder/mobility-domain
  resolver, dashboard Enable-FT button + `POST /api/capsman/apply/ft`, 6 tests.
  Next: Phase 5 (HA setup — highest blast radius).
- **Phase 5 DONE** (iteration 6). `setup_capsman_ha` + `apply_capsman_fixes` tools
  (both DANGEROUS, `reason` auto-injected). Engine: `buildHaCommands` (enables
  `require-peer-certificate`, idempotent, v7 + legacy `/caps-man` menus), `haGuidance`
  (returns the multi-device second-manager standup steps as guidance — RouterOS has no
  single-command HA, so pointing CAPs at both managers is NOT auto-applied, by design),
  and the `buildFixPlan` orchestrator (safe FIX_ORDER coverage→load→weak→ft→ha, deduped,
  one snapshot + one Safe-Mode session). Dashboard: "Harden HA" guided-setup button in
  the FT/HA panel + `POST /api/capsman/apply/ha` (apply + guidance); the HA state is
  surfaced in the audit strip rather than a separate SVG mini-map. 6 new tests (buildHaCommands
  enable/no-op/legacy-menu, buildFixPlan ordering + weak→steer mapping + no-op). Gate green
  (only the pre-existing mcpb-manifest version test + pre-existing unrelated `raycast/src`
  lint debt remain red — neither introduced here). Next: Phase 6 (trends + Raycast mirror).
- **Phase 6 IN PROGRESS** — iter A (this iteration): backend only. `capsman-store.ts`
  (`capsman_samples` bun:sqlite table, dynamic import like usage-store; pure
  `summariseRadioSamples` grouping helper) + `capsman-sampler.ts` (slow 5-min sampler
  reusing `fetchCapsmanState`/`capsmanOverview`, skips MAC-Telnet, memoises no-wireless
  devices in `noCapsman` exactly like usage-sampler's `noUserManager`) + `GET
/api/capsman/trends` route + open/start/close wiring in the dashboard. 4 store tests.
  Gate green (no new tools -> no `gen`; no UI change -> build:ui deferred). Still TODO
  (iter B): §5.6 trend graphs in `capsman.tsx` + Raycast `capsman` browse/audit commands
  - Raycast `tsc --noEmit`, then tick the Phase 6 boxes.
- **Phase 6 DONE** — iter B (this iteration): §5.6 graphs — a "Radio load trends" panel in
  `capsman.tsx` reusing the shared `MetricArea` sparkline (per-radio client load, band-tinted
  via theme tokens — no hardcoded hex, per the dashboard-colour test), fed by
  `GET /api/capsman/trends`. Raycast `capsman` command (`raycast/src/capsman.tsx`): a
  device-scoped List mirroring the page — radios (band/channel/load/co-channel), weak-signal
  clients with recommended neighbour AP, and audit findings — registered in `package.json`
  (20th command) + CHANGELOG. Gate green (build:ui green; `raycast bun run test:types` clean;
  only the pre-existing mcpb-manifest version test + pre-existing unrelated `raycast/src` lint
  debt remain red). All Phase 6 boxes ticked; every §10 phase box is now checked — the build is
  complete.
