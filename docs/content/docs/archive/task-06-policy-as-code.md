---
title: "06 \u2014 Policy-as-code linting"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 06 — Policy-as-code linting

> **Status:** implemented — all 5 phases complete.
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §8 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Let an organisation author its **own** compliance rules in YAML and evaluate them
against a config snapshot — offline, no device, CI-able — turning the snapshot format
into a testable artifact rather than a blob you diff by eye.

## 1. Why, given Compliance Auditor already exists

`Compliance Auditor` and `Security Hardening` run a **fixed** set of checks the repo
authors chose. They cannot express "at this company, every WAN interface must have
RPF enabled and every `input accept` must reference a src address-list."

Every network team has house rules. Today they live in a wiki and are enforced by
memory. This makes them executable — and because it runs against a _snapshot_, it
runs in CI on a config export with no router in the loop.

## 2. Rule language

Deliberately **not** a general-purpose language. A small declarative schema that
covers the real cases and stays analysable:

```yaml
version: 1
policies:
  - id: wan-rpf-required
    severity: high
    description: Every WAN interface must have reverse-path filtering on.
    match: { section: /ip/settings }
    assert: { field: rp-filter, in: [strict, loose] }

  - id: no-bare-input-accept
    severity: critical
    description: An input-chain accept must be scoped by address-list or interface.
    match: { section: /ip/firewall/filter, where: { chain: input, action: accept } }
    assert:
      any_of:
        - { field: src-address-list, present: true }
        - { field: in-interface-list, present: true }
        - { field: connection-state, contains: established }

  - id: ssh-strong-crypto
    severity: high
    match: { section: /ip/ssh }
    assert: { field: strong-crypto, equals: "yes" }
```

Supported predicates — keep this list closed:
`present` · `absent` · `equals` · `not_equals` · `in` · `not_in` · `contains` ·
`matches` (anchored regex) · `count` (`min`/`max`/`exactly`) · `any_of` · `all_of` ·
`none_of`.

**No arbitrary expressions, no code execution.** A rule file is untrusted input: it
may come from a repo, a PR, or a colleague. A closed predicate set means evaluating
one can never do more than read the parsed config.

`matches` regexes must be length-capped and compiled once, or a rule file becomes a
ReDoS vector against your own auditor.

## 3. Architecture

```
src/policy/schema.ts    Zod schema for a rule file → typed Policy[]
src/policy/parse.ts     PURE — /export text → sectioned record model
src/policy/evaluate.ts  PURE — Policy[] × model → Finding[]
src/policy/report.ts    PURE — findings → rendered report / JSON / SARIF
src/tools/policy.ts     6 tools
```

`parse.ts` is the reusable win: a real structured model of an `/export`. The
snapshot subsystem currently normalizes text (`src/snapshots/format.ts`) but does not
give a queryable model. Build it here, and tasks 08 and 10 both consume it.

Everything is pure. The only I/O in the whole feature is reading a YAML file and
loading a snapshot — both already solved elsewhere.

## 4. Tools (6)

| Tool                     | Risk | Purpose                                                                               |
| ------------------------ | ---- | ------------------------------------------------------------------------------------- |
| `list_policies`          | READ | Loaded rule files and their rules                                                     |
| `validate_policy_file`   | READ | Schema-check a rule file, with line-accurate errors                                   |
| `run_policy_check`       | READ | Evaluate against a live device (captures a snapshot first)                            |
| `check_policy_snapshot`  | READ | Evaluate against a stored snapshot — no device I/O                                    |
| `explain_policy_finding` | READ | One finding in depth: the rule, the offending config lines, why it failed, how to fix |
| `export_policy_report`   | READ | Report as Markdown / JSON / SARIF                                                     |

Module `src/tools/policy.ts`, label **"Policy Engine"**, group `Security`.

All six are `READ`. **This feature never writes to a device** — remediation is what
`Security Hardening` and `Change Plan` are for, and keeping the linter read-only is
what makes it safe to run anywhere, including CI.

SARIF output is the detail that makes this land in GitHub code-scanning, which is a
genuinely compelling demo for a network config.

## 5. Rule file discovery

