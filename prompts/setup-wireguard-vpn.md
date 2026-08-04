---
name: setup-wireguard-vpn
title: Set up a WireGuard VPN + first peer
description: Stand up a WireGuard server interface on the router and generate a ready-to-use client config for one peer.
arguments:
  - name: vpn_subnet
    description: The VPN tunnel subnet in CIDR, e.g. 10.10.0.0/24.
    required: true
  - name: endpoint
    description: The public hostname/IP clients will connect to (your WAN address or DDNS name).
    required: true
  - name: listen_port
    description: UDP port for WireGuard (default 13231).
    required: false
---

Provision a WireGuard VPN on this MikroTik device and produce a working client
config. Confirm the plan with the user before applying changes.

VPN subnet: {{vpn_subnet}}
Public endpoint: {{endpoint}}
Listen port: {{listen_port}}

## Back up before the first write

Before your FIRST configuration change in this workflow — the tunnel/interface, keys/peers, addresses, routes, NAT, or any mangle or firewall filter rule — ASK the user "Create a local backup first?" and, on yes, call `create_local_backup` for each device you are about to change. It saves a host-side `.rsc` restore point you can `restore_local_backup` if the change cuts the link. Discovery and the read-only fact-gathering steps below need no backup — do it once, right before you start writing. Tunnel creation always warrants a backup; you may skip it only for a minor, non-critical mangle/filter tweak the user explicitly waves off.

Steps:

1. **Server interface** — `create_wireguard_interface` (e.g. name `wg-vpn`,
   listen port {{listen_port}} or 13231). Then `get_wireguard_interface` to read
   back its **public key**.
2. **Tunnel address** — `add_ip_address` on `wg-vpn` using the router's address in
   {{vpn_subnet}} (e.g. the .1).
3. **Firewall** — `create_filter_rule` in `input` to accept UDP on the listen port
   from WAN, and in `forward` to allow the VPN subnet to the LAN/internet as the
   user wants. Use Safe Mode for the firewall edits.
4. **First peer** — `add_wireguard_peer` on `wg-vpn` with the client's allowed
   address (a /32 in {{vpn_subnet}}). If the client keypair is generated on the
   client, collect its public key; otherwise note that the private key must be
   created client-side.
5. **Client config** — call `generate_wireguard_client_config` with the server
   public key, {{endpoint}}, the listen port, and the assigned client address, and
   present the resulting `[Interface]/[Peer]` config for the user to import.
6. **Keepalive** — set `persistent_keepalive` to `25` on every peer
   (`add_wireguard_peer`/`update_wireguard_peer`) and `client_keepalive=25s` in the
   generated client config. Roaming clients sit behind NAT; a UDP mapping typically
   expires after ~30 s of silence, after which the server cannot reach the client
   until the client speaks first. 25 s keeps the mapping alive.
7. **MTU / MSS** — the step most WireGuard deployments skip, and the reason a VPN
   "works" for logins but stalls on file transfers, photo/video uploads and some
   web pages:
   - WireGuard adds ~60 bytes. Set the interface MTU to **1420**
     (`update_wireguard_interface`); use **1412** on a PPPoE WAN, or **1280** when
     the path is unknown — 1280 always fits.
   - MTU alone is not enough. Endpoints derive their TCP MSS from _their own_ NIC
     MTU, so a 1460-byte-MSS session still emits oversized packets with DF set;
     mid-path routers drop rather than fragment and the ICMP "fragmentation needed"
     is often filtered — a PMTU black hole. Clamp it with `create_mangle_rule`:
     `chain=forward`, `protocol=tcp`, `tcp_flags=syn`, `tcp_mss=1400-65535`,
     `action=change-mss`, `new_mss=clamp-to-pmtu`. WireGuard has no per-interface
     MSS setting, so mangle is the only place this can be fixed.
   - Verify: `ping` a host across the tunnel with size 1400 and `do-not-fragment`.
     Small pings succeeding while this fails is the black-hole signature.

Report the server public key, the peer you added, the MTU/MSS/keepalive values
applied, and the full client config.
