---
title: "Threat Feed"
description: "Subscribe to external threat-intel IP feeds: a scheduled fetch+import into a dynamic firewall address-list with an optional raw drop — a self-updating blocklist."
---

## Tools

- [Subscribe to Threat-Intel Feed](#subscribe_threat_feed)
- [Remove Threat-Intel Feed](#remove_threat_feed)

## subscribe_threat_feed

**Subscribe to Threat-Intel Feed** · Risk: **write**

Subscribes the router to an external threat-intelligence IP feed: installs a `/system script` that fetches `url` and imports it into the `address_list`, a `/system scheduler` that re-runs it every `interval`, and (when `drop=true`) a raw pre-conntrack drop for that list — a self-updating blocklist (e.g. Spamhaus DROP, tor exit nodes, your own deny list). `url` MUST point to a RouterOS `.rsc` file that populates the address-list. DEFAULTS TO A DRY RUN (`apply=false`); set `apply=true` to install. Script/scheduler/rule are named/tagged `threat-feed-<name>` so remove_threat_feed can undo them. Returns the plan or a build report.

| Parameter      | Required | Definition                                                                        |
| -------------- | -------- | --------------------------------------------------------------------------------- |
| `name`         | Yes      | Short feed id, e.g. 'spamhaus-drop' `{"type":"string"}`                           |
| `url`          | Yes      | HTTPS URL of a RouterOS .rsc address-list file `{"type":"string"}`                |
| `address_list` | Yes      | Address-list to populate `{"default":"threat-blocklist","type":"string"}`         |
| `interval`     | Yes      | How often to refresh the feed `{"default":"1h","type":"string"}`                  |
| `drop`         | Yes      | Also add a raw drop rule for the address-list `{"default":true,"type":"boolean"}` |
| `apply`        | Yes      | false = preview (default); true = install `{"default":false,"type":"boolean"}`    |

## remove_threat_feed

**Remove Threat-Intel Feed** · Risk: **destructive**

Removes a threat feed installed by subscribe_threat_feed: deletes its `/system scheduler` and `/system script` (named `threat-feed-<name>`) and any raw drop rule tagged for it. Does NOT flush the address-list entries themselves. Returns what was removed.

| Parameter | Required | Definition                                            |
| --------- | -------- | ----------------------------------------------------- |
| `name`    | Yes      | The feed id used when subscribing `{"type":"string"}` |
