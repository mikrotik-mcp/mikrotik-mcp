---
title: "Config Narrative"
description: "Turns a router's configuration into a plain-language architecture document — role, VLANs, internet path, what each firewall chain does, what is exposed, tunnels — with a Mermaid topology diagram, and explains the CONSEQUENCES of the difference between two snapshots."
---

## Tools

- [Explain a Device](#explain_device)
- [Explain One Area in Depth](#explain_section)
- [Explain What Changed](#diff_explanations)

## explain_device

**Explain a Device** · Risk: **read**

Writes a plain-language architecture document for a router: what it is FOR (inferred from the configuration, with the signals shown), what VLANs and subnets exist, how it reaches the internet, what each firewall chain actually does, WHAT IS EXPOSED TO THE INTERNET, every tunnel, and which management services are reachable — plus a Mermaid topology diagram. Reads the live device (`/export`, a read-only print that writes nothing), or a stored snapshot with `snapshot_id`, or raw text with `config_text`. Prefer this over dumping `/export` into the conversation: it is a fraction of the size, already analysed, and identical across runs so two dates can be compared. Anything the analyser does not recognise is listed rather than silently omitted.

| Parameter     | Required | Definition                                                               |
| ------------- | -------- | ------------------------------------------------------------------------ |
| `snapshot_id` | No       | Explain a stored snapshot instead of the live device `{"type":"string"}` |
| `config_text` | No       | Explain this raw `/export` text instead `{"type":"string"}`              |
| `diagram`     | Yes      | Include the Mermaid topology diagram `{"default":true,"type":"boolean"}` |

## explain_section

**Explain One Area in Depth** · Risk: **read**

The same analysis as explain_device, narrowed to one area: `firewall`, `addressing`, `topology`, `internet`, `exposure`, `vpn`, `services`, `identity`, or `unknowns`. Use it when the question is about one part of the router and the whole document would be noise — 'what does the forward chain actually do', 'what is exposed', 'which VLANs exist'. Reads the live device by default; pass `snapshot_id` or `config_text` to analyse a stored or supplied configuration.

| Parameter     | Required | Definition                                                                                                                                         |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section`     | Yes      | Which area to explain `{"type":"string","enum":["identity","exposure","topology","addressing","internet","firewall","vpn","services","unknowns"]}` |
| `snapshot_id` | No       | Explain a stored snapshot instead of the live device `{"type":"string"}`                                                                           |
| `config_text` | No       | Explain this raw `/export` text instead `{"type":"string"}`                                                                                        |

## diff_explanations

**Explain What Changed** · Risk: **read**

Compares two configurations and reports the CONSEQUENCES of the difference in plain language — 'the forward chain no longer ends in a drop, so anything not matched is now allowed', 'VLAN 40 was added and can reach the internet through the existing NAT rule'. This is the question a reviewer actually has; diff_config_snapshots answers the different question of which LINES changed, and a moved rule looks unremarkable there. Pass two snapshot ids, or two raw exports, or one of each. Leaving the AFTER side out compares a snapshot against the device as it is right now, which is the usual way to ask 'what has changed since we documented this'. Changes are ordered most consequential first, and security changes are called out as such.

| Parameter            | Required | Definition                                     |
| -------------------- | -------- | ---------------------------------------------- |
| `before_snapshot_id` | No       | The earlier snapshot `{"type":"string"}`       |
| `after_snapshot_id`  | No       | The later snapshot `{"type":"string"}`         |
| `before_text`        | No       | The earlier `/export` text `{"type":"string"}` |
| `after_text`         | No       | The later `/export` text `{"type":"string"}`   |
