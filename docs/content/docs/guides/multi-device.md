---
title: "Multiple Devices"
description: "Practical setup, operations and limits for Multiple Devices."
---

One server instance can manage **several named MikroTik routers**, and the AI
chooses which one each tool call runs on. This is what makes cross-device work —
like building a tunnel between two routers and testing it from both ends —
possible in a single conversation.

## Defining devices

Single-device setups need nothing new: the `MIKROTIK_*` variables define a device
named `default` (see [configuration](/docs/guides/configuration)).

For multiple devices, provide a `devices` map via **either** a JSON config file
or an inline env var.

### A config file (`--config` / `MIKROTIK_CONFIG_FILE`)

```json
{
  "defaultDevice": "site-a",
  "devices": {
    "site-a": {
      "host": "203.0.113.10",
      "username": "admin",
      "keyFilename": "/keys/site-a",
      "description": "HQ edge router"
    },
    "site-b": {
      "host": "198.51.100.20",
      "username": "admin",
      "password": "••••••",
      "description": "Branch office"
    }
  }
}
```

```bash
mikrotik-mcp serve --config ./devices.json
# or
MIKROTIK_CONFIG_FILE=./devices.json mikrotik-mcp serve
```

### Inline (`MIKROTIK_DEVICES`)

```bash
MIKROTIK_DEVICES='{"defaultDevice":"site-a","devices":{"site-a":{"host":"203.0.113.10","keyFilename":"/keys/site-a"},"site-b":{"host":"198.51.100.20","password":"••••"}}}' \
  mikrotik-mcp serve
```

Each device accepts the same fields as the single-device config: `host`,
`username`, `password`, `port`, `keyFilename`, `privateKey`, `keyPassphrase`,
`timeoutMs`, plus an optional `description` — and the SSH jump-host fields
`jumpVia` / `jumpHost` (see below). A bare `{ "name": { … } }` map (no
`defaultDevice`) is also accepted — the first key becomes the default.

You can also combine: the legacy `MIKROTIK_*` vars contribute a `default` device
alongside the named ones from the file/env.

## SSH jump hosts (bastion / ProxyJump)

Reach a router that has **no exposed SSH port** by tunnelling through another one
the server can already reach — the classic bastion pattern, the same as OpenSSH's
`ProxyJump`. Nothing new is opened to the internet: only the bastion is
reachable, and the target rides an SSH channel forwarded from it.

Point a device at its bastion with **`jumpVia`** — the **name of another
configured device** — so the bastion's credentials are reused, not duplicated:

```jsonc
{
  "defaultDevice": "hex",
  "devices": {
    "hex": { "host": "192.168.88.1", "username": "admin", "password": "••••" },
    "home-ax3": {
      "host": "10.10.30.100", // only reachable from the hEX's LAN
      "port": 22,
      "username": "admin",
      "password": "••••",
      "jumpVia": "hex", // ← tunnel in through the hEX
    },
  },
}
```

Every tool then targets `home-ax3` normally (`{ "device": "home-ax3", … }`)
and the connection is transparently routed through the hEX — SSH commands, Safe
Mode, **and SFTP file upload** all work through the jump.

When the bastion isn't a configured device, use **`jumpHost`** with inline SSH
fields instead (`host`, `port`, `username`, `password`/`keyFilename`/`privateKey`,
`keyPassphrase`, `timeoutMs`):

```jsonc
"home-ax3": {
  "host": "10.10.30.100",
  "username": "admin",
  "password": "••••",
  "jumpHost": { "host": "203.0.113.9", "port": 22, "username": "ops", "keyFilename": "/keys/bastion" }
}
```

Chains are supported: a bastion may itself set `jumpVia`, so the server hops
A → B → target. A cycle (or a device jumping through itself) is rejected with a
clear error, and a **MAC-Telnet device can't be a bastion** (a jump needs SSH TCP
forwarding, which Layer-2 MAC-Telnet has no notion of).

> **RouterOS prerequisite.** The SSH server on the **bastion** must allow TCP
> forwarding, which RouterOS disables by default. Enable it on the jump router:
>
> ```
> /ip ssh set forwarding-enabled=local      # or "both"
> ```
>
> Without it the jump fails with _"jump host could not open a tunnel … enable SSH
> TCP forwarding"_. Only the bastion needs this; the target router does not.

For a **single device** (no `devices` map), an inline jump host is also available
via env/flags — `MIKROTIK_JUMP_HOST` / `--jump-host` (plus `…_JUMP_PORT`,
`…_JUMP_USERNAME`, `…_JUMP_PASSWORD`, `…_JUMP_KEY_FILENAME`).

## How the AI targets a device

When **more than one** device is configured, every tool automatically gains an
optional **`device`** parameter — a config key or friendly label, validated at
call time against the live configuration:

```jsonc
// tool: create_wireguard_interface
{ "device": "site-a", "name": "wg-to-b", "listen_port": 13231 }
```

Omit `device` to use the default. With a single device the parameter isn't added
at all, so single-device usage is unchanged.

The parameter is a free-form **string** (not a fixed enum) on purpose: devices can
be added at runtime — e.g. from the **Observability dashboard** — and take effect
**immediately, without restarting the server or refreshing tool schemas**. The
name is checked against the current config when the tool runs (an unknown name
returns a clear `Unknown device 'x'. Configured devices: …` error), so a freshly
added device is usable right away. Use `list_mikrotik_devices` for the authoritative
current set. (Caveat: if the server _started_ with a single device, tools have no
`device` parameter yet — adding a second device at runtime is picked up by
`list_mikrotik_devices`, but targeting it per-call requires a restart so the
selector is injected.)

The AI discovers the names with the **`list_mikrotik_devices`** tool (or you can
run `mikrotik-mcp devices`):

```
$ mikrotik-mcp devices
site-a (default)   admin@203.0.113.10:22 [auth: key] — HQ edge router
site-b             admin@198.51.100.20:22 [auth: password] — Branch office
```

## Safe Mode is per-device

Each router has its own [Safe Mode](/docs/guides/safe-mode) session. `enable_safe_mode`
with `device=site-a` opens a transactional window on **site-a only**; `site-b`
is unaffected and commits independently. This lets you stage risky firewall
changes on both ends of a tunnel and roll back one side without touching the other.

## Verifying connectivity

`mikrotik-mcp auth-check` probes **every** configured device and reports each:

```
[site-a] Connection OK.
 name: HQ-Edge
[site-b] Connection OK.
 name: Branch-RB5009

2 device(s) checked.
```

## Example: a tunnel between two routers

The guided prompt **`setup-tunnel-between-sites`** ([prompts](/docs/guides/prompts)) drives
the whole flow — inventory both ends, pick a technology, configure each side with
its `device`, open the firewall under per-device Safe Mode, and verify with `ping`
from both routers. See also the [VPN guide](/docs/guides/vpn-guide).
