---
name: setup-v2ray-container-proxy
title: Plan a V2Ray/Xray or sing-box container gateway on RouterOS
description: Audit prerequisites, then plan an isolated proxy container with explicit approval, dual-stack policy, bounded lifecycle checks and end-to-end verification.
arguments:
  - name: device
    description: Exact configured router; omit to discover and ask.
    required: false
  - name: protocol
    description: Desired protocol supported by the selected image and remote server.
    required: false
  - name: image
    description: Reviewed architecture-compatible image and pinned version/digest.
    required: false
  - name: scope
    description: Selective destinations or all traffic for explicitly selected clients.
    required: false
---

Plan a lawful, authorized proxy deployment on {{device}}.
Protocol: {{protocol}}. Image: {{image}}. Client routing scope: {{scope}}.
Start READ-ONLY. Use the shared container guide below as the safety baseline.
An audit or a request for advice is not permission to change router configuration.

## Discover and choose

Resolve the exact device. Inspect version/architecture/CPU variant, container
package, device-mode, storage and available resources. A command failure is not
proof the package is missing. Treat unknown prerequisites as blockers to writes.
Enabling container=yes needs operator physical confirmation; do not change the
whole device-mode or silently install packages, reboot, format or Netinstall.
Inspect existing management, LAN/VPN, IPv4/IPv6 policy and other containers first.

Ask for the remote server, protocol, intended clients and access constraints.
Verify the image publisher, protocol documentation, required env KEY names,
architecture/variant, privilege/device requirements and pinned image identity.
Never promise DPI evasion or speed improvement. Keep credentials out of reports.

A SOCKS5 proxy alone cannot serve as an IP gateway. An all-in-one TUN image or
an explicitly designed proxy plus TUN gateway can do so only if IP forwarding,
return routes and startup ordering are verified. Do not assume eth0 inside the
image. Discover available tools with find_tools/describe_tool before raw commands.

## Plan, approve and protect

Show the complete plan and obtain approval before writes. Back up approved router
configuration AND application data; eligible Safe Mode rollback does not restore
container images, files or volumes. Agree an independent recovery path.

Use a dedicated container bridge/VLAN and verified non-overlapping subnet.
Assign the router gateway to that bridge and a distinct address to the VETH.
Do not assign the same IP to both ends or add containers to trusted LAN by default.
Container internet source NAT, if needed, uses its source subnet and the positive
real WAN egress, not out-interface=veth. Restrict published ports by source,
destination and ingress; never expose an unauthenticated SOCKS/admin listener.

For selective routing, explicitly scope clients/destinations and exclude router
management, container traffic and the remote server to avoid loops. Preserve the
remote server route through the real WAN and the return path to LAN/VPN clients.
For all-traffic routing, design fail-closed behavior for both IP families, including
existing connections, rule ordering and FastTrack. A low-priority drop after broad
accepts is not a kill switch. Do not silently replace the router's main default.

## Deploy and verify, only after approval

Use the target's verified env/mount syntax; current list=/envlists/mountlists and
legacy name=/envlist/mounts are not interchangeable. Protect secrets in inputs.
Add exactly one image source and a unique name, VETH and dedicated root path.
After add, poll with a deadline for positive fully-stopped evidence before start.
Use the fresh stable .id. A timeout may have applied: inspect before retrying.

Confirm process state, sanitized application handshake and health separately.
Test DNS/IPv4/IPv6 egress from a representative selected LAN client, not only
router-originated fetch. Verify an unselected client remains on its intended path
and unauthorized access is denied. Test the approved failure scenario without
disrupting unrelated clients. Measure PMTU before MTU/MSS changes; do not assume
encapsulation is the only cause of a stalled download.

Enable start-on-boot only after checks and approval. Schedule a reboot test
separately. Report applied changes, observed results, pending/unknown tests and
recovery steps with secrets masked; no claim of success from running alone.
