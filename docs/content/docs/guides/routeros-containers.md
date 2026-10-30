---
title: "RouterOS container operations"
description: "Version-aware readiness, deployment and lifecycle boundaries."
---

`get_routeros_container_guide` provides shared, version-aware guidance adapted from
the `routeros-container` skill. Topics: `all`, `prerequisites`, `images`, `networking`,
`lifecycle`, `security`, `troubleshooting`. It performs no router I/O and needs no
container package. The equivalent Markdown resource
`mikrotik://knowledge/routeros-container` remains available in read-only/curated
sessions even when the `container` tool module is disabled.

- `audit-routeros-containers`: read-only readiness, storage and isolation audit.
- `setup-routeros-container`: approval-first deployment and application verification.
- `setup-v2ray-container-proxy`: the same safety baseline for proxy/TUN gateways.

These prompts include the same guide in MCP, Dashboard and Raycast. Instructions
cover physical device-mode confirmation, separately approved package/reboot work,
architecture variants, storage/volume backup, VETH/IPv4/IPv6 isolation, shared-list
dependencies, bounded lifecycle polling and Device/Group/Shared Memory boundaries.
They never authorize automatic router changes.

Container tools reject ambiguous targets and unsafe image-source combinations.
Use exactly one `id` (stable `.id`), unique `name`, or exact `tag` for lifecycle
operations. Start/remove and runtime-setting changes require confirmed stopped
state. Writes are read back; timeouts remain unknown and are never blindly retried.
`add_container` requires a name, VETH and root path in addition to one image source.
Current mount creation uses `list`; `name` remains an explicit legacy alternative.
Likewise `envlist`/`mounts` are legacy alternatives to `envlists`/`mountlists`;
inspect the target schema before selecting syntax. `memory_high` (and its deprecated
`ram_high` input alias) sends the actual RouterOS `memory-high` property.

Environment listing retrieves metadata without values. Container command logs omit
arguments; default activity-history redaction masks env/value/command fields, and
container detail masks sensitive properties. Application log text may still contain
secrets: collect only bounded, reviewed logs. These safeguards are not retroactive
cleanup of older logs and do not make arbitrary raw-command output secret-safe.
