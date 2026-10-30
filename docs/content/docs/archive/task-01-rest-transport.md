---
title: "01 \u2014 RouterOS REST transport"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 01 — RouterOS REST transport

> **Status:** ✅ COMPLETE — all 4 phases landed (one scope reduction, see Phase 4).
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §8 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Add `/rest` (RouterOS 7.9+) as a **third transport** beside SSH and MAC-Telnet, so
read tools receive **structured JSON** instead of scraped console text — opt-in per
device, with SSH as the automatic fallback for anything REST cannot express.

## 1. Why this first

Every one of the 819 tools currently parses human-readable console output.
`looksLikeError()` regex-scrapes for failure and `commandUnsupported()` detects an
unsupported command only _after_ running it. That is the largest structural source of
fragility in the repo, and it gets worse with every tool added.

REST gives typed records, real HTTP status codes, and no per-command SSH handshake
(~200-500 ms saved even against a warm pool, because there is no channel setup).

## 2. Domain grounding

- Service: `/ip service` → `www-ssl` (or `www`). REST lives at
  `https://<host>/rest/<path>` where the path mirrors the console menu with `/`
  separators: `/rest/ip/address`, `/rest/interface/wifi/registration-table`.
- Verbs: `GET` (print), `PUT` (add), `PATCH` (set on `*id`), `DELETE` (remove),
  `POST /rest/<path>/<command>` for non-CRUD verbs (`monitor`, `print` with args).
- Auth: HTTP Basic, same credentials as SSH.
- Responses: JSON array of objects; keys are the console property names with `.id`
  as `*id`. Errors return a JSON body `{error, message, detail}` with a real status.
- **Not everything is exposed.** `/export`, Safe Mode, `/tool` interactive commands
  and console-only constructs have no REST equivalent. This is why REST is an
  accelerator, never a replacement.

## 3. Architecture

```
src/core/connector.ts   executeMikrotikCommand()   ← unchanged choke point
  └─ runOnce()          transport branch           ← extend here
       ├─ device.mac        → MikroTikMacTelnetClient
       ├─ device.api===true → MikroTikRestClient    ← NEW
       └─ else              → MikroTikSSHClient
```

`src/rest/client.ts` mirrors the `connect/run/disconnect/lastError` shape of
`MikroTikSSHClient` so the branch stays one line, exactly as MAC-Telnet did.

**The hard part is not HTTP — it is the console↔REST bridge.** Tools emit console
command strings (`/ip/address/print where interface=ether1`). `src/rest/bridge.ts`
is a **pure** translator: console string → `{method, path, query, body}`, and JSON
response → the console-shaped text the existing handlers already parse. That keeps
all 819 handlers untouched in phase 1.

> **Decision:** bridge-and-fake-the-text first (zero handler churn, immediate speed
> and error-code wins), then let _new_ tools opt into raw JSON via a second entry
> point in phase 4. Do not rewrite handlers.

## 4. Config surface

`src/config.ts` device schema gains:

| Field            | Type      | Default | Meaning                                      |
| ---------------- | --------- | ------- | -------------------------------------------- |
| `api`            | `boolean` | `false` | Use REST where possible                      |
| `apiPort`        | `number`  | `443`   | REST port                                    |
| `apiInsecureTls` | `boolean` | `false` | Accept a self-signed cert (default RouterOS) |

Env: `MIKROTIK_API`, `MIKROTIK_API_PORT`, `MIKROTIK_API_INSECURE_TLS`.
Regenerate `schemas/config.schema.json`.

`apiInsecureTls` defaults to **false**. RouterOS ships a self-signed cert, so most
users will need it on — but it must be a deliberate opt-in, and the error message on
a cert failure has to say exactly that.

## 5. Fallback rules (non-negotiable)

REST is attempted only when **all** hold: `device.api === true`, the command maps
cleanly in `bridge.ts`, and the device answered a probe. Otherwise SSH runs.

Fall back to SSH — once, transparently, logging at `debug` — when: the bridge cannot
map the command, REST returns 404 on the path (menu absent on this ROS version), the
TCP connect fails, or TLS is rejected. **Never** fall back on a 4xx that is a genuine
device-side rejection (400 bad parameter, 401 auth) — that must surface as an error,
or a typo silently re-runs over SSH and produces a confusing second failure.

Safe Mode stays **SSH-only** (it needs the persistent console session). When Safe
Mode is active, `executeMikrotikCommand` already routes to the safe-mode session —
the REST branch is never reached. Verify this with a test.

