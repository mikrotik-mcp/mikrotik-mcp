---
title: "Client Check"
description: "Bounded browser-side network tests, Wi-Fi/VPN comparison and investigation evidence."
---

## Tools

- [Create a Client Network Check](#create_client_check)
- [Read Client Network Checks](#list_client_checks)
- [Compare Two Client Test Runs](#compare_client_checks)
- [Revoke a Client Check Invitation](#close_client_check)

## create_client_check

**Create a Client Network Check** · Risk: **write**

Create a 5–60 minute, six-run browser test invitation. Open returned clientPath on the affected phone/laptop via a reachable dashboard address; the fragment token grants test access only, never dashboard access. Explicit user start transfers at most 20 MiB per run to THIS MCP host. This is not internet throughput unless the host is on the remote path. Measures browser HTTP latency, loaded latency and transfers, not ICMP, DNS leakage, PMTU or app availability. Optional caseId links historical investigation evidence. No router changes.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label`   | Yes      | `{"type":"string","minLength":1,"maxLength":80}`                                                                                                                                                                         |
| `caseId`  | No       | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `minutes` | Yes      | `{"default":15,"type":"integer","minimum":5,"maximum":60}`                                                                                                                                                               |

## list_client_checks

**Read Client Network Checks** · Risk: **read**

Read browser-reported measurements saved for this router. Tokens are never returned. Observed peer IP belongs to this HTTP connection, not necessarily the user's public internet exit. Does not run tests or contact routers.

No tool-specific parameters.

## compare_client_checks

**Compare Two Client Test Runs** · Risk: **read**

Compare two complete browser test runs in one session, for example Wi-Fi vs WireGuard. Requires the same endpoint. Measurements are client-reported and sequential, not proof of a bottleneck or a fastest route.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `first`   | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
| `second`  | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |

## close_client_check

**Revoke a Client Check Invitation** · Risk: **write**

Immediately close the selected test invitation. Rejects further measurements while retaining saved history. No router configuration changes.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
