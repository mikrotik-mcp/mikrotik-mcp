---
name: setup-wireguard-tunnel-between-sites
title: Build a WireGuard tunnel between two MikroTik devices
description: Configure BOTH routers of a WireGuard site-to-site tunnel from one conversation — keys, peers, addressing, routes, firewall, MTU/MSS — then verify end to end. Includes DPI-resistant / censorship-bypass transport options.
arguments:
  - name: device_a
    description: First configured device (config key or label from list_mikrotik_devices), e.g. site-a.
    required: false
  - name: device_b
    description: Second configured device, e.g. site-b.
    required: false
  - name: tunnel_subnet
    description: Small transit subnet for the tunnel link itself in CIDR, e.g. 10.255.255.0/30 (A=.1, B=.2). Omit to let you pick one that doesn't collide with either LAN.
    required: false
  - name: listen_port
    description: UDP port WireGuard listens on. Default 13231. Consider 443/53/500 to survive restrictive networks (see the bypass section).
    required: false
---

You are building a **WireGuard site-to-site tunnel between two MikroTik routers**
this server can both reach. WireGuard is the right default for MikroTik↔MikroTik:
modern crypto (Curve25519 / ChaCha20-Poly1305), stateless, tiny, and roams across
IP changes. You will drive **both** routers in one flow via the `device` argument.
Precision matters — a single mismatched key, allowed-address, or MTU silently
breaks the tunnel. Confirm the plan before any change; never write without approval.

Device A: {{device_a}}
Device B: {{device_b}}
Transit subnet: {{tunnel_subnet}}
Listen port: {{listen_port}}

## Back up before the first write

Before your FIRST configuration change in this workflow — the tunnel/interface, keys/peers, addresses, routes, NAT, or any mangle or firewall filter rule — ASK the user "Create a local backup first?" and, on yes, call `create_local_backup` for each device you are about to change. It saves a host-side `.rsc` restore point you can `restore_local_backup` if the change cuts the link. Discovery and the read-only fact-gathering steps below need no backup — do it once, right before you start writing. Tunnel creation always warrants a backup; you may skip it only for a minor, non-critical mangle/filter tweak the user explicitly waves off.

## 0. Discover and confirm both endpoints (do this FIRST)

- Call `list_mikrotik_devices` to enumerate the configured routers (key, label,
  transport target, default).
- Resolve `{{device_a}}` / `{{device_b}}` against that inventory. If either is
  missing or ambiguous, STOP and show the list — never substitute a similar name
  (these are different physical routers). If either was omitted, ask the user which
  two devices to connect.
- Only one of the two ends needs a reachable public endpoint. Determine which side
  is publicly reachable (static WAN IP or DDNS) — that side is the **responder**;
  the other becomes the **initiator** and uses `persistent-keepalive` to hold the
  path open through NAT. If **both** are behind NAT with no port-forward, say so:
  a plain WireGuard tunnel can't form — you'd need a relay/VPS or a reachable side.

## 1. Gather the facts (read-only, per device)

