---
title: "02 \u2014 Capability probe + proactive tool gating"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 02 — Capability probe + proactive tool gating

> **Status:** ✅ COMPLETE — all 4 phases landed.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §9 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Probe each device **once** for version, packages, architecture and board features,
cache it, and let the registry hide or annotate tools the device genuinely cannot
run — so the model stops discovering incompatibility by calling and failing.

## 1. Why

`commandUnsupported()` detects an unsupported command _after_ it has run. The model
then sees a confusing error, often hallucinates a fix, and burns two more calls. The
worst offenders:

- `/interface wifi` (ROS 7 wifiwave2) vs `/interface wireless` (legacy) vs
  `/caps-man` — three stacks, mutually exclusive per device.
- `/container` needs `device-mode` enabled **and** the `container` package.
- `/ip service` vs ROS 6 paths; `/routing/bgp` differs wholesale between 6 and 7.
- PoE, switch chip, SFP and LTE tools depend on the **board**, not the OS.
- `user-manager`, `wifi-qcom-ac`, `rose-storage`, `iot`, `zerotier` are optional
  packages.

Cheapest real win in the whole backlog: a probe, a cache and a registry filter
improve every tool at once.

## 2. What is probed

One batched read per device, on first use, cached with a TTL:

| Source                        | Yields                                        |
| ----------------------------- | --------------------------------------------- |
| `/system/resource/print`      | `version`, `board-name`, `architecture-name`  |
| `/system/package/print`       | installed + enabled optional packages         |
| `/system/routerboard/print`   | model, firmware, whether it is a RouterBOARD  |
| `/system/device-mode/print`   | container/scheduler/fetch permissions (7.13+) |
| `/interface/wifi/print count` | which wireless stack answers                  |

Everything is `READ`. On a device where a probe path 404s, that simply records the
absence — a failed probe is data, not an error.

## 3. Architecture

```
src/core/capability.ts     PURE — model + predicate evaluation, no I/O
src/core/capability-probe.ts  fetch (executeMikrotikCommand) → normalize → model
src/core/registry.ts       consults the cache when listing/serving tools
```

`Capabilities` model:

```ts
interface Capabilities {
  version: { raw: string; major: number; minor: number; patch: number };
  channel: "stable" | "long-term" | "testing" | "development" | "unknown";
  board: string;
  arch: string;
  isRouterBoard: boolean;
  packages: Set<string>; // enabled only
  wirelessStack: "wifi" | "wireless" | "capsman-legacy" | "none";
  deviceMode: { container: boolean; scheduler: boolean; fetch: boolean };
  probedAt: number;
}
```

**Declaring a requirement.** `defineTool` gains an optional `requires`:

```ts
requires: { minVersion: "7.13", packages: ["container"], deviceMode: "container" }
requires: { wirelessStack: "wifi" }
requires: { board: /^CRS3/ }
```

Absent `requires` = universally available, which is the case for the large majority.
Only annotate tools that genuinely need it — resist the urge to fill this in
everywhere.

## 4. Gating behaviour (the important design call)

Three modes, configurable (`capabilityGating`), default **`annotate`**:

- **`off`** — probe still runs for the dashboard, but nothing is filtered.
- **`annotate`** (default) — every tool stays listed; unsupported ones get a
  prefix in their description: `[unavailable on this device: needs RouterOS ≥ 7.13]`.
  The model reads descriptions to choose, so this alone prevents most bad calls.
- **`filter`** — unsupported tools are removed from `tools/list` entirely.

Default is `annotate`, not `filter`, for two reasons: in a multi-device setup the
tool list is global while capabilities are per-device (a tool unsupported on device A
may be essential on device B), and silently vanishing tools are extremely confusing
to debug. **`filter` is only honoured in single-device mode** — document this.

Independently of the mode, the **handler-side guard always runs**: if a tool with
`requires` is invoked against a device that fails the predicate, return a clean
`isError` result naming the missing capability, rather than letting RouterOS produce
a parser error. That guard is the actual safety net; listing behaviour is UX.

## 5. Cache & invalidation

In-memory `Map<deviceName, Capabilities>`, TTL **6 h**. Invalidate on: explicit
`refresh_device_capabilities`, a successful firmware upgrade tool, config reload, or
a `commandUnsupported()` hit (which means the model is stale — reprobe and log).

