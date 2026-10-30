---
title: "10 \u2014 `explain_device` \u2014 config to narrative"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 10 — `explain_device` — config to narrative

> **Status:** implemented — all five phases complete.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §8 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Generate a plain-language architecture document from a live router or a snapshot —
what VLANs exist and why, what each firewall chain actually does, where traffic
flows, what is exposed to the internet — with a Mermaid diagram, for the person who
just inherited an undocumented box.

## 1. Why this is not just a prompt

`prompts/backup-and-document.md` already asks the model to describe a router. That
works, but it is unstructured, unrepeatable and burns a large amount of context
dumping raw `/export` into the conversation.

A **tool** that pre-digests the config into a structured model changes the economics:
the model receives a compact, already-analysed document instead of 3,000 lines of
export, and the output is deterministic enough to diff between two dates. The narrative
prose is still the model's job — the tool supplies the skeleton and the facts.

Division of labour: **the tool decides what is true and what matters; the model
decides how to say it.**

## 2. What it produces

A structured `DeviceNarrative`, rendered as Markdown:

1. **Identity** — model, ROS version, uptime, purpose inferred from role signals
   (has a default route + NAT → edge router; has CAPsMAN → wireless controller;
   bridge-only with no routes → switch).
2. **Topology** — physical ports, bridges, VLANs and their subnets, what each
   interface is for, rendered as a Mermaid `graph LR`.
3. **Addressing** — subnets, DHCP scopes and their ranges, static reservations,
   which pool serves which VLAN.
4. **Internet path** — WAN interface, how the address is obtained, NAT strategy,
   failover if multi-WAN.
5. **Firewall posture** — per chain, in plain language: what is allowed in, what is
   allowed out, what the default is, **what is exposed to the internet** (the
   section people actually read).
6. **VPN** — every tunnel, its peers, subnets carried, whether it currently looks up.
7. **Services** — which management services are enabled, on which addresses, and
   which of those are reachable from the WAN.
8. **Risks** — a short list from the existing auditors, not a re-implementation:
   call into `firewall_audit` and the hardening auditor and summarise.
9. **Unknowns** — config the analyser did not recognise. Same discipline as task 08:
   what it could not read is stated, never silently dropped.

## 3. Architecture

```
src/narrative/analyze.ts   PURE — parsed export → DeviceNarrative model
src/narrative/roles.ts     PURE — role inference from signals
src/narrative/mermaid.ts   PURE — topology model → Mermaid source
src/narrative/render.ts    PURE — DeviceNarrative → Markdown
src/tools/explain.ts       3 tools
```

Consumes `src/policy/parse.ts` from **task 06**. Soft dependency: if 06 is not done,
implement the parser there first — do not write a second one.

Entirely pure. Input is a snapshot; the tools handle loading.

## 4. Tools (3)

| Tool                | Risk | Purpose                                                                                                                             |
| ------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `explain_device`    | READ | Full narrative for a device (live or from a snapshot)                                                                               |
| `explain_section`   | READ | One area in depth — firewall, VLANs, VPN, addressing                                                                                |
| `diff_explanations` | READ | Two snapshots → what changed **in plain language** ("VLAN 40 was added and given internet access via the existing masquerade rule") |

Module `src/tools/explain.ts`, label **"Config Narrative"**, group `Discovery & Meta`.

`diff_explanations` is the sleeper feature. `diff_config_snapshots` already shows a
line diff; this explains the _consequence_ of the diff, which is what a reviewer
actually needs.

## 5. Role inference

Keep it explicit and inspectable — a small scored signal table, not a heuristic
buried in prose:

| Signal                                    | Suggests            |
| ----------------------------------------- | ------------------- |
| default route + srcnat masquerade         | edge router         |
| `/interface wifi capsman` manager enabled | wireless controller |
| bridge with many ports, no default route  | switch              |
| PPP server + address pool                 | VPN concentrator    |
| BGP peers with external ASNs              | border router       |
| `/container` running                      | application host    |

Report the top role plus any secondaries, and expose the signals in the output so a
wrong inference is debuggable rather than mysterious. Multiple roles are normal — a
home router is edge + wireless + switch at once.

## 6. Dashboard — new page **Explain**

`ui/observability/explain.tsx`:

- **Device selector + generate** — with a snapshot picker, so you can explain the
  router as it was three weeks ago.
