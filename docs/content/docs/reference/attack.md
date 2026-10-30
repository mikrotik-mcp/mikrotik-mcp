---
title: "Attack Detection"
description: "Watch the fleet's logs for brute force, credential spraying, a login that SUCCEEDED after failures, port scans and unexplained config changes; correlate them into incidents with evidence, and block the source with a timed, reversible, rate-limited entry when asked."
---

## Tools

- [Scan for Attacks Now](#scan_for_attacks)
- [List Attack Incidents](#list_attack_incidents)
- [Attack Incident Detail](#get_attack_incident)
- [Block an Attacker](#block_attacker)
- [Unblock an Address](#unblock_attacker)
- [List Attack Responses](#list_attack_responses)
- [Show Attack Response Policy](#configure_attack_response)

## scan_for_attacks

**Scan for Attacks Now** · Risk: **read**

Reads recent logs from every configured device, runs the attack detectors, and correlates what they find into incidents — brute force, credential spraying, a login that SUCCEEDED after failures, port scans, management ports answering the internet, and unexplained changes to security-relevant configuration. Read-only: it changes nothing on any device. One source hitting several routers is reported as ONE incident, which is the pattern no single router can see. Detectors whose input is missing say so and name the fix, rather than reporting a quiet network. Pass `devices` for one router, or `online_only` to skip the ones currently unreachable — any device left out is named in the result.

| Parameter        | Required | Definition                                                                                                                                                                                     |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices`        | No       | Limit to these devices (default: all). `{"type":"array","items":{"type":"string"}}`                                                                                                            |
| `online_only`    | Yes      | Skip devices the health probe currently reports as unreachable. A device not yet probed is still scanned — never probed is not the same as known-offline. `{"default":false,"type":"boolean"}` |
| `window_minutes` | No       | How far back to read. Default from config (10). `{"type":"integer","exclusiveMinimum":0,"maximum":1440}`                                                                                       |

## list_attack_incidents

**List Attack Incidents** · Risk: **read**

Lists recorded attack incidents newest-first: attacker address, how far they got (recon → attempt → breach → persistence), how much the evidence justifies believing it, which devices they touched, and when. Use get_attack_incident for the evidence behind one. Reads stored history — it does not contact any device.

| Parameter        | Required | Definition                                                                                                 |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `hours`          | Yes      | How far back. `{"default":24,"type":"integer","exclusiveMinimum":0,"maximum":8760}`                        |
| `min_confidence` | No       | Only incidents at or above this confidence. `{"type":"string","enum":["low","medium","high","confirmed"]}` |
| `limit`          | Yes      | `{"default":50,"type":"integer","exclusiveMinimum":0,"maximum":500}`                                       |

## get_attack_incident

**Attack Incident Detail** · Risk: **read**

One incident in full: the story, every piece of evidence with its raw log line and timestamp, which detectors fired, the devices affected, and the existing tools that address it. Use this before deciding whether to block someone — an incident that cannot show its work should not be acted on.

| Parameter | Required | Definition                                                  |
| --------- | -------- | ----------------------------------------------------------- |
| `id`      | Yes      | Incident id from list_attack_incidents. `{"type":"string"}` |

## block_attacker

**Block an Attacker** · Risk: **write**

Blocks an attacker by adding their address to the `mcp-attack-block` address list on every affected device, behind a single raw-chain drop rule created once per device. DRY RUN unless confirm=true. Timed by default so a wrong block expires on its own; a permanent block needs an explicit timeout of ''. REFUSED, whatever you pass, when: the evidence is only spoofable (a forged flood would let the attacker choose the victim), the address is this server's own management path or a device or its gateway/resolver, or the per-hour response cap has been reached. A confirmed breach escalates instead — blocking the source does not undo someone already being in.

| Parameter     | Required | Definition                                                                                           |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `incident_id` | Yes      | Incident to act on, from list_attack_incidents. `{"type":"string"}`                                  |
| `timeout`     | No       | How long, e.g. '1h', '1d00:00:00'. Empty string means permanent (needs confirm). `{"type":"string"}` |
| `confirm`     | Yes      | Actually apply it. Default false = dry run. `{"default":false,"type":"boolean"}`                     |

## unblock_attacker

**Unblock an Address** · Risk: **destructive**

Removes an address from the attack block list on every device it was applied to, and marks the response as revoked so the history still explains what happened and why it was undone. Use when a block turns out to have caught something legitimate.

| Parameter | Required | Definition                                                                                                  |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `address` | Yes      | The blocked address. `{"type":"string"}`                                                                    |
| `devices` | No       | Devices to clear (default: the ones the block was applied to). `{"type":"array","items":{"type":"string"}}` |

## list_attack_responses

**List Attack Responses** · Risk: **read**

Every block this server has applied: what, why, from which incident, on which devices, and when it expires. An entry in a device's address list that nobody can explain is worse than no entry at all, so this is the record that makes automatic blocking reversible.

| Parameter     | Required | Definition                                                           |
| ------------- | -------- | -------------------------------------------------------------------- |
| `active_only` | Yes      | Only blocks still in force. `{"default":true,"type":"boolean"}`      |
| `limit`       | Yes      | `{"default":50,"type":"integer","exclusiveMinimum":0,"maximum":500}` |

## configure_attack_response

**Show Attack Response Policy** · Risk: **read**

Shows the current detection and response policy: the mode, thresholds, which detectors may respond automatically, the per-hour cap, and the never-block list including the entries derived from your own deployment. Also checks a specific address against the never-block rules, which is the fastest way to answer 'why did it refuse to block that?'. The policy itself lives in the `attacks` config block — edit it there or in the dashboard, so a change survives a restart.

| Parameter       | Required | Definition                                                              |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `check_address` | No       | Ask whether this address would be refused, and why. `{"type":"string"}` |
