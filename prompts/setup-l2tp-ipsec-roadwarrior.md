---
name: setup-l2tp-ipsec-roadwarrior
title: Set up L2TP/IPsec remote access (road warrior)
description: Configure an L2TP-over-IPsec server so laptops and phones can connect with their built-in VPN client.
arguments:
  - name: vpn_pool
    description: The address range handed to VPN clients, e.g. 192.168.89.10-192.168.89.254.
    required: true
  - name: local_gateway
    description: The router's address on the VPN/LAN side that clients use as gateway/DNS, e.g. 192.168.89.1.
    required: true
---

Configure **L2TP/IPsec** remote access — the right choice when users must connect
with the **built-in** VPN client on Windows, macOS, iOS, and Android (no app to
install). Plan first, then apply (firewall under Safe Mode).

Client address pool: {{vpn_pool}}
Gateway / DNS for clients: {{local_gateway}}

## Back up before the first write

Before your FIRST configuration change in this workflow — the tunnel/interface, keys/peers, addresses, routes, NAT, or any mangle or firewall filter rule — ASK the user "Create a local backup first?" and, on yes, call `create_local_backup` for each device you are about to change. It saves a host-side `.rsc` restore point you can `restore_local_backup` if the change cuts the link. Discovery and the read-only fact-gathering steps below need no backup — do it once, right before you start writing. Tunnel creation always warrants a backup; you may skip it only for a minor, non-critical mangle/filter tweak the user explicitly waves off.

Build order:

1. **IP pool** — `create_ip_pool` for {{vpn_pool}} (e.g. name `l2tp-pool`).
2. **PPP profile** — `create_ppp_profile` (name `l2tp-profile`,
   `local_address={{local_gateway}}`, `remote_address=l2tp-pool`,
   `dns_server={{local_gateway}}`, `change_tcp_mss=yes`).
3. **User accounts** — `create_ppp_secret` per user with
   `service=l2tp` and `profile=l2tp-profile`. Use strong passwords.
4. **Enable the server** — `set_l2tp_server` with `enabled=true`,
   `default_profile=l2tp-profile`, `use_ipsec=required`, and a strong
   `ipsec_secret` (this is the IPsec pre-shared key clients enter).
   `authentication=mschap2`. Also set on the same call:
   - `max_mtu`/`max_mru` = **1400** (L2TP + IPsec ESP overhead easily exceeds
     100 bytes; leaving 1450 causes the "connects fine, transfers stall" symptom),
   - `keepalive_timeout` = **30** — dead client sessions otherwise linger and hold
     their pool address until the default timeout expires.

   The `change_tcp_mss=yes` set on the profile in step 2 makes MSS follow the
   negotiated MTU automatically — that is the PPP-family equivalent of a
   `change-mss` mangle rule, and it is why L2TP does not need one. If clients
   still stall on large transfers, add the mangle rule anyway
   (`create_mangle_rule`: `chain=forward`, `protocol=tcp`, `tcp_flags=syn`,
   `tcp_mss=1400-65535`, `action=change-mss`, `new_mss=clamp-to-pmtu`).

5. **Firewall** — accept UDP 500, UDP 4500, UDP 1701, and IP protocol 50 (ESP)
   on the input chain from the internet; allow the {{vpn_pool}} range to reach the
   LAN/internet in the forward chain as required. Apply under `enable_safe_mode`,
   verify you can still reach the router, then `commit_safe_mode`.
6. **Verify** — `get_l2tp_server`, then `get_ppp_active` after a test client
   connects.

Finish with a short **client setup card**: server address, the IPsec pre-shared
key (treat as a secret), the username/password, and the per-OS steps (type =
"L2TP over IPsec"). Confirm before applying changes.
