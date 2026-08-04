---
name: setup-ipsec-site-to-site
title: Build an IPsec IKEv2 site-to-site tunnel
description: Stand up an interoperable IPsec IKEv2 tunnel between this router and a remote site/peer.
arguments:
  - name: local_subnet
    description: The local network behind this router, in CIDR (e.g. 192.168.10.0/24).
    required: true
  - name: remote_subnet
    description: The remote network behind the peer, in CIDR (e.g. 192.168.20.0/24).
    required: true
  - name: peer_address
    description: The public IP / hostname of the remote peer.
    required: true
---

Build a secure IPsec **IKEv2** site-to-site tunnel. IKEv2 is the interoperability
choice — it works against other MikroTik routers and third-party firewalls
(Cisco, Fortinet, pfSense). Plan first, present the parameters for both ends to
match, then apply under Safe Mode.

Local subnet: {{local_subnet}}
Remote subnet: {{remote_subnet}}
Peer address: {{peer_address}}

## Back up before the first write

Before your FIRST configuration change in this workflow — the tunnel/interface, keys/peers, addresses, routes, NAT, or any mangle or firewall filter rule — ASK the user "Create a local backup first?" and, on yes, call `create_local_backup` for each device you are about to change. It saves a host-side `.rsc` restore point you can `restore_local_backup` if the change cuts the link. Discovery and the read-only fact-gathering steps below need no backup — do it once, right before you start writing. Tunnel creation always warrants a backup; you may skip it only for a minor, non-critical mangle/filter tweak the user explicitly waves off.

Build order (use the `create_ipsec_*` tools; keep phase-1/phase-2 parameters
identical on both ends):

1. **Profile (phase 1)** — `create_ipsec_profile` (e.g. dh-group modp2048,
   enc-algorithm aes-256, hash sha256). Note the values so the remote side matches.
2. **Proposal (phase 2)** — `create_ipsec_proposal` (e.g. auth sha256,
   enc aes-256-cbc, pfs-group modp2048).
3. **Peer** — `create_ipsec_peer` with `address={{peer_address}}`,
   `exchange_mode=ike2`, and the profile from step 1.
4. **Identity** — `create_ipsec_identity` for that peer with
   `auth_method=pre-shared-key` and a strong secret (or certificates for
   production). Set `generate_policy=port-strict` only if you are not defining an
   explicit policy.
5. **Policy** — `create_ipsec_policy` with `src_address={{local_subnet}}`,
   `dst_address={{remote_subnet}}`, `tunnel=true`, `action=encrypt`, the peer, and
   the proposal.
6. **Firewall / NAT** — ensure UDP 500 + 4500 and IP protocol 50 (ESP) are
   accepted from {{peer_address}} on the input chain, and add a NAT _bypass_
   (accept/no-nat) rule so {{local_subnet}}→{{remote_subnet}} traffic is NOT
   masqueraded. Apply firewall edits under `enable_safe_mode`.
7. **MTU / MSS** — policy-mode IPsec has no interface whose MTU you can lower, so
   MSS clamping is the _only_ lever, and skipping it is the classic "tunnel is up
   but large transfers hang" failure. ESP tunnel mode costs ~73 bytes (more with
   NAT-T/UDP-4500). Add `create_mangle_rule`: `chain=forward`, `protocol=tcp`,
   `tcp_flags=syn`, `tcp_mss=1400-65535`, `action=change-mss`,
   `new_mss=clamp-to-pmtu` — or a fixed `new_mss=1360` when the path MTU is known
   and PMTU discovery is unreliable. Endpoints size their MSS from their own LAN
   MTU and set DF; without the clamp those packets are dropped in transit and the
   ICMP "fragmentation needed" is usually filtered, so the sender never learns.
8. **Verify** — `get_ipsec_active_peers` and `get_ipsec_installed_sa` to confirm
   the tunnel established; `ping` a remote host with src-address in
   {{local_subnet}}. Then repeat with size 1400 and `do-not-fragment` — small
   pings passing while large ones fail means the MSS clamp in step 7 is missing or
   not matching.

Present the matching parameter set for the remote engineer and the exact tool
calls before applying. Never echo the pre-shared key back in plaintext beyond
what is necessary to configure the peer.
