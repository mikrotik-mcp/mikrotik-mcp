---
title: "Network Flight Recorder"
description: "Durable bounded pre/post-incident telemetry, off-router log metadata and MCP change correlation."
---

## Tools

- [Read Network Flight Recorder](#get_flight_recorder)
- [Configure Network Flight Recorder](#configure_flight_recorder)
- [Freeze Network Incident Evidence](#freeze_network_incident)
- [Export Network Incident Evidence](#export_network_incident)

## get_flight_recorder

**Read Network Flight Recorder** · Risk: **read**

Read bounded persistent telemetry, off-router log metadata, capture gaps and frozen incidents for this router. No active probes. Times are host receipt times; correlation never proves cause, identity or a network outage.

No tool-specific parameters.

## configure_flight_recorder

**Configure Network Flight Recorder** · Risk: **write**

Explicitly enable/disable periodic read-only router collection and local retention. No router configuration writes. Stores bounded resources, interface state, classified log metadata and MCP write/failure metadata; no raw messages or credentials. Requires the MCP process to stay running. SSH polling can miss logs; not a lossless syslog service.

| Parameter         | Required | Definition                                                   |
| ----------------- | -------- | ------------------------------------------------------------ |
| `enabled`         | Yes      | `{"type":"boolean"}`                                         |
| `intervalSeconds` | Yes      | `{"default":60,"type":"integer","minimum":30,"maximum":300}` |
| `windowMinutes`   | Yes      | `{"default":60,"type":"integer","minimum":15,"maximum":360}` |
| `retentionDays`   | Yes      | `{"default":7,"type":"integer","minimum":1,"maximum":30}`    |

## freeze_network_incident

**Freeze Network Incident Evidence** · Risk: **write**

Preserve this router's available rolling evidence plus two minutes of future samples when recording is enabled. Local operation only. Empty history stays empty; cannot recover past logs. Maximum 30 incidents, configured age retention.

| Parameter | Required | Definition                                        |
| --------- | -------- | ------------------------------------------------- |
| `title`   | Yes      | `{"type":"string","minLength":1,"maxLength":120}` |

## export_network_incident

**Export Network Incident Evidence** · Risk: **read**

Export a device-scoped frozen incident with coverage gaps and separate router/receive timestamps. No raw logs or command bodies. Review device/interface names before sharing. Do not attribute an attack to a user based only on these observations.

| Parameter | Required | Definition                                                                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | Yes      | `{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\|00000000-0000-0000-0000-000000000000\|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}` |