No persistence. A restart reprobing costs one batched read per device.

## 6. Tools (2)

| Tool                          | Risk | Purpose                                                                                                    |
| ----------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `get_device_capabilities`     | READ | The probed model, rendered — version, packages, stack, board, device-mode, and what that unlocks or blocks |
| `refresh_device_capabilities` | READ | Force a reprobe, bypassing the TTL                                                                         |

Module: `src/tools/capability.ts`, catalog label **"Device Capabilities"**, group
`Discovery & Meta`.

## 7. Dashboard

- **Devices** (`connectivity.tsx`) — each device card gains a capability strip:
  version + channel chip, wireless stack, notable packages, device-mode flags.
  Detail drawer gets the full matrix and a **Reprobe** button.
- **Modules** (`modules.tsx`) — a device selector; supported tools render normally,
  unsupported ones dim with the reason on hover. This makes the whole catalog
  legible against a specific router, which is genuinely useful on its own.
- Routes: `GET /api/capabilities` (all devices), `POST /api/capabilities/refresh`.

## 8. Raycast

- `raycast/src/catalog.tsx` and `modules.tsx` — accessory icon + tooltip on
  unsupported tools, sourced from `/api/capabilities`.
- `raycast/src/devices.tsx` — version/stack in the list item subtitle.

No new command.

## 9. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Pure model + probe

- [x] `src/core/capability.ts` — `Capabilities`, `ToolRequires`, `unmetReasons`,
      `satisfies`, `explainUnmet`, `channelOf`, `unknownCapabilities`. Pure.
      **Reuses `parseVersion`/`compareVersions` from `firmware-lifecycle.ts`** rather
      than defining a second comparator — that one already handles `7.17beta3`,
      `7.16.2 (stable)` and absent patch numbers, and two version orderings in one
      codebase drift apart. The blueprint's `parseVersion` line was therefore not
      implemented; it already existed.
- [x] `src/core/capability-probe.ts` — `probeDevice` (batched, two `Promise.all`
      waves) plus the pure normalisers `parseSettings`, `parsePackages`,
      `pickWirelessStack`, `normalizeProbe`. Every individual probe is wrapped: an
      absent menu records absence instead of aborting.
- [x] `tests/core/capability.spec.ts` — 26 cases: version bounds incl. pre-release
      ordering and exclusive `maxVersion`, packages (missing, pluralisation,
      disabled-not-counted), all three wireless stacks, board regex, RouterBOARD,
      device-mode, requirement combination, `channelOf`, and the probe parsers
      including a device that answers nothing.
- **Exit gate:** ✅ global gate green — `test:types` clean, **733 tests / 67 files
  pass**, `lint` exit 0. **PHASE 1 COMPLETE.**

**Decisions taken during Phase 1** (binding on Phase 2):

- **An unknown capability never blocks.** Every predicate passes when the relevant
  fact was not probed (no version, empty board, `probedAt === 0`, `wirelessStack:
"none"`). Failing closed on a probe that did not answer would break tools on
  devices that work fine — the probe is an optimisation, not an authority. Phase 2's
  handler-side guard inherits this and must not tighten it.
- **`unmetReasons` returns ALL failures, not the first.** `explainUnmet` joins them.
  A tool needing 7.13 _and_ a package should say both, or the user fixes one and hits
  the next.
- **Disabled packages are excluded from `packages`.** A package present but flagged
  `X` cannot serve its menu; counting it would reintroduce the exact failure this
  feature removes.
- **`maxVersion` is exclusive**, `minVersion` inclusive — so `{minVersion: "7.13",
maxVersion: "8.0"}` reads naturally as "the 7.x line from 7.13".
- Wireless stack detection prefers `wifi` over `wireless` when both answer, since a
  v7 device can retain the legacy menu for compatibility.

### [x] Phase 2 — Registry integration

- [x] `defineTool` accepts `requires`, carried onto `RegisterableTool`.
- [x] `src/core/capability-cache.ts` — caches the **in-flight promise** (the
      Phase 1 blocker), TTL 6 h measured from probe START, `invalidateCapabilities`,
      synchronous `peekCapabilities`, and `setCapabilityClock`/`setCapabilityProber`
      test seams. A failing probe resolves to unknown and is evicted, never cached.
