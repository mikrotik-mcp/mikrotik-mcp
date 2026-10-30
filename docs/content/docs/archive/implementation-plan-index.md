---
title: Historical implementation plan
description: Original planning and execution conventions, retained as history.
---

> Historical record; check current dashboard and tool guides for shipped behavior.

# Planned tasks — index & loop protocol

Eleven approved feature blueprints, each written as **both the design AND the live build
tracker** for an autonomous `/loop` implementation run. Nothing here is implemented
yet unless its tracker says so.

Every task doc is self-contained except for this file, which holds the rules that
apply to all of them. **Read this file first, then the task doc.**

| #                                                     | Task                          | Adds tools | Dashboard page   | Raycast command  | Size |
| ----------------------------------------------------- | ----------------------------- | ---------- | ---------------- | ---------------- | ---- |
| [01](/docs/archive/task-01-rest-transport)            | RouterOS REST transport       | no         | Devices (badge)  | devices (badge)  | L    |
| [02](/docs/archive/task-02-capability-probe)          | Capability probe + gating     | 2          | Devices, Modules | catalog, modules | M    |
| [03](/docs/archive/task-03-cross-device-transactions) | Cross-device two-phase commit | 5          | **Transactions** | **transactions** | L    |
| [04](/docs/archive/task-04-traffic-flow)              | Traffic Flow (NetFlow/IPFIX)  | 9          | **Flows**        | **flows**        | M    |
| [05](/docs/archive/task-05-staged-fleet-rollout)      | Staged fleet rollout          | 4          | Change Plan (+)  | change-plan (+)  | M    |
| [06](/docs/archive/task-06-policy-as-code)            | Policy-as-code linting        | 6          | **Policies**     | **policies**     | M    |
| [07](/docs/archive/task-07-alerting-webhooks)         | Alerting + webhooks           | 7          | **Alerts**       | menubar (+)      | M    |
| [08](/docs/archive/task-08-offline-simulator)         | Offline config simulator      | 4          | **Simulator**    | —                | XL   |
| [09](/docs/archive/task-09-scheduled-audits)          | Scheduled autonomous audits   | 5          | **Schedules**    | menubar (+)      | M    |
| [10](/docs/archive/task-10-explain-device)            | `explain_device` narrative    | 3          | **Explain**      | **explain**      | M    |
| [11](/docs/archive/task-11-attack-detection)          | Attack detection & response   | 7          | **Attacks**      | menubar (+)      | XL   |

Suggested order: **01 → 02 → 07 → 09 → 04 → 06 → 05 → 03 → 10 → 11 → 08**. 01 and 02
make every later task cheaper; 07 and 09 turn the dashboard from passive into a
product; 11 wants 07's alert bus already in place; 08 is the most speculative and
should go last.

---

## The Claude Code loop protocol

Every task doc ends with an **Implementation progress** section. That section — not
this file, not the conversation — is the source of truth for a loop run.

**Each iteration:**

1. Read the task doc's progress section.
2. Do the **first phase whose box is unchecked**. One phase per iteration, no more.
3. Tick sub-tasks as they land.
4. Run the **global exit gate** (below). Tick the phase box only when it passes.
5. Commit, then stop.

The loop ends when every phase box is checked. If blocked, leave the box unchecked
and write the reason under **Blockers / notes** in that phase. Context is summarized
between iterations — the on-disk checklist is the only reliable memory.

## Global exit gate

Run each command **un-piped** in the chain. Piping through `tail` masks the exit code
and lets a failing check pass the gate.

```bash
bun run test:types && bun run test && bun run lint
```

Additionally, per phase:

- **Phase added or changed a tool** → register it in `src/tools/index.ts`, run
  `bun run gen`, and keep **only** the new/changed per-tool schemas. Revert the
  wholesale formatter drift (`bun run gen` reformats ~500 files; that churn is not
  part of your diff).
- **Phase touched `ui/observability/`** → `bun run build:ui` must succeed.
- **Phase touched `raycast/`** → `cd raycast && npm run lint && npx tsc --noEmit`.
- **Phase touched `manifest.json` or packaging** → `tests/mcpb-manifest.spec.ts`
  must still pass.

Commit under the user's git identity with a conventional-commit subject. **No
`Co-Authored-By` or Claude trailers.**

## Conventions every task inherits

**Tools.** One module per scope in `src/tools/<scope>.ts` exporting a `ToolModule`
of `defineTool({...})`. Mirror the closest existing sibling — the per-tool shape is
highly regular. Register in `src/tools/index.ts` `moduleCatalog` exactly once.

**Device I/O.** Only through `executeMikrotikCommand(command, ctx)`. Never open a
transport directly. Build every command with the `Cmd` builder — never string
concatenation. Detect device-side failure with `looksLikeError()`.

**Pure core, thin shell.** Engine logic goes in `src/core/` or a new `src/<feature>/`
as a **pure** module (no I/O, no imports from `tools/`), so it is unit-testable
offline. Tools fetch, call the engine, render. This is why `tests/` can be offline.

**Risk annotations.** `READ` / `WRITE` / `WRITE_IDEMPOTENT` / `DESTRUCTIVE` /
`DANGEROUS` — exactly one preset per tool. Audits are always `READ`. Anything that
applies config is at least `WRITE`, and must offer a dry-run first.

**Tests are offline.** No task may introduce a test that needs a live router. Fixture
the wire output as a string, feed it to the pure engine, assert on the model.

**`bun:sqlite` is dynamic-import only** (`src/observability/store.ts` pattern). The
Vitest import graph aliases `"bun"` to a stub and must never load it. New stores
follow the same shape: import types statically, the driver dynamically.

## Dashboard conventions (`ui/observability/`)

A new page is: a `<name>.tsx` view + a `ViewId` entry, nav item, icon and help text
in `main.tsx` + REST routes in `src/observability/dashboard.ts` (or a sub-router
like `drift-routes.ts` when it exceeds ~6 endpoints). Follow `drift.tsx` for a
read+act page and `topology.tsx` for a visualization-heavy one.

The React app is built separately (`ui/vite.observability.config.ts`, single-input +
`inlineDynamicImports`) so it inlines into one self-contained HTML. Theme with the
existing tokens in `tailwind.css` / `theme.tsx` — no new color systems.

Live updates ride the existing WebSocket (`/api/stream`) with the SSE fallback
(`/api/sse`). Do not open a second socket; add a message type.

## Raycast conventions (`raycast/`)

A new command is: `raycast/src/<name>.tsx` + a `commands[]` entry in
`raycast/package.json` (name, title, description, mode). Shared fetch helpers live in
`raycast/src/lib/api.ts`; types in `lib/types.ts`; notifications in `lib/notify.ts`;
charts in `lib/charts.tsx`. Mirror `drift.tsx` for a list+detail command and
`menubar.tsx` for anything ambient.

Raycast talks to the **dashboard REST API**, not to the router. If a Raycast command
needs data, the dashboard must expose it first — that ordering is baked into every
task's phasing.

## Where a task must NOT go

- No `child_process` / OS-shell for device I/O. All device traffic is SSH (or
  MAC-Telnet, or — after task 01 — REST).
- Never switch `manifest.json` back to `server.type: "node"`.
- No new runtime dependency where a few lines of code will do.
- No test that requires network access.