## 6. Dashboard

No new page. Additions only:

- **Devices** (`connectivity.tsx`) — a transport badge per device (`SSH` / `REST` /
  `MAC`), and on the detail drawer: REST reachability, negotiated ROS version, and a
  count of this session's REST-vs-SSH calls with the fallback reason if any.
- **Config Studio** (`config-form.tsx` / `config-spec.ts`) — the three new device
  fields, with `apiInsecureTls` carrying an explicit "self-signed certs" hint.
- **Live Feed** — a small `via` chip on each row so a call's transport is visible.
  Requires `transport` on the recorded event (`src/observability/event.ts`).

`GET /api/devices` gains `transport` and `restProbe` fields.

## 7. Raycast

No new command. `raycast/src/devices.tsx` shows the transport badge from
`/api/devices`, and `lib/types.ts` gains the two fields. Small.

## 8. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Client + bridge, no wiring

- [x] `src/rest/client.ts` — `MikroTikRestClient` with the SSH-shaped surface
      (`connect` = probe `/rest/system/resource`, `run`, `disconnect`, `lastError`).
      `fetch` only; no new dependency. Honours `insecureTls`, and names that exact
      setting in the TLS-failure message. Exports `RestUnmappableError` and
      `RestHttpError` (carrying `status`) — Phase 2's fallback rules branch on these
      rather than on string matching.
- [x] `src/rest/bridge.ts` — **pure**: `toRequest(command)` → `{method, path, query,
body, countOnly} | null`, and `toConsoleText(json, req)`. No I/O, no imports
      from `tools/`. Also exports `tokenize`/`unquote` (quote-aware, char-loop, no
      backtracking) since they are independently testable.
- [x] `tests/rest/bridge.spec.ts` — 33 cases across tokenize/unquote, print (incl.
      both menu spellings, `detail`, `count-only`, quoted filter values), writes
      (add/set/remove/enable/disable, singleton-menu `set`), the unmappable set
      (`[find]`, `/export`, backup, `/tool`, scripting, chained commands, unknown
      verbs), and JSON→text (list, quoting, empty, count-only, settings object,
      null handling).
- **Exit gate:** ✅ global gate green — `test:types` clean, **707 tests / 66 files
  pass**, `lint` exit 0. **PHASE 1 COMPLETE.**

**Decisions taken during Phase 1** (binding on later phases):

- **`toConsoleText` renders arrays in the `print detail` form** (` N key=value …`),
  not the columnar plain-`print` layout. Column widths and column _selection_ are
  per-menu console knowledge that cannot be reconstructed from JSON; `detail`
  carries strictly more information and every handler that reads `.id` or a property
  parses it correctly. This is the one deliberate shape difference between the
  transports and the main reason REST stays opt-in per device. Revisit only if a
  handler is found that depends on column layout.
- **A settings menu (object reply) renders as `  key: value` lines**, matching what
  the console prints for `/ip/dns`-style menus.
- **`toRequest` returns null whenever anything is uncertain.** Notably: any `[find]`
  selector, any non-`=` filter operator (`~`, `<`, `>`), `or`/`and` clauses, unknown
  verbs, and `remove`/`enable`/`disable` without an explicit `.id`. A wrong mapping
  runs the wrong command on a router; a missing one only costs the SSH round-trip.

### [x] Phase 2 — Config + transport wiring

- [x] `src/config.ts`: `api` / `apiPort` / `apiInsecureTls` on `DeviceConfigSchema` + `--api` / `--api-port` / `--api-insecure-tls` and the matching env vars.
      `z.boolean()` does not coerce strings, so the two booleans are parsed by a
      local `flagBool` helper (tri-state: absent leaves a config-file value alone).
      `schemas/config.schema.json` regenerated — diff is exactly the three fields.
- [x] `src/core/transport.ts`: `isRestDevice()` (opt-in, **MAC-Telnet wins**) and
      `createRestClient()`.
- [x] `src/core/connector.ts`: `tryRest()` + the REST branch at the top of
      `runOnce()`, with the §5 fallback rules.
- [x] `src/rest/client.ts`: `shouldFallbackToSsh(e)` — the fallback decision
      extracted as a **pure, directly testable** predicate rather than living inline
      in the connector's catch block.
