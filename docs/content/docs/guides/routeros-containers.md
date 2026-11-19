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

## Logs, image upgrades and deploying from one description

### Reading logs

`get_container_logs` reads what containers wrote to the RouterOS log. A
container logs only when it has `logging=yes`. RouterOS does not tag a line
with the container's name, so with several logging containers the lines are
mixed; use `contains` to filter.

### Upgrading an image

`upgrade_container_image` pulls the newest image and keeps the container's
settings.

| Survives the upgrade                 | Is lost                                             |
| ------------------------------------ | --------------------------------------------------- |
| Everything in the container's mounts | Files written inside the container's root directory |
| The env list and all settings        |                                                     |

A container with no mount is refused unless you pass `accept_data_loss=true`.
The container must be stopped (`stop=true` stops it first). The pull runs in
the background: wait until `get_container` shows `stopped`, then start it.

### Deploying from one description

`deploy_container_stack` creates containers the way a compose file does:

```json
{
  "services": [
    {
      "name": "pihole",
      "image": "pihole/pihole:latest",
      "veth": {
        "name": "veth-pihole",
        "address": "172.20.0.2/24",
        "gateway": "172.20.0.1",
        "bridge": "containers"
      },
      "env": { "TZ": "Europe/Berlin" },
      "mounts": [{ "name": "pihole-etc", "src": "/usb1/pihole/etc", "dst": "/etc/pihole" }],
      "root_dir": "usb1/pihole/root"
    }
  ]
}
```

For each service it creates the veth interface, the env list, the mounts and
the container, in that order. Before it writes anything, **every command is
parsed on the router**. RouterOS renamed container settings between releases
(`envlist` to `envlists`, `mounts` to `mountlists`), and the tool uses the names
that router knows. If a command is not valid there, nothing is written.

Limits to know:

- It does not start the containers. The image is pulled in the background.
- It adds no firewall or NAT rule, and no address on the bridge. See
  `get_routeros_container_guide` for the network side.
- A container that already exists is skipped, so the same call can be run again
  after a failure. Items of a failed service that were already created (veth,
  envs, mounts) must be removed by hand first.
- Env values are hidden in the tool's answer, but they are stored in plain text
  on the router, as every container env is.
