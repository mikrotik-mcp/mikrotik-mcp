---
title: "Policy Engine"
description: "Policy-as-code: evaluate an organisation's OWN compliance rules (YAML) against a config snapshot — offline, read-only, CI-able, with Markdown/JSON/SARIF output."
---

## Tools

- [List Loaded Policy Rules](#list_policies)
- [Validate a Policy Rule File](#validate_policy_file)
- [Check Policies Against a Snapshot](#check_policy_snapshot)
- [Run a Policy Check on a Device](#run_policy_check)
- [Explain a Policy Finding](#explain_policy_finding)
- [Export the Policy Report](#export_policy_report)

## list_policies

**List Loaded Policy Rules** · Risk: **read**

Lists every loaded policy rule file and the rules inside it — id, severity, what it asserts and which section it applies to. Rules come from `policy.paths` (or MIKROTIK_POLICY_PATHS) plus the bundled starter pack. A file that failed validation is listed WITH its errors rather than dropped, so a policy set that silently shrank is visible. Contacts no device.

| Parameter  | Required | Definition                                                                                       |
| ---------- | -------- | ------------------------------------------------------------------------------------------------ |
| `tag`      | No       | Only rules carrying this tag `{"type":"string"}`                                                 |
| `severity` | No       | Only rules of this severity `{"type":"string","enum":["critical","high","medium","low","info"]}` |

## validate_policy_file

**Validate a Policy Rule File** · Risk: **read**

Schema-checks a policy rule file — as inline text or a path — and reports each problem with the path into the document (`policies.2.assert.field`), so a rule file can be authored iteratively without running it against anything. Catches what silently breaks a rule set: duplicate ids, two predicates in one leaf, an unknown key, an over-long or invalid regex. Contacts no device and reads no config.

| Parameter | Required | Definition                                              |
| --------- | -------- | ------------------------------------------------------- |
| `content` | No       | Rule file text (YAML or JSON) `{"type":"string"}`       |
| `path`    | No       | Path to a rule file to read instead `{"type":"string"}` |

## check_policy_snapshot

**Check Policies Against a Snapshot** · Risk: **read**

Evaluates the loaded policy rules against a STORED configuration snapshot — no device is contacted at all, which is what makes this runnable in CI. Pass `snapshot_id` (from list_config_snapshots), or `config_text` to check an export you already have. Reports a compliance score, the failing rules by severity, and the offending config line for each. A rule matching nothing is reported as NOT APPLICABLE, never as a pass.

| Parameter     | Required | Definition                                                 |
| ------------- | -------- | ---------------------------------------------------------- |
| `snapshot_id` | No       | Snapshot id to evaluate `{"type":"string"}`                |
| `config_text` | No       | Raw `/export` text to evaluate instead `{"type":"string"}` |
| `device`      | No       | Label the report with this device name `{"type":"string"}` |

## run_policy_check

**Run a Policy Check on a Device** · Risk: **read**

Captures the device's current configuration (`/export terse`, a read-only print — it writes nothing and leaves no file on the router) and evaluates every loaded policy rule against it. This is the live version of check_policy_snapshot: same rules, same report, freshest config. Nothing is ever written to the device — remediation belongs to the hardening and change-plan tools, and keeping this read-only is what makes it safe to run against production.

| Parameter | Required | Definition                                                |
| --------- | -------- | --------------------------------------------------------- |
| `tag`     | No       | Only evaluate rules carrying this tag `{"type":"string"}` |

## explain_policy_finding

**Explain a Policy Finding** · Risk: **read**

Explains one finding from the most recent policy check in depth: the rule, the offending configuration line, why it failed (expected versus actual) and the remediation. Use it after run_policy_check or check_policy_snapshot when a finding needs to become an action. Reads the cached report — no device is contacted.

| Parameter | Required | Definition                                                           |
| --------- | -------- | -------------------------------------------------------------------- |
| `rule_id` | Yes      | Rule id from the report `{"type":"string"}`                          |
| `device`  | No       | Which device's report, when several were checked `{"type":"string"}` |

## export_policy_report

**Export the Policy Report** · Risk: **read**

Renders the most recent policy check as Markdown, JSON or **SARIF 2.1.0**. SARIF is the format GitHub code-scanning ingests, so a router's configuration can be linted in a pull request exactly like source code — each finding lands on the line of the export that caused it. Reads the cached report; no device is contacted.

| Parameter  | Required | Definition                                                                             |
| ---------- | -------- | -------------------------------------------------------------------------------------- |
| `format`   | Yes      | `{"default":"markdown","type":"string","enum":["markdown","json","sarif"]}`            |
| `device`   | No       | Which device's report, when several were checked `{"type":"string"}`                   |
| `artifact` | No       | SARIF artifact path the findings point at (default `<device>.rsc`) `{"type":"string"}` |