- [x] `tests/rest/fallback.spec.ts` — 16 cases: opt-in and MAC precedence, the full
      fallback matrix (unmappable, 404, 400, 401, 403, 5xx, transport error), the
      never-REST command set, and a structural test proving **an active Safe Mode
      session bypasses the REST branch entirely**.
- [x] `tests/config/load-config-api.spec.ts` — 7 cases across flags and a
      multi-device config file, incl. the tri-state and the MAC+api combination.
- [x] `docs/configuration.md` — a REST API section under Connection settings.
- **Exit gate:** ✅ global gate green — `test:types` clean, **788 tests / 73 files
  pass**, `lint` exit 0. **PHASE 2 COMPLETE — but see Blockers: not yet smoke-tested
  against a real device.**

**Decisions taken during Phase 2:**

- **The fallback predicate is pure and separate.** `shouldFallbackToSsh` is the
  single most safety-critical decision in this task, so it lives as an exported
  function with its own tests rather than as branching inside a `catch`. Rule:
  fall back when REST could not _express or reach_ the command (unmappable, 404,
  transport failure); never fall back when the device _answered_ with a rejection
  (400, 401, 403, 5xx). Re-running a malformed command over SSH produces a second,
  differently-worded failure and sends the operator after the wrong transport.
- **`toRequest` is checked before any connection is opened**, so an unmappable
  command costs nothing — no TCP, no TLS, no probe.
- **REST is attempted per call, not pooled.** Each attempt constructs a client and
  probes. That is one extra HTTPS round-trip versus a warm SSH pool; a REST
  connection cache is a Phase 4 concern, and premature here while the mapping is
  still unverified against real hardware.
- **`docs/transports.md` was deliberately NOT touched** — it documents MCP
  client↔server transports (stdio/http/sse), a different axis from device
  transports. REST is documented in `docs/configuration.md` beside SSH and
  MAC-Telnet.

### [x] Phase 3 — Observability

- [x] `src/core/context.ts`: `transport` + `restFallback` on `ToolContext`, stamped
      by the connector. **On the context, not a module global** — tool calls run
      concurrently, so a shared "last transport used" would be overwritten by
      whichever device answered most recently.
- [x] `src/observability/event.ts`: `deviceTransport` + `restFallback` on
      `ToolEvent`/`RawCall`. **NOT reusing the existing `transport` field** — see
      below.
- [x] `src/observability/store.ts`: two columns plus idempotent `ALTER TABLE`
      migrations, matching the existing `reason` pattern, so an existing
      `events.db` keeps working.
- [x] `src/core/registry.ts`: reads `ctx.transport`/`ctx.restFallback` when
      recording.
- [x] `GET /api/devices` → `transport` now returns `rest` for an opted-in device,
      plus `restPort`.
- [x] `connectivity.tsx` REST badge with a tooltip; `detail-drawer.tsx` gains a
      **device link** row showing the actual transport and, when REST fell back, the
      reason. `main.tsx` untouched, as planned.
- [x] `config-spec.ts`: `api`, `apiPort`, `apiInsecureTls` (advanced), with the
      self-signed-cert warning in the help text.
- [x] `raycast/src/devices.tsx` + `lib/types.ts`: `rest` tag with tooltip.
- [x] `tests/rest/fallback.spec.ts` +3 stamping cases (19 total in the file).
- **Exit gate:** ✅ global gate green — `test:types` clean, **791 tests / 72 files
  pass**, `lint` exit 0, `bun run build:ui` succeeds, Raycast `tsc` clean in `src/`.
  **PHASE 3 COMPLETE.**

**Decisions taken during Phase 3:**

- **`ToolEvent.transport` was already taken** — it records the **MCP** transport the
  call arrived on (`stdio`/`http`), set globally in the recorder. The blueprint's
  "record `transport` on every event" would have silently overloaded it and corrupted
  the existing dashboard meaning. The device link is therefore `deviceTransport`, and
  the drawer labels them "mcp transport" and "device link" so the two are never
  confused again.
- **Every fallback records a reason**, not just the fact. A silent fallback is
  indistinguishable from REST never having been enabled, which makes an
  enabled-but-never-used transport impossible to diagnose from the dashboard.
- **`/api/devices.transport` is the CONFIGURED transport**, an intent rather than a
  guarantee — a REST device falls back per command. The per-call `deviceTransport` in
  the Live Feed is the record of what actually ran, and the badge tooltip says so.
