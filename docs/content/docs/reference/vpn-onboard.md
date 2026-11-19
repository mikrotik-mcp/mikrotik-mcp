---
title: "VPN Onboarding"
description: "Onboard a WireGuard remote user in one step: generate the client keypair, add the peer, and return a ready-to-import client config; plus a revoke action."
---

## Tools

- [Onboard WireGuard Remote User](#onboard_wireguard_user)
- [Revoke WireGuard Remote User](#revoke_wireguard_user)
- [List WireGuard Remote Users](#list_wireguard_users)
- [Disable or Remove Expired WireGuard Users](#expire_wireguard_users)

## onboard_wireguard_user

**Onboard WireGuard Remote User** · Risk: **write**

Generates a ready-to-use WireGuard remote-access profile for one user: creates a client keypair, adds the peer to the server `interface` (allowed-address = the client's tunnel IP), reads the server's public key, and returns a complete client .conf to paste into the WireGuard app or a QR generator. The peer is tagged `vpn-user: <user>` so revoke_wireguard_user can remove it. NOTE: the returned config contains the client PRIVATE key (required to connect) — handle it securely. `endpoint` is the server's public host:port; `allowed_ips` controls split vs full tunnel. Leave `address` out and the tool picks the lowest free address in the interface's own subnet, so two users never get the same one. `expires` (YYYY-MM-DD) records an end date on the peer; `expire_wireguard_users` then disables or removes peers past their date. `save=true` writes `<user>.conf` and a `<user>.png` QR code (scan it in the WireGuard phone app) to a private folder on the MCP host and returns the paths. `email_to` sends the profile by email through the alert email channel; the message carries the private key, so use it only for a mailbox you trust. SSH devices only. Returns the client config.

| Parameter     | Required | Definition                                                                                                                    |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `interface`   | Yes      | Existing WireGuard SERVER interface, e.g. 'wg-server' `{"type":"string"}`                                                     |
| `user`        | Yes      | User/device label, e.g. 'alice-laptop' `{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._@-]{0,62}$"}`                     |
| `address`     | No       | Tunnel IP for the client, e.g. '10.20.0.50'. Omit to take the lowest free one. `{"type":"string"}`                            |
| `expires`     | No       | Last day the user may connect, e.g. '2026-12-31' `{"type":"string"}`                                                          |
| `save`        | Yes      | Write <user>.conf and a <user>.png QR code on the MCP host `{"default":false,"type":"boolean"}`                               |
| `email_to`    | No       | Email the profile to this address (needs the alert email channel) `{"type":"string","pattern":"^[^\\s<>@,;]+@[^\\s<>@,;]+$"}` |
| `endpoint`    | Yes      | Server public endpoint host:port, e.g. 'vpn.example.com:13231' `{"type":"string"}`                                            |
| `dns`         | No       | DNS for the client, e.g. '10.20.0.1' `{"type":"string"}`                                                                      |
| `allowed_ips` | Yes      | Client AllowedIPs: '0.0.0.0/0' full-tunnel, or a LAN subnet for split-tunnel `{"default":"0.0.0.0/0","type":"string"}`        |
| `keepalive`   | Yes      | PersistentKeepalive seconds `{"default":"25","type":"string"}`                                                                |

## revoke_wireguard_user

**Revoke WireGuard Remote User** · Risk: **destructive**

Revokes a remote-access user created by onboard_wireguard_user: removes the WireGuard peer tagged `vpn-user: <user>` from the server, immediately cutting their access. Returns whether a peer was removed.

| Parameter | Required | Definition                                                          |
| --------- | -------- | ------------------------------------------------------------------- |
| `user`    | Yes      | The user label used at onboarding `{"type":"string","minLength":1}` |

## list_wireguard_users

**List WireGuard Remote Users** · Risk: **read**

Lists the remote-access users created by onboard_wireguard_user (peers tagged `vpn-user: <user>`): the label, interface, tunnel address, expiry date and whether it has passed, whether the peer is disabled, and the last handshake. Use it to see who has VPN access, who has not connected for a long time, and whose access has expired. Peers that were added another way are not listed; use list_wireguard_peers for all of them.

| Parameter   | Required | Definition                                                 |
| ----------- | -------- | ---------------------------------------------------------- |
| `interface` | No       | Only users of this WireGuard interface `{"type":"string"}` |

## expire_wireguard_users

**Disable or Remove Expired WireGuard Users** · Risk: **destructive**

Acts on the remote-access users whose `expires` date (set at onboard_wireguard_user) has passed. `action=disable` (the default) disables the peer, so access stops and the peer can be enabled again; `action=remove` deletes it. DEFAULTS TO A DRY RUN (`apply=false`) that lists who would be affected. Users without an expiry date are never touched. Run it on a schedule to make expiry dates take effect: a date alone does not stop a connection.

| Parameter | Required | Definition                                                                   |
| --------- | -------- | ---------------------------------------------------------------------------- |
| `action`  | Yes      | `{"default":"disable","type":"string","enum":["disable","remove"]}`          |
| `apply`   | Yes      | false = list only (default); true = act `{"default":false,"type":"boolean"}` |
