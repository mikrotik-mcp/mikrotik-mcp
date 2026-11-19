---
title: "WireGuard Users"
description: "Add remote users with a QR code, set an end date, revoke"
---

## What the page does

The page manages the WireGuard remote-access users of one router. It uses the
same code as the `onboard_wireguard_user`, `list_wireguard_users`,
`revoke_wireguard_user` and `expire_wireguard_users` tools.

## Adding a user

Fill in a label, pick the interface and give the server's public endpoint
(`vpn.example.net:13231`). The router address of the user is picked for you: the
lowest free address in the interface's own subnet. An end date and a DNS server
are optional.

After **Add user** the profile appears as a QR code and as a download:

- Scan the QR code in the WireGuard phone app.
- **Download** gives `<label>.conf` for a computer.

The profile holds the user's private key. It is shown once, in your browser,
and is not kept on the server. **Discard**, a page reload or a change of router
removes it. If it is lost, revoke the user and add it again.

## The list

Each row shows the label, the tunnel address, the interface, the last
handshake and the state: no end date, valid until a date, expired, or disabled.
Only users added here or with `onboard_wireguard_user` are listed; other peers
of the router are not.

- **Revoke** removes the peer. Press it a second time to confirm. Access stops
  at once.
- **Disable expired** appears when a user is past its end date and still
  enabled. An end date alone does not stop a connection; this button, or
  `expire_wireguard_users` on a schedule, does.

## Limits

- Address selection is IPv4 only and needs an IPv4 address on the interface.
- The page does not email a profile or save it on the host. The
  `onboard_wireguard_user` tool does both (`email_to`, `save=true`).
- A read-only server shows the list and refuses changes.
- Every change reaches the audit feed, without the profile.