- **A failed call still records the attempted transport** (`ssh` on a refused
  connection) rather than leaving it blank, so errors stay attributable.

### [x] Phase 4 — Native JSON path (opt-in, new tools only)

- [x] `executeMikrotikJson(command, ctx)` → `ParsedRecords`. REST JSON is used
      directly; SSH/MAC-Telnet text goes through the existing `parseRecords`. Values
      are coerced to strings on the REST side so a tool cannot switch on `typeof` and
      behave differently per transport.
- [x] `MikroTikRestClient.runJson()` — the parsed reply, skipping the render-to-text
      round-trip that would only discard information.
- [x] `tests/rest/parity.spec.ts` — 12 cases asserting REST JSON and SSH text
      produce **identical records**, plus that the Phase 2 text rendering round-trips
      back through `parseRecords` (so a migrated and an unmigrated tool can never
      disagree about the same device).
- [x] `docs/transports.md` (a header distinguishing MCP transport from device link),
      `docs/configuration.md` (done in Phase 2), README highlight row.
- [ ] ~~Migrate `list_interfaces` / `list_ip_addresses` / `list_routes`~~ —
      **deliberately NOT done. See the scope reduction below.**
- **Exit gate:** ✅ global gate green — `test:types` clean, **803 tests / 74 files
  pass**, `lint` exit 0. **PHASE 4 COMPLETE.**

**Scope reduction — the three tool migrations were dropped, on purpose:**

The blueprint asked to migrate three read tools "keeping their rendered output
byte-identical". Those two requirements turned out to be **mutually exclusive**.
Those tools currently pass the raw console text straight through
(`` `IP ADDRESSES:\n\n${result}` ``). Rendering instead from records necessarily
produces a different string — the columnar `print` layout cannot be reconstructed
from records, which is the same limitation recorded in the Phase 1 decisions.

So migrating them would have changed visible output for **every** user, including
the ~100% on SSH, in order to benefit REST users. That is a bad trade, and doing it
while the mapping is still unverified against real hardware would compound it.

`executeMikrotikJson` is therefore delivered as the entry point for **new** tools,
with parity guaranteed by test. Migrating existing tools is a separate decision that
should be made per tool, on its own merits, once the smoke test has run — not as a
side effect of adding a transport.

**Decisions taken during Phase 4:**

- **`toRecords` synthesises the `#` row index.** The parity test caught that
  `parseRecords` surfaces the console's row index as `#` while REST has no
  equivalent — so the two paths produced different key sets. Fixed in the source
  rather than papered over in the test, which is exactly what the parity suite is
  for.
- **Null/undefined JSON properties are dropped, not stringified.** `String(null)`
  would put the literal text `null` into a rendered table.

### Blockers / notes

- **Fixed in passing (Phase 1):** `manifest.json` was stale at `4.23.0` while
  `package.json` had moved to `4.24.0`, so `tests/mcpb-manifest.spec.ts`
  ("version tracks package.json") was failing before this task started. Bumped the
  manifest to match. It was pre-existing and unrelated to REST, but it blocks the
  global exit gate for every phase of every task, so it could not be left red.
- **⚠️ SMOKE TEST STILL OUTSTANDING.** Phases 1-4 are code-complete and covered
  offline, but **no command has ever been sent to a real RouterOS 7.9+ device over
  REST**. Phase 4 shipped without the tool migrations partly for this reason. Run
  before recommending `api: true` to anyone: Phase 2 is code-complete and fully
  covered offline, but **no command has ever been sent to a real RouterOS 7.9+ device
  over REST**. The mapping is verified only against the documented API shape. Before
  starting Phase 4 (migrating real tools onto the JSON path), run at minimum against
  a live box with `api: true`:
  `/ip address print` · `/ip address print where interface=ether1` ·
  `/ip address add … ` + `/ip address remove .id=…` · `/ip dns set servers=…` ·
  `/interface print count-only` · and one command that must fall back (`/export`).
  Confirm the rendered text is what handlers expect and that fallback is silent.
- ~~`apiInsecureTls` → `insecureTls` mapping~~ — done in Phase 2, in
  `createRestClient` (a separate factory from `createDeviceClient`, since REST is
  attempted _before_ the SSH client is built rather than instead of it).
- **REST is not pooled.** Each attempt constructs a client and probes — one extra
  HTTPS round-trip versus a warm SSH pool. Worth a connection cache in Phase 4, but
  premature while the mapping is unverified.
