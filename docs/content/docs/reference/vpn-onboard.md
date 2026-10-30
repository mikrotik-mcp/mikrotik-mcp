---
title: "VPN Onboarding"
description: "Onboard a WireGuard remote user in one step: generate the client keypair, add the peer, and return a ready-to-import client config; plus a revoke action."
---

## Tools

- [Onboard WireGuard Remote User](#onboard_wireguard_user)
- [Revoke WireGuard Remote User](#revoke_wireguard_user)

## onboard_wireguard_user

**Onboard WireGuard Remote User** · Risk: **write**

Generates a ready-to-use WireGuard remote-access profile for one user: creates a client keypair, adds the peer to the server `interface` (allowed-address = the client's tunnel IP), reads the server's public key, and returns a complete client .conf to paste into the WireGuard app or a QR generator. The peer is tagged `vpn-user: <user>` so revoke_wireguard_user can remove it. NOTE: the returned config contains the client PRIVATE key (required to connect) — handle it securely. `endpoint` is the server's public host:port; `allowed_ips` controls split vs full tunnel. SSH devices only. Returns the client config.

| Parameter     | Required | Definition                                                                                                             |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `interface`   | Yes      | Existing WireGuard SERVER interface, e.g. 'wg-server' `{"type":"string"}`                                              |
| `user`        | Yes      | User/device label, e.g. 'alice-laptop' `{"type":"string"}`                                                             |
| `address`     | Yes      | Tunnel IP to assign the client, e.g. '10.20.0.50' `{"type":"string"}`                                                  |
| `endpoint`    | Yes      | Server public endpoint host:port, e.g. 'vpn.example.com:13231' `{"type":"string"}`                                     |
| `dns`         | No       | DNS for the client, e.g. '10.20.0.1' `{"type":"string"}`                                                               |
| `allowed_ips` | Yes      | Client AllowedIPs: '0.0.0.0/0' full-tunnel, or a LAN subnet for split-tunnel `{"default":"0.0.0.0/0","type":"string"}` |
| `keepalive`   | Yes      | PersistentKeepalive seconds `{"default":"25","type":"string"}`                                                         |

## revoke_wireguard_user

**Revoke WireGuard Remote User** · Risk: **destructive**

Revokes a remote-access user created by onboard_wireguard_user: removes the WireGuard peer tagged `vpn-user: <user>` from the server, immediately cutting their access. Returns whether a peer was removed.

| Parameter | Required | Definition                                            |
| --------- | -------- | ----------------------------------------------------- |
| `user`    | Yes      | The user label used at onboarding `{"type":"string"}` |