`policy.paths` config (array of globs), default `["./mikrotik-policies/*.yaml"]`.
Also `MIKROTIK_POLICY_PATHS`. Bundle a starter pack in `policies/` — 12-15 rules
drawn from the existing hardening checks, so the feature is useful on first run and
doubles as documentation of the schema.

Reject a rule file with duplicate ids. Rule ids are how findings are suppressed and
tracked over time; duplicates make history meaningless.

## 6. Dashboard — new page **Policies**

`ui/observability/policies.tsx`:

- **Compliance score header** — per device: passing / failing / not-applicable, with
  a trend sparkline from stored past runs. Scores are motivating in a way that
  finding lists are not.
- **Findings table** — grouped by severity, each row expandable to the offending
  config lines with the failing property highlighted (`highlight.tsx` already exists).
- **Rule browser** — every loaded rule, its YAML source, and which devices it passes
  on. Doubles as the documentation surface.
- **Fleet matrix** — rules × devices heat grid. One glance shows whether a failure is
  one broken router or a systemic gap.
- **Validation panel** — paste or upload a rule file and see schema errors live,
  which is how people will actually author rules.

Routes: `GET /api/policies`, `GET /api/policies/results`,
`POST /api/policies/run`, `POST /api/policies/validate`.

## 7. Raycast — new command **policies**

`raycast/src/policies.tsx`, mode `view`. Findings list grouped by severity with a
device dropdown; detail shows the rule and the offending lines as Markdown. Actions:
**Run check**, **Copy report**, **Open in dashboard**. Severity as a colored accessory
icon.

Add to `raycast/package.json` `commands[]`.

## 8. Implementation progress (loop state — source of truth)

### [x] Phase 1 — Export parser

- [x] `src/policy/parse.ts` — `/export` text → sectioned `ConfigRecord[]` with
      `fields`, bare `flags`, the source `line` and the joined `raw` text, plus
      `recordsOf()` / `settingsOf()` accessors and an `unparsed` list.
- [x] `tests/policy/parse.spec.ts` — **31 cases** covering every listed trap plus:
      escaped quotes/backslashes, an empty quoted value, the negated `!flag` form,
      an inline command on the menu line, a three-line continuation, an export
      ending mid-continuation, CRLF, and every RouterOS verb.
- **Exit gate:** global gate green (1074 tests).

Decisions carried forward:

- A **bare flag** (`blackhole`) is materialised as `field = "yes"` and listed in
  `flags`; `!flag` becomes `"no"`. A rule can then say `{field: blackhole,
equals: "yes"}` without knowing the export's syntax.
- A menu **opened twice** contributes to one logical section (`lines` records both
  open positions). Splitting it would hide half the records from every rule.
- Unrecognised lines land in `unparsed` instead of being dropped, so a check can
  admit it only half-understood a config rather than reporting a confident pass.
- `settingsOf()` merges a section's `set` lines into one record, later-wins —
  which is what the device does when replaying the export.

### [x] Phase 2 — Schema + evaluator

- [x] `src/policy/schema.ts` — Zod schema, closed predicate set, length-capped
      regexes, duplicate-id rejection, `decodePolicyText` (YAML via `Bun.YAML`,
      JSON otherwise).
- [x] `src/policy/evaluate.ts` — every predicate from §2; a finding carries rule id,
      severity, device, section, source line, evidence and actual-vs-expected.
- [x] `src/policy/report.ts` — Markdown, JSON, SARIF 2.1.0 + `explainFinding`.
- [x] `tests/policy/evaluate.spec.ts` — **44 cases**: two per predicate, `any_of`
      short-circuit naming the branch that passed, `count` boundaries (min/max/
      exactly, and over an empty set), zero-match → not-applicable, and a malformed
      rule file rejected with a usable message.
- **Exit gate:** global gate green (1118 tests).

Decisions carried forward:

- **A missing field fails every value predicate.** "must equal X" is not satisfied
  by there being no field; treating absence as a pass is the easiest way to write a
  rule that silently never fires.
- **`matches` is anchored at evaluation** (`^(?:…)$`) as well as length-capped at
  parse: an unanchored pattern from an untrusted file is both a ReDoS risk and the
  source of "why does this match everything".