- [x] `capabilityGating` config (`off|annotate|filter`, default `annotate`) +
      `--capability-gating` / `MIKROTIK_MCP__CAPABILITY_GATING`; `filter` degrades to
      `annotate` in multi-device mode with a warn-once log. `schemas/config.schema.json`
      regenerated (the `docs/tools-reference.md` formatter churn was reverted).
- [x] Handler-side guard in the registry callback → `isError` naming the unmet
      requirement, recorded in observability like any other failure.
- [x] `withRequires(requires, module)` + applied to the three unambiguous modules:
      container (`container` package + device-mode + 7.0), user-manager
      (`user-manager` package), PoE (`routerBoard`). **The wireless stacks, switch
      and ROS7-routing were deliberately NOT annotated — see below.**
- [x] `tests/core/capability-gating.spec.ts` — 15 cases: all three modes, cold
      cache, satisfied requirement, multi-device `filter` fallback, concurrent probe
      sharing, TTL reuse/expiry, slow-probe freshness, failing probe not cached,
      invalidate, peek lifecycle.
- **Exit gate:** ✅ global gate green — `test:types` clean, **756 tests / 69 files
  pass**, `lint` exit 0. **PHASE 2 COMPLETE.**

**Decisions taken during Phase 2:**

- **Listing gating needs a probe that has already resolved; the guard does not.**
  Tool descriptions are registered once at startup and cannot await I/O, so
  `gatingDecision` reads only `peekCapabilities()` and returns "no opinion" on a cold
  cache. In practice `annotate`/`filter` therefore take effect on the _next_
  registration after a probe exists (a server reload), while the call-time guard
  works from the first call. This limitation is inherent to MCP's static tool list —
  the alternative, probing every device before registering, would add a multi-second
  network round-trip to stdio startup and fail closed on an unreachable router.
  It is also why `annotate` is the default: degrading to a no-op is harmless,
  whereas a `filter` that guessed would hide working tools.
- **Only three modules were annotated.** The blueprint listed six. The wireless
  modules already auto-detect their stack per call and work across all three, so a
  `requires` there would _remove_ function; switch tools span far more boards than a
  single regex captures; and ROS7-only routing is already version-guarded in its
  handlers. Annotating those would trade a real behaviour for a cosmetic one. The
  three chosen are unambiguous: a missing package or absent PoE hardware cannot be
  worked around.
- **`withRequires` at the module boundary**, rather than `requires:` on 37 individual
  definitions — whole modules share a requirement far more often than single tools,
  and one omission in 37 silently loses the guard.

### [x] Phase 3 — Tools + docs

