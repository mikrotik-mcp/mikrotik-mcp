---
title: "Compliance Auditor"
description: "Comprehensive device security posture audit — SSH, services, firewall, users, DNS, certificates, network services, system hardening, VPN — scored A+ through F with per-check pass/fail/warn and fix commands."
---

## Tools

- [Run Network Compliance Audit](#run_compliance_audit)
- [Fleet-wide Compliance Audit](#audit_fleet)
- [Apply Compliance Fixes](#audit_remediate)
- [List Compliance Checks](#list_compliance_checks)

## run_compliance_audit

**Run Network Compliance Audit** · Risk: **read**

Deep-scan a single device's security posture across SSH, management services, firewall, users, DNS, certificates, network services, SNMP, system hardening and VPN — 36 checks scored A+ through F with per-check pass/fail/warn and fix commands. Returns a scored compliance report. Optionally narrow by category or severity, and generate a combined RouterOS fix script. For fleet-wide audit across all devices use `audit_fleet`. For firewall-specific analysis use `firewall_audit`; for certificate lifecycle use `cert_expiry_audit`; for hardening use `security_shield`. This tool ties them all together into a unified compliance grade.

| Parameter             | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `categories`          | No       | Narrow the audit to specific categories. Available: ssh_security, management_services, firewall_posture, user_security, dns_security, certificate_health, network_services, snmp_security, system_hardening, vpn_security. Omit to audit all. `{"type":"array","items":{"type":"string","enum":["ssh_security","management_services","firewall_posture","user_security","dns_security","certificate_health","network_services","snmp_security","system_hardening","vpn_security"],"description":"Category slug to filter by."}}` |
| `severity_threshold`  | No       | Only report checks at or above this severity (default: all). `{"type":"string","enum":["critical","high","medium","low"]}`                                                                                                                                                                                                                                                                                                                                                                                                       |
| `generate_fix_script` | Yes      | Append a combined RouterOS fix script for all failing checks. `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                                                                                                               |

## audit_fleet

**Fleet-wide Compliance Audit** · Risk: **read**

Run the compliance audit across ALL configured devices (or a specified subset) and return a consolidated fleet report with per-device grades, an aggregate fleet score, and a summary of the most common failures across the fleet. For single-device audit use `run_compliance_audit`.

| Parameter             | Required | Definition                                                                                                                 |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `devices`             | No       | Subset of device names to audit. Omit to audit all configured devices. `{"type":"array","items":{"type":"string"}}`        |
| `severity_threshold`  | No       | Only report checks at or above this severity (default: all). `{"type":"string","enum":["critical","high","medium","low"]}` |
| `generate_fix_script` | Yes      | Append per-device fix scripts. `{"default":false,"type":"boolean"}`                                                        |

## audit_remediate

**Apply Compliance Fixes** · Risk: **write**

Run the compliance audit on a device and automatically apply fix commands for all failing/warning checks that have a known fix. Returns the audit report followed by the result of each applied fix command. Use `run_compliance_audit` with `generate_fix_script=true` first to preview fixes, then call this tool to apply them. Only applies fixes for checks that actually fail; checks that already pass are untouched.

| Parameter            | Required | Definition                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `categories`         | No       | Narrow remediation to specific categories. `{"type":"array","items":{"type":"string","enum":["ssh_security","management_services","firewall_posture","user_security","dns_security","certificate_health","network_services","snmp_security","system_hardening","vpn_security"],"description":"Category slug to filter by."}}` |
| `severity_threshold` | No       | Only remediate checks at or above this severity. `{"type":"string","enum":["critical","high","medium","low"]}`                                                                                                                                                                                                                |
| `dry_run`            | Yes      | Preview fix commands without applying (default: true). Set false to apply. `{"default":true,"type":"boolean"}`                                                                                                                                                                                                                |

## list_compliance_checks

**List Compliance Checks** · Risk: **read**

Reference listing of all compliance checks — ID, category, severity and title. No device connection needed. Use to understand available checks before running `run_compliance_audit` with category or severity filters.

| Parameter  | Required | Definition                                                                                                                                                                                                                                 |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `category` | No       | Filter to a single category. `{"type":"string","enum":["ssh_security","management_services","firewall_posture","user_security","dns_security","certificate_health","network_services","snmp_security","system_hardening","vpn_security"]}` |
