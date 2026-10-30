---
title: "VPN & Tunneling Guide"
description: "Practical setup, operations and limits for VPN & Tunneling Guide."
---

`@usex/mikrotik-mcp` covers **every** MikroTik VPN and tunneling technology, with
guided MCP prompts that pick and build the right one. This guide is the map:
what each option is for, how the modules relate, and which tools build it.

## Pick the right tunnel

| You need…                                                                               | Use                           | Why                                      |
| --------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| MikroTik ↔ MikroTik, or modern laptops/phones (app OK)                                  | **WireGuard**                 | Fastest, simplest, least config.         |
| Site-to-site with **another vendor** (Cisco/Forti/pfSense), or native iOS/Windows IKEv2 | **IPsec (IKEv2)**             | The interoperability standard.           |
| Remote users on the **built-in** OS VPN client (no install)                             | **L2TP/IPsec**                | Native on Windows/macOS/iOS/Android.     |
| Must punch through restrictive firewalls/proxies                                        | **SSTP**                      | TLS over port 443.                       |
| Cross-platform with the OpenVPN client                                                  | **OpenVPN**                   | RouterOS 7 adds UDP.                     |
| Route/bridge between sites (often **over** IPsec)                                       | **GRE / IPIP / EoIP / VXLAN** | Transport tunnels; EoIP/VXLAN bridge L2. |
| A legacy device that only speaks PPTP                                                   | **PPTP**                      | Legacy & weak — avoid if possible.       |

> **Smart path:** invoke the [`choose-vpn-solution`](/docs/guides/prompts) prompt with your
> requirement and the server will recommend one, justify it against the others,
> and outline the build.

## How the modules fit together

```
                         ┌─────────────── VPN / Tunneling ───────────────┐
 WireGuard ─ wireguard.ts (interfaces, peers, client-config)
 IPsec ───── ipsec.ts     (profile→peer→identity→proposal→policy, SAs)
                                   ▲ can encrypt ▼
 GRE/IPIP/EoIP/VXLAN ─ tunnels.ts  (transport / L2 bridging)

 PPP family — all share ppp.ts  (profiles + secrets + active sessions)
   ├─ L2TP  ── l2tp.ts    (server + clients, use_ipsec=required ⇒ L2TP/IPsec)
   ├─ PPTP  ── pptp.ts    (server + clients, legacy)
   ├─ SSTP  ── sstp.ts    (server + clients, TLS/cert)
   └─ OpenVPN ─ openvpn.ts (server + clients)
                         └────────────────────────────────────────────────┘
```

The PPP-based VPNs (L2TP, PPTP, SSTP, OpenVPN) **do not** define users themselves
— user accounts and the IP/DNS handed to clients come from `/ppp secret` and
`/ppp profile`. So a typical road-warrior build is: create a profile + an IP pool,
add per-user secrets, then enable the relevant server.

## Tool map

| Technology              | Module                                 | Key tools                                                                                                                                                                                            |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WireGuard**           | [wireguard](/docs/reference/wireguard) | `create_wireguard_interface`, `add_wireguard_peer`, `generate_wireguard_client_config`                                                                                                               |
| **IPsec**               | [ipsec](/docs/reference/ipsec)         | `create_ipsec_profile`, `create_ipsec_peer`, `create_ipsec_identity`, `create_ipsec_proposal`, `create_ipsec_policy`, `get_ipsec_active_peers`, `get_ipsec_installed_sa`, `flush_ipsec_installed_sa` |
| **PPP backend**         | [ppp](/docs/reference/ppp)             | `create_ppp_profile`, `create_ppp_secret`, `get_ppp_active`, `disconnect_ppp_active`                                                                                                                 |
| **L2TP**                | [l2tp](/docs/reference/l2tp)           | `set_l2tp_server` (`use_ipsec=required`), `create_l2tp_client`                                                                                                                                       |
| **PPTP**                | [pptp](/docs/reference/pptp)           | `set_pptp_server`, `create_pptp_client`                                                                                                                                                              |
| **SSTP**                | [sstp](/docs/reference/sstp)           | `set_sstp_server` (needs a certificate), `create_sstp_client`                                                                                                                                        |
| **OpenVPN**             | [openvpn](/docs/reference/openvpn)     | `set_ovpn_server`, `create_ovpn_client`                                                                                                                                                              |
| **GRE/IPIP/EoIP/VXLAN** | [tunnels](/docs/reference/tunnels)     | `create_gre_tunnel`, `create_ipip_tunnel`, `create_eoip_tunnel`, `create_vxlan_tunnel`                                                                                                               |

Certificates for SSTP/OpenVPN/IPsec-rsa are managed in the
[certificate](/docs/reference/certificate) module (`create_certificate`,
`sign_certificate`, `import_certificate`).

## Guided build prompts

| Prompt                                                 | Builds                                                    |
| ------------------------------------------------------ | --------------------------------------------------------- |
| [`choose-vpn-solution`](/docs/guides/prompts)          | Recommends the right technology for your use case.        |
| [`setup-wireguard-vpn`](/docs/guides/prompts)          | WireGuard server + first peer + client config.            |
| [`setup-ipsec-site-to-site`](/docs/guides/prompts)     | IKEv2 site-to-site tunnel with matching phase-1/2 params. |
| [`setup-l2tp-ipsec-roadwarrior`](/docs/guides/prompts) | L2TP/IPsec remote access for built-in OS clients.         |

## Firewall reminders

Every inbound VPN needs the right ports opened on the **input** chain — do this
under [Safe Mode](/docs/guides/safe-mode) so a mistake can't lock you out:

| VPN                | Open on input                                            |
| ------------------ | -------------------------------------------------------- |
| WireGuard          | UDP `listen-port` (default 13231)                        |
| IPsec / L2TP-IPsec | UDP 500, UDP 4500, IP proto 50 (ESP); L2TP also UDP 1701 |
| SSTP               | TCP 443 (or your chosen port)                            |
| OpenVPN            | TCP/UDP 1194 (or your chosen port)                       |
| PPTP               | TCP 1723 + IP proto 47 (GRE)                             |

For site-to-site, also add a NAT **bypass** rule so traffic between the two LANs
is routed, not masqueraded.
