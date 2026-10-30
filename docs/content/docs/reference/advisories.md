---
title: "Vulnerability Audit"
description: "Published RouterOS advisories (CVEs) matched against the running version and ranked by whether the affected service is actually enabled and reachable."
---

## Tools

- [Audit Device Against Known RouterOS Advisories](#audit_known_vulnerabilities)
- [List the Bundled RouterOS Advisory Dataset](#list_security_advisories)

## audit_known_vulnerabilities

**Audit Device Against Known RouterOS Advisories** · Risk: **read**

Cross-references the RouterOS version this device runs against published security advisories (CVEs), then RANKS each match by whether the affected surface is actually reachable — reading `/ip service` to see if the vulnerable service is enabled and whether it is restricted to a management subnet. This is the difference between 'you are behind on patches' and 'this specific hole is open to the internet right now'. Returns each matching advisory with its severity, CVSS, effective risk score, exposure, the exact version that fixes it, and the remediation steps. Read-only — reads `/system resource`, `/ip service` and `/system package`, changes nothing. Use `firmware_check` for 'is there a newer release'; use this for 'does it matter'. Set `all_devices` to audit the whole fleet at once.

| Parameter           | Required | Definition                                                                                                                                                       |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all_devices`       | No       | Audit every configured device instead of just the target device. `{"type":"boolean"}`                                                                            |
| `min_severity`      | No       | Only report findings at or above this severity. `{"type":"string","enum":["critical","high","medium","low"]}`                                                    |
| `include_mitigated` | No       | Include advisories whose affected service is disabled (default false — these are matches on version alone and are not currently reachable). `{"type":"boolean"}` |

## list_security_advisories

**List the Bundled RouterOS Advisory Dataset** · Risk: **read**

Lists the RouterOS security advisories this server checks against, with their affected version ranges, severity, CVSS, exposure conditions and remediation. Contacts NO device — it is the reference dataset itself, useful for answering 'what does the audit actually cover?' and for checking whether a specific CVE is in scope before trusting a clean audit result. Use audit_known_vulnerabilities to evaluate these against a real device.

| Parameter   | Required | Definition                                                         |
| ----------- | -------- | ------------------------------------------------------------------ |
| `id_filter` | No       | Match an advisory id (substring, e.g. `2023`). `{"type":"string"}` |
