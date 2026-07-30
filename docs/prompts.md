# Prompts

MCP **prompts** are reusable, parameterized workflows a user can invoke by name
(e.g. "harden this router"). Unlike tools — which the model calls — a prompt
produces a ready-to-run instruction message that the model then executes using
the tools. This server ships **9 prompts**.

## How prompts are authored

Each prompt is a Markdown file in [`prompts/`](../prompts/) with a small
frontmatter block. Authoring them as data rather than code means they can be
edited without recompiling:

```markdown
---
name: harden-router
title: Harden a RouterOS device
description: One-line summary shown in the prompt picker.
arguments:
  - name: wan_interface
    description: The WAN-facing interface.
    required: false
---

Body text. Reference arguments with {{wan_interface}}.
```

At startup the loader (`src/prompts/index.ts`) reads every `.md` file, parses the
frontmatter, builds a Zod argument schema (required vs. optional strings), and
registers the prompt. When a client invokes the prompt, the body is returned as a
single user message with each `{{placeholder}}` substituted by the supplied
argument (unfilled placeholders are left intact).

## How clients invoke prompts

An MCP client lists prompts via `prompts/list` and fetches a filled-in prompt via
`prompts/get`, passing argument values. In Claude Desktop and similar clients,
prompts appear in a picker (often the slash/attachment menu); selecting one
prompts you for its arguments, then drops the rendered instruction into the
conversation. The model carries it out with the server's tools.

## The built-in prompts

| Prompt                         | Purpose                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `harden-router`                | Audit and tighten a router's security posture.                                  |
| `diagnose-connectivity`        | Systematically troubleshoot an unreachable host/subnet/internet.                |
| `setup-guest-wifi`             | Create an isolated guest network with its own DHCP and isolation rules.         |
| `choose-vpn-solution`          | Recommend the right MikroTik VPN/tunnel for a use case, then outline the build. |
| `setup-wireguard-vpn`          | Stand up a WireGuard server and produce a client config.                        |
| `setup-ipsec-site-to-site`     | Build an interoperable IKEv2 site-to-site IPsec tunnel.                         |
| `setup-l2tp-ipsec-roadwarrior` | L2TP/IPsec remote access for built-in OS VPN clients.                           |
| `setup-tunnel-between-sites`   | Configure **both** routers of a site-to-site tunnel and verify it end to end.   |
| `backup-and-document`          | Create a restore point and a human-readable config inventory.                   |

See the **[VPN guide](./vpn-guide.md)** for how the VPN prompts and tools fit together.

### `harden-router`

Inspects management services, the firewall input chain, users, and DNS, then
proposes a prioritized hardening checklist — applying risky firewall edits under
[Safe Mode](./safe-mode.md).

| Argument        | Required | Description                                                                                |
| --------------- | :------: | ------------------------------------------------------------------------------------------ |
| `wan_interface` |    no    | The WAN-facing interface (e.g. `ether1`, `pppoe-out1`). If unknown, it's discovered first. |

### `diagnose-connectivity`

Troubleshoots bottom-up (link → addressing → routing → DNS → reachability →
firewall/NAT → logs) using read-only tools, and concludes with the most likely
root cause and the fix to approve.

| Argument           | Required | Description                                                                                         |
| ------------------ | :------: | --------------------------------------------------------------------------------------------------- |
| `target`           | **yes**  | What's unreachable — an IP, hostname, or subnet (e.g. `8.8.8.8`, `example.com`, `192.168.50.0/24`). |
| `source_interface` |    no    | The interface/segment the affected clients are on (e.g. `bridge`, `vlan50`).                        |

### `setup-guest-wifi`

Builds a segmented guest network: VLAN/interface, gateway IP, DHCP, masquerade,
and — the important part — isolation rules that allow internet but drop traffic
to the LAN and management. Applied under Safe Mode.