- **Rendered narrative** — the Markdown, sectioned and navigable. `markdown.ts`
  already exists in the UI.
- **Live Mermaid topology** — artifacts render Mermaid natively; in the dashboard,
  render the diagram inline. If pulling in a Mermaid renderer is too heavy for the
  single-file bundle, emit the diagram with the existing SVG layout approach from
  `topology-layout.ts` instead — **do not add a large dependency to the inlined
  bundle for this**.
- **Exposure panel** — what is reachable from the WAN, pulled out and given its own
  visually loud treatment. It is the part that matters most.
- **Compare mode** — two snapshots side by side with `diff_explanations` prose
  between them.
- **Export** — download as Markdown, copy to clipboard. People will paste this into
  a wiki, so make that one click.

Routes: `GET /api/explain/:device`, `GET /api/explain/:device/section/:name`,
`POST /api/explain/diff`.

## 7. Raycast — new command **explain**

`raycast/src/explain.tsx`, mode `view`. Device list → detail renders the narrative as
Markdown (Raycast's `Detail` is genuinely good at this, and this is one of the few
features whose output is _natively_ Markdown). Actions: **Copy as Markdown**,
**Save to file**, **Open in dashboard**, section dropdown.

This is the strongest Raycast fit in the backlog — a documentation reader is exactly
what a launcher detail view is for.

Add to `raycast/package.json` `commands[]`.

## 8. Implementation progress (loop state — source of truth)

> **Prerequisite:** `src/policy/parse.ts` (task 06 Phase 1). If task 06 has not
> started, do its Phase 1 first — do not write a second export parser.

### [x] Phase 1 — Analyser + roles

- [x] `src/narrative/analyze.ts` — parsed export → `DeviceNarrative` covering the
      nine sections in §2, with an `unknowns[]` array.
- [x] `src/narrative/roles.ts` — the §5 signal table, returning scored roles with
      their contributing signals.
- [x] `tests/narrative/analyze.spec.ts` — **44 cases** against fixture exports: home
      router (edge+wireless+switch), pure switch, CHR with BGP, VPN concentrator,
      multi-WAN with failover, a VLAN with no DHCP, an interface with no address,
      and an export containing an unrecognised menu → lands in `unknowns[]`.
- **Exit gate:** global gate green.

### [x] Phase 2 — Mermaid + render

- [x] `src/narrative/mermaid.ts` — topology → `graph LR`; deterministic node order
      so two runs of the same config produce identical output (required for diffing).
- [x] `src/narrative/render.ts` — `DeviceNarrative` → Markdown.
- [x] `tests/narrative/render.spec.ts` — snapshot tests on the fixtures; Mermaid
      output is stable across runs; special characters in interface names escaped.
- **Exit gate:** global gate green.

### [x] Phase 3 — Tools

- [x] `src/tools/explain.ts` (3 tools) + `src/tools/index.ts` + 3 schemas.
- [x] `diff_explanations` — consequence-level prose, not a line diff.
- [x] Update `prompts/backup-and-document.md` to call `explain_device` instead of
      dumping `/export` into context.
- [x] `docs/config-narrative.md` + README.
- **Exit gate:** global gate + `bun run gen` (new schemas only).

### [x] Phase 4 — Dashboard

- [x] 3 routes.
- [x] `ui/observability/explain.tsx` + `main.tsx` wiring: narrative, topology
      diagram, exposure panel, compare mode, export.
- **Exit gate:** global gate + `bun run build:ui`. **Bundle: 1351565 → 1362728 bytes (+11 KB, +0.83%)** — the page itself, no
  diagramming dependency; the topology reuses `topology-layout.ts`.

### [x] Phase 5 — Raycast

- [x] `raycast/src/explain.tsx` + `package.json` command + `lib/types.ts`.
- [x] Copy / Save actions.
- **Exit gate:** global gate + Raycast lint/typecheck.

### Blockers / notes

- ~~Mermaid rendering in the single-file dashboard bundle~~ **Decided in Phase 4:**
  reuse `topology-layout.ts`. Its hub → devices → neighbours radial layout maps
  exactly onto router → interfaces → bridge ports, so no dependency was added.
  The Mermaid SOURCE still travels with every response — it is what people paste
  into a wiki, and artifacts render it natively.

_(no other blockers)_
