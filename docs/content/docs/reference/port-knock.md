---
title: "Port Knock"
description: "Hide management services behind a secret port-knock sequence (staged address-list ladder), with preview-before-apply."
---

## Tools

- [Set Up Port-Knock Guardian](#setup_port_knock)

## setup_port_knock

**Set Up Port-Knock Guardian** · Risk: **dangerous**

Hides management services behind a secret port-knock `sequence`: a source must connect to the knock ports in order to be added to an allow-list, after which the `protect_ports` (SSH/Winbox/API, default 22,8291,8728) accept it — everyone else is dropped, so the ports are invisible to scanners. Generates the staged address-list ladder + accept/drop rules. DEFAULTS TO A DRY RUN (`apply=false`); set `apply=true` to install. WARNING: after applying, management is only reachable by knocking the exact sequence — make sure you can knock (and keep a console/trusted path). Rules are tagged 'port-knock:'. Returns the plan or a build report.

| Parameter       | Required | Definition                                                                                                                                   |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sequence`      | Yes      | Secret knock ports, in order, e.g. [7001, 8002, 9003] `{"minItems":2,"type":"array","items":{"type":"integer","minimum":1,"maximum":65535}}` |
| `protect_ports` | Yes      | Management ports to hide `{"default":"22,8291,8728","type":"string"}`                                                                        |
| `open_timeout`  | Yes      | How long access stays open after the knock `{"default":"1h","type":"string"}`                                                                |
| `stage_timeout` | Yes      | Allowed window between consecutive knocks `{"default":"10s","type":"string"}`                                                                |
| `apply`         | Yes      | false = preview (default); true = install `{"default":false,"type":"boolean"}`                                                               |
