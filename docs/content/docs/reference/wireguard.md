---
title: "WireGuard"
description: "WireGuard interfaces, peers and client-config generation."
---

## Tools

- [Create WireGuard Interface](#create_wireguard_interface)
- [List WireGuard Interfaces](#list_wireguard_interfaces)
- [Get WireGuard Interface Details](#get_wireguard_interface)
- [Get WireGuard Status (Interfaces + Peers)](#get_wireguard_status)
- [Update WireGuard Interface](#update_wireguard_interface)
- [Remove WireGuard Interface](#remove_wireguard_interface)
- [Enable WireGuard Interface](#enable_wireguard_interface)
- [Disable WireGuard Interface](#disable_wireguard_interface)
- [Add WireGuard Peer](#add_wireguard_peer)
- [List WireGuard Peers](#list_wireguard_peers)
- [Get WireGuard Peer Details](#get_wireguard_peer)
- [Update WireGuard Peer](#update_wireguard_peer)
- [Remove WireGuard Peer](#remove_wireguard_peer)
- [Enable WireGuard Peer](#enable_wireguard_peer)
- [Disable WireGuard Peer](#disable_wireguard_peer)
- [Generate WireGuard Client Config File](#generate_wireguard_client_config)

## create_wireguard_interface

**Create WireGuard Interface** · Risk: **write**

Creates a WireGuard tunnel interface (`/interface wireguard`) — the local VPN endpoint with a UDP listen port and private key. Use this to establish the server-side or site-to-site WireGuard interface before adding remote peers with add_wireguard_peer. For IPsec tunnels use create_ipsec_peer; for L2TP use create_l2tp_client; for OpenVPN use create_ovpn_client. Returns the created interface's detail including its name and RouterOS-generated public key.

| Parameter     | Required | Definition                                                                                                        |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`        | Yes      | WireGuard interface name to create, e.g. 'wireguard-internal' (no spaces). `{"type":"string","pattern":"^\\S+$"}` |
| `listen_port` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                       |
| `private_key` | No       | `{"type":"string"}`                                                                                               |
| `mtu`         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                       |
| `comment`     | No       | `{"type":"string"}`                                                                                               |
| `disabled`    | Yes      | `{"default":false,"type":"boolean"}`                                                                              |

## list_wireguard_interfaces

**List WireGuard Interfaces** · Risk: **read**

`list_wireguard_interfaces` — READ / list / show / inspect all WireGuard tunnel interfaces (`/interface wireguard print`). The go-to tool to read the current WireGuard state on a device. Returns each interface's name, listen-port, public-key, MTU, and running/disabled status. Filter by name substring (name_filter), disabled-only, or running-only. For one interface's full detail use get_wireguard_interface; for the peer table use list_wireguard_peers; for interfaces AND peers in one call use get_wireguard_status.

| Parameter       | Required | Definition                           |
| --------------- | -------- | ------------------------------------ |
| `name_filter`   | No       | `{"type":"string"}`                  |
| `disabled_only` | Yes      | `{"default":false,"type":"boolean"}` |
| `running_only`  | Yes      | `{"default":false,"type":"boolean"}` |

## get_wireguard_interface

**Get WireGuard Interface Details** · Risk: **read**

`get_wireguard_interface` — READ / get / show the full detail of ONE WireGuard tunnel interface (`/interface wireguard print detail`) looked up by name. Returns listen-port, private-key, public-key, MTU, running state, and comment. To list all interfaces use list_wireguard_interfaces; for that interface's peers use list_wireguard_peers; for interfaces AND peers in one call use get_wireguard_status.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## get_wireguard_status

**Get WireGuard Status (Interfaces + Peers)** · Risk: **read**

`get_wireguard_status` — READ the current WireGuard state on a device in ONE call: ALL tunnel interfaces AND ALL peers together. Use this FIRST to inspect / show / check WireGuard before changing anything (e.g. to read public keys, see which side initiates, or confirm the tunnel is up). Interfaces report name, listen-port, public-key, MTU and running state; peers report .id, interface, public-key, allowed-address, endpoint/current-endpoint, last-handshake time and rx/tx bytes. Combines list_wireguard_interfaces + list_wireguard_peers; optionally filter both to one interface with interface_filter.

| Parameter          | Required | Definition                                                      |
| ------------------ | -------- | --------------------------------------------------------------- |
| `interface_filter` | No       | Limit to one interface name, e.g. 'wg-mesh' `{"type":"string"}` |

## update_wireguard_interface

**Update WireGuard Interface** · Risk: **write-idempotent**

Modifies settings on an existing WireGuard tunnel interface (`/interface wireguard set [find name=]`) — rename (new_name), change listen-port, rotate private-key, adjust MTU, or toggle disabled state. Only supplied fields are changed; omitted fields are left as-is. For updating remote peers use update_wireguard_peer. Returns the updated interface's detail.

| Parameter     | Required | Definition                                                                       |
| ------------- | -------- | -------------------------------------------------------------------------------- |
| `name`        | Yes      | `{"type":"string"}`                                                              |
| `new_name`    | No       | Rename the interface to this (no spaces). `{"type":"string","pattern":"^\\S+$"}` |
| `listen_port` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`      |
| `private_key` | No       | `{"type":"string"}`                                                              |
| `mtu`         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`      |
| `comment`     | No       | `{"type":"string"}`                                                              |
| `disabled`    | No       | `{"type":"boolean"}`                                                             |

## remove_wireguard_interface

**Remove WireGuard Interface** · Risk: **destructive**

Permanently deletes a WireGuard tunnel interface (`/interface wireguard remove`) by name, together with every peer bound to it. Verifies existence first with count-only. For removing only a specific peer without touching the interface use remove_wireguard_peer. Reports how many peers were removed alongside the interface.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## enable_wireguard_interface

**Enable WireGuard Interface** · Risk: **write-idempotent**

Enables a disabled WireGuard tunnel interface (`/interface wireguard enable`) by name, allowing it to accept and establish tunnel connections. For enabling a specific peer without affecting the interface use enable_wireguard_peer. To undo, use disable_wireguard_interface.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## disable_wireguard_interface

**Disable WireGuard Interface** · Risk: **write-idempotent**

Disables a WireGuard tunnel interface (`/interface wireguard disable`) by name, stopping all tunnel traffic through it without removing the interface or its peers. For disabling only a specific peer use disable_wireguard_peer. To re-enable use enable_wireguard_interface.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## add_wireguard_peer

**Add WireGuard Peer** · Risk: **write**

Adds a remote peer entry (`/interface wireguard peers add`) to an existing WireGuard interface — associates a public key with allowed source/destination CIDRs and an optional remote endpoint. Use this for each client or remote site connecting to a WireGuard interface created with create_wireguard_interface. For IPsec peers use create_ipsec_peer. Returns the created peer's detail including its .id.

Notes:
allowed_address: CIDR, comma-separated for multiple e.g. "10.0.0.2/32" or "10.0.0.0/24,192.168.0.0/24"
endpoint_address: remote host IP or hostname e.g. "203.0.113.1" (omit for road-warrior clients that dial in)
persistent_keepalive: seconds as string e.g. "25"

| Parameter              | Required | Definition                                                                                                                       |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `interface`            | Yes      | `{"type":"string"}`                                                                                                              |
| `public_key`           | Yes      | `{"type":"string"}`                                                                                                              |
| `allowed_address`      | Yes      | CIDR, comma-separated for multiple e.g. "10.0.0.2/32" or "10.0.0.0/24,192.168.0.0/24" `{"type":"string"}`                        |
| `endpoint_address`     | No       | remote host IP or hostname e.g. "203.0.113.1" `{"type":"string"}`                                                                |
| `endpoint_port`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                      |
| `preshared_key`        | No       | `{"type":"string"}`                                                                                                              |
| `persistent_keepalive` | No       | seconds as string e.g. "25" `{"type":"string"}`                                                                                  |
| `name`                 | No       | optional peer name label `{"type":"string"}`                                                                                     |
| `private_key`          | No       | peer's private key (lets the router generate this peer's client config) `{"type":"string"}`                                      |
| `responder`            | No       | only respond to handshakes, never initiate (for road-warrior clients) `{"type":"boolean"}`                                       |
| `client_address`       | No       | client tunnel address(es) for the generated client config `{"type":"string"}`                                                    |
| `client_dns`           | No       | DNS server(s) written into the generated client config `{"type":"string"}`                                                       |
| `client_endpoint`      | No       | server endpoint host[:port] written into the generated client config `{"type":"string"}`                                         |
| `client_keepalive`     | No       | client persistent-keepalive for the generated config e.g. "25s" `{"type":"string"}`                                              |
| `client_listen_port`   | No       | listen-port written into the generated client config `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `client_mtu`           | No       | RouterOS 7.25+ MTU in generated client configuration `{"type":"integer","minimum":576,"maximum":65535}`                          |
| `comment`              | No       | `{"type":"string"}`                                                                                                              |
| `disabled`             | Yes      | `{"default":false,"type":"boolean"}`                                                                                             |

## list_wireguard_peers

**List WireGuard Peers** · Risk: **read**

`list_wireguard_peers` — READ / list / show / inspect all WireGuard peers (`/interface wireguard peers print`). Use this to read which peers are configured and whether the tunnel is up (handshake). Returns each peer's .id, interface, public-key, allowed-address, endpoint/current-endpoint, last-handshake time, and rx/tx byte counters. Filter by interface name (interface_filter) or disabled-only. For the interface table use list_wireguard_interfaces; for one peer's full detail use get_wireguard_peer; for interfaces AND peers in one call use get_wireguard_status. Use the .id from this output with update_wireguard_peer, remove_wireguard_peer, enable_wireguard_peer, or disable_wireguard_peer.

| Parameter          | Required | Definition                           |
| ------------------ | -------- | ------------------------------------ |
| `interface_filter` | No       | `{"type":"string"}`                  |
| `disabled_only`    | Yes      | `{"default":false,"type":"boolean"}` |

## get_wireguard_peer

**Get WireGuard Peer Details** · Risk: **read**

`get_wireguard_peer` — READ / get / show the full detail of ONE WireGuard peer (`/interface wireguard peers print detail`) by its .id. Returns public-key, allowed-address, endpoint/current-endpoint, preshared-key presence, last-handshake time, and rx/tx bytes. To list all peers use list_wireguard_peers; for interfaces AND peers in one call use get_wireguard_status.

Notes:
peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"

| Parameter | Required | Definition                                                 |
| --------- | -------- | ---------------------------------------------------------- |
| `peer_id` | Yes      | "*N" or "N" from list output e.g. "*2" `{"type":"string"}` |

## update_wireguard_peer

**Update WireGuard Peer** · Risk: **write-idempotent**

Modifies an existing WireGuard peer (`/interface wireguard peers set`) by its .id — change allowed addresses, endpoint address/port, preshared key, keepalive interval, or disabled state. Only supplied fields are changed; omitted fields are left as-is. For updating the parent interface use update_wireguard_interface. Returns the updated peer's detail.

Notes:
peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"
allowed_address: CIDR, comma-separated e.g. "10.0.0.2/32" or "10.0.0.0/24,192.168.0.0/24"
persistent_keepalive: seconds as string e.g. "25"
Pass "" for endpoint_address or preshared_key to clear them.

| Parameter              | Required | Definition                                                                                                                                                                        |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peer_id`              | Yes      | "*N" or "N" from list output e.g. "*2" `{"type":"string"}`                                                                                                                        |
| `public_key`           | No       | The peer's base64 public key — re-key a peer in place instead of removing and re-adding it (which would lose the rest of its configuration). `{"type":"string"}`                  |
| `allowed_address`      | No       | `{"type":"string"}`                                                                                                                                                               |
| `endpoint_address`     | No       | `{"type":"string"}`                                                                                                                                                               |
| `endpoint_port`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                                                                       |
| `preshared_key`        | No       | `{"type":"string"}`                                                                                                                                                               |
| `persistent_keepalive` | No       | `{"type":"string"}`                                                                                                                                                               |
| `name`                 | No       | optional peer name label `{"type":"string"}`                                                                                                                                      |
| `private_key`          | No       | peer's private key (lets the router generate this peer's client config) `{"type":"string"}`                                                                                       |
| `responder`            | No       | only respond to handshakes, never initiate `{"type":"boolean"}`                                                                                                                   |
| `client_address`       | No       | client tunnel address(es) for the generated client config `{"type":"string"}`                                                                                                     |
| `client_dns`           | No       | DNS server(s) written into the generated client config `{"type":"string"}`                                                                                                        |
| `client_endpoint`      | No       | server endpoint host[:port] written into the generated client config `{"type":"string"}`                                                                                          |
| `client_keepalive`     | No       | client persistent-keepalive for the generated config e.g. "25s" `{"type":"string"}`                                                                                               |
| `client_listen_port`   | No       | Client listen port; empty string unsets it on RouterOS 7.25+ `{"anyOf":[{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},{"type":"string","const":""}]}` |
| `client_mtu`           | No       | RouterOS 7.25+ MTU in generated client configuration `{"type":"integer","minimum":576,"maximum":65535}`                                                                           |
| `comment`              | No       | `{"type":"string"}`                                                                                                                                                               |
| `disabled`             | No       | `{"type":"boolean"}`                                                                                                                                                              |

## remove_wireguard_peer

**Remove WireGuard Peer** · Risk: **destructive**

Permanently removes a single WireGuard peer entry (`/interface wireguard peers remove`) by its .id. Verifies existence first with count-only. Leaves the parent WireGuard interface untouched. To remove the entire interface and all its peers use remove_wireguard_interface.

Notes:
peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"

| Parameter | Required | Definition                                                 |
| --------- | -------- | ---------------------------------------------------------- |
| `peer_id` | Yes      | "*N" or "N" from list output e.g. "*2" `{"type":"string"}` |

## enable_wireguard_peer

**Enable WireGuard Peer** · Risk: **write-idempotent**

Enables a disabled WireGuard peer (`/interface wireguard peers enable`) by its .id, allowing traffic through that peer's tunnel without affecting the parent interface. For enabling the parent interface use enable_wireguard_interface. To undo, use disable_wireguard_peer.

Notes:
peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"

| Parameter | Required | Definition                                                 |
| --------- | -------- | ---------------------------------------------------------- |
| `peer_id` | Yes      | "*N" or "N" from list output e.g. "*2" `{"type":"string"}` |

## disable_wireguard_peer

**Disable WireGuard Peer** · Risk: **write-idempotent**

Disables a WireGuard peer (`/interface wireguard peers disable`) by its .id, blocking tunnel traffic for that peer without removing it or affecting the parent interface. For disabling the parent interface use disable_wireguard_interface. To re-enable use enable_wireguard_peer.

Notes:
peer_id: the .id from list_wireguard_peers, format "*N" or "N" e.g. "*2"

| Parameter | Required | Definition                                                 |
| --------- | -------- | ---------------------------------------------------------- |
| `peer_id` | Yes      | "*N" or "N" from list output e.g. "*2" `{"type":"string"}` |

## generate_wireguard_client_config

**Generate WireGuard Client Config File** · Risk: **read**

Generates a standard wg0.conf client configuration file (`[Interface] + [Peer]` sections) entirely from the provided keys and server endpoint — runs locally, never contacts the router. Use this after registering a client's public key with add_wireguard_peer to produce the config text to distribute to that client. Returns the config text ready to save as /etc/wireguard/wg0.conf (Linux) or import into the WireGuard app, with instructions for generating client keys and bringing the tunnel up.

Notes:
allowed_ips: CIDRs routed through the tunnel by the client, default "0.0.0.0/0" (all IPv4 traffic; add ::/0 to also route IPv6)
persistent_keepalive: seconds integer, default 25

| Parameter              | Required | Definition                                                                                  |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `client_private_key`   | Yes      | `{"type":"string"}`                                                                         |
| `client_address`       | Yes      | `{"type":"string"}`                                                                         |
| `server_public_key`    | Yes      | `{"type":"string"}`                                                                         |
| `server_endpoint`      | Yes      | `{"type":"string"}`                                                                         |
| `server_port`          | Yes      | `{"default":51820,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `allowed_ips`          | Yes      | `{"default":"0.0.0.0/0","type":"string"}`                                                   |
| `dns`                  | No       | `{"type":"string"}`                                                                         |
| `persistent_keepalive` | Yes      | `{"default":25,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`    |
