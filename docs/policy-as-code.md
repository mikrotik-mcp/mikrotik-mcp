# Policy-as-Code

Every network team has house rules. They live in a wiki and are enforced by
memory. This makes them executable: write them as YAML, evaluate them against a
config snapshot, and get a compliance score with the offending line numbered.

Because it runs against a **snapshot**, it runs in CI on an export with no router
in the loop — and emits SARIF, so a router's configuration can be linted in a
pull request exactly like source code.

Six tools, in the **Policy Engine** module (Security group):

| Tool                     | Risk | What it does                                        |
| ------------------------ | ---- | --------------------------------------------------- |
| `list_policies`          | READ | Loaded rule files and their rules                   |
| `validate_policy_file`   | READ | Schema-check a rule file, with a path per error     |
| `run_policy_check`       | READ | Evaluate against a live device (captures `/export`) |
| `check_policy_snapshot`  | READ | Evaluate against a stored snapshot — no device I/O  |
| `explain_policy_finding` | READ | One finding in depth: rule, lines, why, how to fix  |
| `export_policy_report`   | READ | Markdown / JSON / SARIF                             |

**All six are READ and this feature never writes to a device.** Remediation is
what [Security Hardening](./security-hardening.md) and
[Change Plan](./change-plan.md) are for. Keeping the linter strictly read-only is
what makes it safe to point at production, or at a colleague's export.

## Why, given Compliance Auditor exists

`Compliance Auditor` and `Security Hardening` run the checks **this repo** chose.
They cannot express "at this company, every WAN interface has RPF on and every
`input accept` references a src address-list". That is what this is for.

## Writing a rule

```yaml
version: 1
name: My house rules
policies:
  - id: no-bare-input-accept
    severity: critical
    description: An input-chain accept must be scoped.
    remediation: Add src-address-list= or in-interface-list= to the rule.
    match:
      section: /ip/firewall/filter
      where: { chain: input, action: accept }
    assert:
      any_of:
        - { field: src-address-list, present: true }
        - { field: in-interface-list, present: true }
        - { field: connection-state, contains: established }
    tags: [firewall]
```

### `match` — which records the rule judges

| Key        | Meaning                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| `section`  | Menu path. `/ip firewall filter` and `/ip/firewall/filter` are equivalent. |
| `where`    | Only records whose fields equal these values.                              |
| `settings` | Merge the section's `set` lines into ONE record (for `/ip/ssh` etc.).      |

A record is one `add`/`set` line. Bare flags (`blackhole`) read as `yes`, the
negated form (`!blackhole`) as `no`, and a positional selector
(`/ip service set telnet …`) is surfaced as `name`, so `where: {name: telnet}`
works.

### `assert` — the closed predicate set

`present` · `absent` · `equals` · `not_equals` · `in` · `not_in` · `contains` ·
`matches` · `count` (`min`/`max`/`exactly`) · `any_of` · `all_of` · `none_of`

There are **no expressions and no code**. A rule file is untrusted input — it
arrives from a repo, a PR, or a colleague — so evaluating one can do nothing but
read the parsed config. `matches` patterns are capped at 200 characters and
anchored (`^(?:…)$`), because an unbounded unanchored pattern from an untrusted
file is a ReDoS vector aimed at your own auditor.

Exactly **one** predicate per leaf. Two in one object reads as "and" to an author
but would evaluate only the first, so the schema rejects it.

### The authoring trap worth knowing

**A missing field fails every value predicate.** "must equal X" is not satisfied
by there being no field at all — treating absence as a pass is the easiest way to
write a rule that silently never fires.

So:

```yaml
# "must not be yes, and absent is fine" — the usual intent
assert:
  none_of:
    - { field: disabled, equals: "yes" }

# "must be present AND different from yes" — a stricter, rarer rule
assert: { field: disabled, not_equals: "yes" }
```

### Zero matches is not a pass

A rule whose `section`/`where` matches nothing is **not-applicable**, not
passing. A rule about WAN interfaces on a router with no WAN is neither
compliant nor violating, and scoring it as a pass is how "100% compliant" comes
to mean "we checked nothing". Override per rule with `on_empty: pass | fail`
(`fail` is how you say "this section must exist at all").

Not-applicable rules are excluded from **both halves** of the score.

### The score counts rules, not findings

A rule that fails on eight of ten firewall lines is one broken rule. Scoring by
finding count would let a single sloppy rule dominate a whole report.

## Running a check

```
check_policy_snapshot snapshot_id=snap_1730900000000_ab12cd34
run_policy_check                     # captures /export terse first
explain_policy_finding rule_id=no-bare-input-accept
export_policy_report format=sarif > policy.sarif
```

`run_policy_check` uses `/export terse` — a read-only print. It writes nothing to
the device and leaves no file on it.

## Rule file discovery

```jsonc
{
  "policy": {
    "paths": ["./mikrotik-policies/*.yaml"],
    "includeStarterPack": true,
  },
}
```

Also `MIKROTIK_POLICY_PATHS` (comma-separated) or `--policy-paths`. A bare
directory loads every `.yaml` / `.yml` / `.json` in it. YAML is parsed with Bun's
native `Bun.YAML` — no dependency — and JSON rule files work everywhere, since
JSON is a strict subset of YAML.

**Duplicate rule ids are rejected within a file** (ids are how findings are
tracked over time, so duplicates make history meaningless) and **reported across
files**, where the first definition wins.

A file that fails validation is listed **with its errors** rather than dropped: a
policy set that silently shrank because someone mistyped a key is worse than one
that says so.

## The starter pack

`policies/baseline.yaml` ships 18 rules drawn from the existing hardening checks
— telnet/FTP disabled, SSH strong crypto, default-deny input chain, no bare input
accept, RPF on, NTP enabled, remote logging, no open DNS resolver. It is loaded
by default (`policy.includeStarterPack`) and doubles as a worked example of every
part of the schema.

It is a starting position, not a standard. Copy it, edit it, point `policy.paths`
at your copy.

## SARIF in CI

```yaml
- run: mikrotik-mcp … export_policy_report format=sarif > policy.sarif
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: policy.sarif }
```

Each finding carries the export line that caused it, so it annotates the right
line of the config in a pull request — which is why the parser keeps line numbers
at all.

## Architecture

```
src/policy/parse.ts     PURE — /export text → sectioned record model
src/policy/schema.ts    Zod rule-file schema (closed predicates, capped regexes)
src/policy/evaluate.ts  PURE — Policy[] × model → Finding[]
src/policy/report.ts    PURE — findings → Markdown / JSON / SARIF
src/policy/load.ts      the only I/O: read rule files, validate, cache
src/tools/policy.ts     the six tools
```

`parse.ts` is the reusable half — a real structured model of an `/export`, which
the snapshot subsystem never had. 78 offline tests cover it and the evaluator.