- [x] `src/tools/capability.ts` — `get_device_capabilities` and
      `refresh_device_capabilities`, both READ. The renderer states **consequences**
      ("Container tools BLOCKED — package installed but device-mode off, enabling it
      needs a physical reset-button confirmation") rather than dumping fields.
- [x] `src/tools/index.ts` — "Device Capabilities" catalog entry, group
      `Discovery & Meta`. Catalog test green; **833 → 835 tools**.
- [x] Invalidation wired (the Phase 2 gap): `onConfigChanged` subscription in
      `runtime.ts` fires on every `setConfig`, and `firmware_upgrade` invalidates
      after the install command.
- [x] `tests/core/capability-guard.spec.ts` — 9 cases through the real registry
      (the other Phase 2 gap): guard blocks and explains, satisfied requirement runs,
      no-requires never guarded, unprobeable device does not block, a **throwing
      probe does not fail the call**, handler never runs when blocked, description
      annotated, cold cache untouched, `filter` omits registration entirely.
- [x] `docs/capabilities.md` + README doc-table row + `docs/configuration.md` row
      and paragraph for `capabilityGating`.
- [x] `bun run gen` — 2 new per-tool schemas, `tool-catalog.json`, `schemas/README.md`
      and `docs/tools-reference.md`. **The tools-reference churn was kept this time,
      not reverted**: it carries the real new module, and CI runs `bun run gen` then
      `git diff --exit-code`, so the committed file must match generator output byte
      for byte.
- **Exit gate:** ✅ global gate green — `test:types` clean, **765 tests / 71 files
  pass**, `lint` exit 0. **PHASE 3 COMPLETE.**

**Decisions taken during Phase 3:**

- **Invalidation went into `setConfig` via a subscription, not into the four
  dashboard call sites.** `setConfig` is the choke point every reload routes
  through, so one hook covers all of them. It is a subscription rather than a direct
  import because `capability-cache` already imports `runtime` for device resolution —
  importing back would be a cycle. A listener that throws is swallowed: a cache
  concern must never be able to break config installation.
- **The two tools take no `device` parameter of their own** — the registry injects
  the standard `device` selector in multi-device mode, so they follow the same
  targeting rules as everything else.

### [x] Phase 4 — Dashboard + Raycast

- [x] `GET /api/capabilities` (**non-probing** — reports only resolved probes) and
      `POST /api/capabilities/refresh` (invalidate + probe one device).
      `serializeCapabilities` added to `capability.ts` because `packages` is a `Set`,
      which `JSON.stringify` renders as `{}` rather than failing.
- [x] `connectivity.tsx` — `CapabilityStrip` on each device card: version, board
      class, wireless stack, package chips, a `device-mode blocked` warning, and a
      Probe/Reprobe button. An unprobed device shows a Probe button, never an empty
      matrix that would read as "supports nothing".
- [x] `modules.ts` — per-module `unsupported: {device, reason}[]`, computed from
      resolved probes only. `modules.tsx` gains a device selector that dims
      unavailable modules and prints the reason inline.
- [x] Raycast: `devices.tsx` shows the probed version in the subtitle,
      `modules.tsx` gains an `unsupported on N` tag with the per-device reasons in
      its tooltip, `lib/types.ts` carries both new shapes.
- **Exit gate:** ✅ global gate green — `test:types` clean, **765 tests / 71 files
  pass**, `lint` exit 0, `bun run build:ui` succeeds (8 views), Raycast `tsc` clean
  in `src/`. **PHASE 4 COMPLETE — TASK 02 DONE.**

**Decisions taken during Phase 4:**

- **`GET /api/capabilities` never probes.** It reports `peekCapabilities` only.
  Loading the dashboard must not fan a 7-command probe out to every configured
  router; probing is an explicit button press.
- **Module-level rather than tool-level dimming.** `withRequires` makes a module's
  requirement uniform across its tools, so the first declaring tool speaks for the
  module — and the Modules view is module-shaped already. Tool-level would have
  needed a second payload for no extra information.
- **The device selector only lists devices some module reports on.** A device with
  no resolved probe contributes no `unsupported` entries, so offering it would dim
  nothing and falsely imply everything is supported.
- `Badge` in `geist.tsx` takes no `title` prop — tooltips are on a wrapping
  `<span>`.

### Blockers / notes

- **Probe cost is 7 commands per device.** Phase 1 issues 4 setting prints plus 3
  menu-existence checks, in two `Promise.all` waves. That is fine behind the 6 h
  cache, but Phase 2 must ensure the probe is triggered **once** and never from
  inside a hot path — concurrent first-use on several tools must share one in-flight
  promise, not fire seven commands each. Store the promise in the cache, not the
  resolved value.
- **`/interface wifi print count-only` is a real command on a device without the
  package**, and returns a parser error rather than `0`. `menuExists` treats any
  error as absence, which is correct, but it means a _transient_ failure looks like
  "no wireless stack". Acceptable because an unknown stack never blocks (see the
  Phase 1 decisions), but do not later invert that.
- **`/system device-mode print` output shape is unverified against a real 7.13+
  device.** The parser reads `container:`/`scheduler:`/`fetch:` keys from a settings
  print and defaults every absent key to permissive. **Now load-bearing** — the
  container module gates on `deviceMode: "container"` as of Phase 2. The permissive
  default means a wrong key name degrades to "unrestricted" (tools stay available)
  rather than wrongly blocking, so the failure mode is safe, but confirm the real key
  names before Phase 4 surfaces device-mode in the dashboard as fact.
- ~~Invalidation hooks not wired~~ — **done in Phase 3** (config reload + firmware
  upgrade). Still NOT wired: invalidating on a `commandUnsupported()` hit, which
  would prove the cached model is stale. Deferred deliberately — it needs a hook in
  `connector.ts`, and a device that legitimately lacks a menu would then reprobe on
  every call to it.
- ~~No end-to-end guard test~~ — **done in Phase 3**
  (`tests/core/capability-guard.spec.ts`, 9 cases through the real registry).