| Argument        | Required | Description                                                              |
| --------------- | :------: | ------------------------------------------------------------------------ |
| `subnet`        | **yes**  | Guest subnet in CIDR, e.g. `192.168.80.0/24`.                            |
| `vlan_id`       |    no    | VLAN ID for the guest segment, e.g. `80`. Optional for a flat interface. |
| `wan_interface` | **yes**  | The interface that reaches the internet (for the masquerade rule).       |

### `setup-wireguard-vpn`

Provisions a WireGuard server interface, tunnel address, firewall rules, and a
first peer, then emits a ready-to-import client config.

| Argument      | Required | Description                                                       |
| ------------- | :------: | ----------------------------------------------------------------- |
| `vpn_subnet`  | **yes**  | VPN tunnel subnet in CIDR, e.g. `10.10.0.0/24`.                   |
| `endpoint`    | **yes**  | Public hostname/IP clients connect to (WAN address or DDNS name). |
| `listen_port` |    no    | UDP port for WireGuard (default `13231`).                         |

### `choose-vpn-solution`

Acts as a VPN architect: weighs WireGuard / IPsec / L2TP-IPsec / SSTP / OpenVPN /
GRE-EoIP-VXLAN against your use case, recommends one, and outlines the build.

| Argument   | Required | Description                                                                       |
| ---------- | :------: | --------------------------------------------------------------------------------- |
| `use_case` | **yes**  | What you need (e.g. "connect two offices", "remote access for laptops & phones"). |
| `clients`  |    no    | What connects (e.g. "iOS/Android built-in clients", "a Fortinet device").         |

### `setup-ipsec-site-to-site`

Builds an IKEv2 site-to-site tunnel end to end (profile → proposal → peer →
identity → policy) and lists the matching parameters for the remote engineer.

| Argument        | Required | Description                              |
| --------------- | :------: | ---------------------------------------- |
| `local_subnet`  | **yes**  | Local network behind this router (CIDR). |
| `remote_subnet` | **yes**  | Remote network behind the peer (CIDR).   |
| `peer_address`  | **yes**  | Public IP/hostname of the remote peer.   |

### `setup-l2tp-ipsec-roadwarrior`

Configures L2TP-over-IPsec remote access for built-in OS VPN clients: IP pool,
PPP profile, per-user secrets, the server, firewall, and a client setup card.

| Argument        | Required | Description                                                                |
| --------------- | :------: | -------------------------------------------------------------------------- |
| `vpn_pool`      | **yes**  | Address range handed to VPN clients (e.g. `192.168.89.10-192.168.89.254`). |
| `local_gateway` | **yes**  | Router's VPN/LAN-side address used as gateway/DNS.                         |

### `setup-tunnel-between-sites`

Drives **two** routers from one conversation: inventories both ends, picks a
tunnel technology, configures each side with its `device` argument, opens the
firewall under per-device Safe Mode, and verifies with `ping` from both. Requires
[multiple devices](./multi-device.md) to be configured.

| Argument     | Required | Description                                             |
| ------------ | :------: | ------------------------------------------------------- |
| `device_a`   | **yes**  | Name of the first configured device (e.g. `site-a`).    |
| `device_b`   | **yes**  | Name of the second configured device (e.g. `site-b`).   |
| `technology` |    no    | `wireguard` / `ipsec` / `gre` / `eoip`, or `recommend`. |

### `backup-and-document`

Read-mostly: creates a binary backup and a text export, then calls
`explain_device` for the architecture write-up and adds the live facts an export
cannot carry (uptime, which tunnels are actually up, expiring certificates).
Takes no arguments.

| Argument | Required | Description |
| -------- | :------: | ----------- |
| _(none)_ |    —     | —           |

## Adding your own

Drop a new `name.md` file into `prompts/` with valid frontmatter (at minimum a
`name`). It's picked up automatically on the next start — no code change needed.
Files with missing/invalid frontmatter are skipped with a logged warning.