- **Exactly one predicate per leaf**, enforced by the schema — two in one object
  reads as "and" to an author but would evaluate only the first.
- **The score counts rules, not findings.** A rule failing on eight of ten firewall
  lines is one broken rule; scoring by finding would let one sloppy rule dominate.
- `contains` matches a member of a comma-separated RouterOS list as well as a
  substring, because `connection-state=established,related` is the common case.

### [x] Phase 3 — Tools + starter pack

- [x] `src/tools/policy.ts` (6 tools, all READ) + `src/tools/index.ts` (label
      **Policy Engine**, slug `policy`, group Security) + 6 schemas +
      `src/policy/load.ts` (the feature's only I/O) + `src/policy/session.ts`.
- [x] `policies/baseline.yaml` — **18 rules** + `policy.paths` /
      `policy.includeStarterPack` config + `MIKROTIK_POLICY_PATHS` +
      regenerated `schemas/config.schema.json`. Also added to `package.json` files
      and the `.mcpb` COPY list, or a bundle would start with zero rules.
- [x] `docs/policy-as-code.md` + README + `docs/README.md`.
- **Exit gate:** global gate + `bun run gen` (6 new schemas only) + the starter
  pack verified against fixture exports: **100% on a clean config, 18 rules
  loaded, 0 invalid files**, and a deliberately broken export flags exactly
  `telnet-disabled`, `input-chain-has-drop`, `no-bare-input-accept`.

Two things the fixture run caught, both kept:

- The parser now surfaces a **positional selector** as `name`
  (`/ip service set telnet …`), or every rule about a named service matched
  nothing and quietly reported "not applicable".
- Several starter rules were rewritten from `not_equals` to `none_of` +
  `equals`: a missing field fails every value predicate, and most exports simply
  omit `disabled=`. That distinction is now the documented authoring trap.

### [x] Phase 4 — Dashboard

- [x] `src/observability/policy-routes.ts` — `GET /api/policies`,
      `GET /api/policies/results`, `POST /api/policies/run`,
      `POST /api/policies/validate` — plus `src/policy/results.ts`, a result
      history in `snapshots.db` so the score has a trend.
- [x] `ui/observability/policies.tsx` (score header with sparkline, fleet matrix,
      expandable findings, rule browser, live validator) + `main.tsx` wiring +
      `types.ts`.
- **Exit gate:** global gate + `bun run build:ui` (observability.html 1.30 MB).

Notes: only FAILING findings are persisted — a passing rule's finding says nothing
a re-run would not, and storing them all turns a fleet sweep into megabytes of
"still fine". A fleet run keeps going when one router is unreachable; that device
gets an `error` row rather than aborting the sweep.

### [x] Phase 5 — Raycast

- [x] `raycast/src/policies.tsx` — compliance score per device, findings grouped by
      severity with a device dropdown, Markdown detail carrying the rule, the
      offending line and the fix; Run check / Copy remediation / Open in dashboard.
- [x] `package.json` command entry + `lib/types.ts`.
- **Exit gate:** global gate + `npm run lint` (0 errors) + `tsc --noEmit`
  (0 errors in the new file; `src/lib/diff.tsx` keeps its pre-existing
  duplicate-React type error).

### Blockers / notes

- ~~YAML parsing needs a dependency.~~ **Resolved before Phase 1:** Bun 1.3 ships
  **`Bun.YAML`** natively, so no dependency was added. `decodePolicyText` uses it
  when present and falls back to `JSON.parse` otherwise — JSON being a strict
  subset of YAML means a JSON rule file is valid everywhere, which also keeps the
  pure engine testable on the Node test runner where `Bun` does not exist.

**All phases complete.** Known gaps, none blocking:

- Rule files are read fresh on every call (no cache invalidation to get wrong);
  a very large policy set would re-read and re-validate per check.
- `run_policy_check`'s `tag` filter narrows the rules evaluated, but the stored
  result then reflects only that subset — the trend line assumes full runs.
- The evaluator has one level of combinator nesting (`any_of` of leaves). Deeper
  trees were deliberately not built; an untrusted rule file is not where unbounded
  recursion belongs.
