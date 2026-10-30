---
title: "Port-Scan Detection"
description: "Detect (never block) six port-scan signatures (psd, Nmap FIN/NULL/Xmas, SYN/FIN, SYN/RST) by tagging the source into an address list, inside a trust-excluding `detect-portscan` jump-gate — with a mandatory explicit signature selection, pre-flight trust-list validation, snapshot and Safe-Mode apply (`list_port_scan_detection_signatures`, `add_port_scan_detection_rules`)."
---

## Tools

- [List Port-Scan Detection Signatures](#list_port_scan_detection_signatures)
- [Add Port-Scan Detection Rules](#add_port_scan_detection_rules)

## list_port_scan_detection_signatures

**List Port-Scan Detection Signatures** · Risk: **read**

Read-only catalog of the six port-scan detection signatures this fleet can install (psd_generic, nmap_fin_stealth, syn_fin_scan, syn_rst_scan, fin_psh_urg_scan, nmap_null_scan) — each with its id, display name, one-line description and exact RouterOS match syntax. CALL THIS FIRST and show the user all six signatures with their descriptions. Do NOT proceed to add_port_scan_detection_rules until the user has explicitly named which specific signature IDs they want — never infer, never default to all six, never default to none. When `device` is supplied, also reports per signature whether it is already present in that device's detect-portscan chain. (On a multi-device server, target the device with the `device` selector this tool exposes.)

No tool-specific parameters.

## add_port_scan_detection_rules

**Add Port-Scan Detection Rules** · Risk: **dangerous**

Installs the user-selected port-scan detection signatures into a dedicated `detect-portscan` sub-chain, gated by a single input jump that EXCLUDES a trusted address-list (so trusted sources are never tagged). These rules only add the source to an address list — they NEVER drop or block. NEVER call this with a guessed or default set of rule_types: it must only be called with signature IDs the user explicitly chose after seeing list_port_scan_detection_signatures — there is no select-all. Requires `trusted_list_name` (must already exist and be non-empty on the device) and the human acknowledgement `confirmed_trusted_list_includes_my_ip=true`. Captures a config snapshot, then applies every write inside Safe Mode (auto-revert on session drop) — or, if Safe Mode is unavailable or goes silent on the device (a known flaky case on some RouterOS SSH builds), applies the writes DIRECTLY instead of aborting, since these rules only tag and cannot lock you out (the snapshot is the rollback point). Idempotent — a second identical run adds nothing. Enforcement/blocking of the tagged list is intentionally out of scope.

| Parameter                               | Required | Definition                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rule_types`                            | Yes      | REQUIRED, non-empty. The specific signature IDs the user explicitly chose after seeing the catalog. No default, no select-all — unknown values are rejected. `{"minItems":1,"type":"array","items":{"type":"string","enum":["psd_generic","nmap_fin_stealth","syn_fin_scan","syn_rst_scan","fin_psh_urg_scan","nmap_null_scan"]}}` |
| `trusted_list_name`                     | Yes      | REQUIRED. The management/trusted address-list on THIS device (no default). Must already exist and contain at least one entry, or the call is refused. `{"type":"string","minLength":1}`                                                                                                                                            |
| `address_list_name`                     | Yes      | Address list detected scanners are tagged into (default "port scanners"). `{"default":"port scanners","type":"string"}`                                                                                                                                                                                                            |
| `address_list_timeout`                  | Yes      | How long a detected source stays tagged (default "2w"). `{"default":"2w","type":"string"}`                                                                                                                                                                                                                                         |
| `confirm`                               | Yes      | Must be true to write. `{"type":"boolean","const":true}`                                                                                                                                                                                                                                                                           |
| `confirmed_trusted_list_includes_my_ip` | Yes      | Human acknowledgement that the address you currently manage this device from is present in trusted_list_name. The tool cannot infer this — it must be explicitly true. `{"type":"boolean","const":true}`                                                                                                                           |