For each of {{device_a}} and {{device_b}}, with `device=<name>`:
`get_system_identity`, `list_interfaces`, `list_ip_addresses`, `get_routing_table`,
and `get_ip_cloud` (for a DDNS name if there's no static WAN). Record each side's:
public/WAN address (or DDNS), the WAN interface and its MTU, and the **LAN
subnet(s)** to route. Verify the two LANs do **not overlap** — if they do, WireGuard
allowed-address routing is ambiguous and you must NAT one side or renumber; flag it.

## 2. Pick non-colliding addressing

- Transit subnet: `{{tunnel_subnet}}` or a /30 that collides with neither LAN
  (e.g. `10.255.255.0/30`). A=`.1`, B=`.2`.
- Confirm the plan back to the user: interface names (`wg-<peer>`), listen ports,
  transit IPs, and which LAN each side will advertise.

## 3. Create the WireGuard interfaces and exchange keys

- On EACH side: `create_wireguard_interface` (`device=<name>`, name e.g.
  `wg-{{device_b}}` on A and `wg-{{device_a}}` on B, `listen_port`={{listen_port}}
  or 13231). RouterOS auto-generates the private key and derives the public key.
- Read each side's **public key** with `get_wireguard_interface` (`device=<name>`).
  You will cross-feed these: A's peer uses **B's** public key and vice-versa. Never
  transmit or log the private keys — they never leave their router.
- `add_ip_address` the transit IP on each wg interface (A: `10.255.255.1/30` on
  `wg-...`; B: `10.255.255.2/30`).

## 4. Add the peers (the exact, symmetric part)

On **A** (`device={{device_a}}`): `add_wireguard_peer`

- `interface` = A's wg interface
- `public_key` = **B's** public key
- `allowed_address` = the transit peer + **B's LAN(s)**, e.g.
  `10.255.255.2/32,192.168.20.0/24` (comma-separated; this is WireGuard's crypto-
  routing table — it must list every subnet you expect to reach through B)
- `endpoint_address` = B's public IP/DDNS, `endpoint_port` = B's listen port
  (set these on whichever side is the initiator; the responder can omit them)
- `persistent_keepalive` = `25` on the side behind NAT (the initiator) so the
  mapping stays open
- optional `preshared_key` = the SAME 32-byte PSK on both peers for an extra
  symmetric layer (post-quantum-ish defense-in-depth; must match exactly).

On **B** (`device={{device_b}}`): mirror it — `public_key` = **A's**,
`allowed_address` = `10.255.255.1/32,<A's LAN>`, endpoint pointing at A **only if**
A is the reachable side.

## 5. Route each far LAN over the tunnel

`allowed-address` governs what WireGuard will _cryptographically_ accept, but you
still need an IP route so RouterOS _sends_ far-LAN traffic into the interface:

- On A: `add_route` (`device={{device_a}}`) `dst-address=<B's LAN>`,
  `gateway=<A's wg interface>`.
- On B: mirror with A's LAN.
  (The transit /30 already has a connected route from step 3.)

## 6. Firewall — safely, per device

Per side, under Safe Mode (`enable_safe_mode` `device=<name>` → edits → verify →
`commit_safe_mode`; Safe Mode is per-device so each commits independently):

- `input` chain: accept `protocol=udp dst-port=<listen_port>` from the far side's
  WAN (or from any, if the endpoint is dynamic) — place it **above** any default
  drop.
- `forward` chain: accept traffic between the two LANs in both directions; if there
  is a default-deny, add explicit accepts for `src`/`dst` of each LAN over the wg
  interface.
- Do NOT masquerade the tunnel subnet unless you deliberately want NAT (it breaks
  return routing for site-to-site).

## 7. MTU / MSS (the silent-failure trap)

WireGuard adds ~60 bytes of overhead. Small pings work but large flows (TLS, file
transfer) stall if MTU is wrong:

- Set the wg interface MTU to **1420** (1412 if the WAN is PPPoE, 1280 if the path
  is unknown/multi-hop — 1280 is the always-safe floor) via
  `update_wireguard_interface`.
- Clamp TCP MSS with `create_mangle_rule` (**not** `create_filter_rule` — only the
  mangle table has `change-mss`): `chain=forward`, `protocol=tcp`,
  `tcp_flags=syn`, `tcp_mss=1400-65535`, `action=change-mss`,
  `new_mss=clamp-to-pmtu`. WireGuard has no per-interface MSS option, so this
  mangle rule is the only place to fix MSS.

## 8. Verify end to end

- From A (`ping` `device={{device_a}}`): ping B's transit IP (`10.255.255.2`), then
  a host in B's LAN with `src_address` = A's LAN IP. Repeat from B.
- `list_wireguard_peers` / `get_wireguard_status` on each side: confirm a recent
  **last-handshake** and rx/tx counters climbing. No handshake ⇒ firewall/endpoint/
  key/allowed-address mismatch — check in that order.
- Large-payload test: ping with size 1400 and `do-not-fragment`; if it fails,
  revisit MTU/MSS (step 7).

## Bypassing country / DPI restrictions (legitimate censorship circumvention)

Some networks block or throttle VPNs. The following are for lawful privacy /
accessibility on links you're authorized to use — comply with local law and any
service terms. From least to most evasive:

1. **Port camouflage.** Move `listen_port` to a port that's rarely filtered:
   `443` (HTTPS/QUIC), `53` (DNS), `123` (NTP), or `500`. UDP/443 often survives
   because it looks like QUIC. Cheapest change; update the peer `endpoint_port` on
   the other side to match. _Caveat: this hides the port, not the handshake._
2. **DPI fingerprinting reality.** WireGuard's first handshake message has a fixed,
   recognizable shape, so deep-packet-inspection can block it regardless of port.
   RouterOS has **no native WireGuard obfuscation** (no obfs4/wstunnel/Shadowsocks/
   XRay). To defeat DPI you must wrap the tunnel in something that looks benign:
3. **Wrap WireGuard inside a TLS-looking tunnel.** Bring up an **SSTP** tunnel
   (PPP-over-TLS on **TCP 443** — indistinguishable from HTTPS to most DPI) between
   the sites with `create_sstp_client`/the SSTP server tools, then either route the
   far LANs directly over SSTP, or run the WireGuard endpoint _across_ the SSTP link
   so the WG handshake never touches the open internet. **OpenVPN in TCP/443 mode**
   (`create_ovpn_client`, `tls`) is an equivalent camouflage. This trades throughput
   (TCP-in-TCP) for reachability.
4. **IPsec IKEv2 as an alternative fingerprint.** If WireGuard specifically is
   blocked, an IKEv2 tunnel over **UDP 4500 (NAT-T)** presents a different signature
   and is often allowed; use the `setup-ipsec-site-to-site` flow. GRE-over-IPsec
   (`ipsec_secret`) rides ESP and is another option.
5. **Advanced obfuscation via a RouterOS container.** For hostile DPI (active
   probing, protocol allow-lists), the strong tools — **XRay/VLESS+Reality,
   sing-box, Shadowsocks, obfs4** — aren't native. Run one in a RouterOS
   **`/container`** (or on a VPS you control) and route the site tunnel through it;
   WireGuard then rides an already-obfuscated transport. Call this out as the
   heavier, most robust option and confirm the device has container support and
   spare resources before proposing it.
6. **Keepalive + MTU hygiene under hostile networks.** Keep `persistent-keepalive`
   low (15–25 s) so aggressive NATs don't reap the mapping, and set MTU
   conservatively (fragmentation-sensitive DPI drops oversized handshakes).

Recommend the lightest option that works for the user's threat model (start at #1,
escalate to #3, reserve #5 for active blocking), explain the throughput/complexity
trade-off, and never present obfuscation as a guarantee — it is an arms race.

---

Report, per side: interface name, public key (never the private key), listen port,
transit IP, peer allowed-address, routes and firewall rules added, the MTU/MSS
settings, and the verification results (handshake time, ping). State plainly which
device each change ran on. Never apply changes the user hasn't approved.
