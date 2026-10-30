---
title: "Service Health Contracts"
description: "Administrator-approved DNS/TCP/TLS/HTTPS service checks, immutable contracts, history and fail-closed rollout gates with explicit MCP-host perspective."
---

## Tools

- [Audit Enrolled Service Contracts](#audit_service_contracts)
- [List Approved Service Probe Targets](#list_service_probe_targets)
- [Create a Service Health Contract](#create_service_contract)
- [List Service Health Contracts](#list_service_contracts)
- [Check a Service Health Contract](#run_service_contract)
- [Read Service Contract History](#service_contract_history)

## audit_service_contracts

**Audit Enrolled Service Contracts** · Risk: **read**

Run the administrator-enrolled service contracts for this device (serviceProbes.scheduled) and return stable failures/unknowns for scheduled-audit regression notifications. New contracts are not enrolled automatically. At most five contracts and ten network checks; no router configuration writes.

No tool-specific parameters.

## list_service_probe_targets

**List Approved Service Probe Targets** · Risk: **read**

List the service probe aliases approved by the server administrator. Probes originate from the MCP host, not the router or client. No network request is made. Empty by default; edit serviceProbes.targets in the server config to enable explicitly bounded endpoints.

No tool-specific parameters.

## create_service_contract

**Create a Service Health Contract** · Risk: **write**

Save an immutable device-owned contract of DNS/TCP/TLS/HTTPS checks against administrator-approved aliases, latency thresholds and expected HTTPS status codes. Optionally attach a saved packet suite evaluated against a fresh device export. Definition only: no probes or router writes. To revise a contract, create a new one and select its new ID explicitly.

| Parameter       | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | `{"type":"string","minLength":1,"maxLength":120}`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `checks`        | Yes      | `{"minItems":1,"maxItems":10,"type":"array","items":{"type":"object","properties":{"target":{"type":"string","minLength":1,"maxLength":64},"maxLatencyMs":{"default":2000,"type":"integer","minimum":1,"maximum":10000},"expectedStatus":{"default":[200],"minItems":1,"maxItems":10,"type":"array","items":{"type":"integer","minimum":200,"maximum":599}}},"required":["target","maxLatencyMs","expectedStatus"],"additionalProperties":false}}` |
| `packetSuiteId` | No       | `{"type":"string","minLength":1,"maxLength":120}`                                                                                                                                                                                                                                                                                                                                                                                                  |

## list_service_contracts

**List Service Health Contracts** · Risk: **read**

Read up to 100 local service contract definitions owned by the selected device. No probes are run.

No tool-specific parameters.

## run_service_contract

**Check a Service Health Contract** · Risk: **read**

Run and record bounded DNS/TCP/TLS/HTTPS checks from the MCP host against server-approved, IP-pinned targets. No redirects, request credentials or response bodies. Report PASS/FAIL/UNKNOWN per check, not blanket client health. An optional packet suite reads a fresh /export terse from its device for this run; never tests an old baseline after a change. No router configuration writes. Unknown never passes a rollout gate. For scheduled checks, explicitly enroll contracts and schedule audit_service_contracts.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |

## service_contract_history

**Read Service Contract History** · Risk: **read**

Read the latest 100 recorded service checks for a contract owned by the selected device. A historical passing run is not a current gate result.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
