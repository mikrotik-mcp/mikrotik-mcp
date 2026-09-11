# Multi-router round-trip path lab

`trace_round_trip` composes the existing packet simulator across an **explicit**
forward path and return path. It reads saved snapshots only: no SSH, packets,
configuration writes or automatic snapshot capture. The dashboard exposes the
same guarded handler at **Round-trip Lab** (`POST /api/round-trip?device=branch`).

## What the result means

- `modelled`: the static IPv4 forwarding model agrees with every declared hop in
  both directions, under the returned assumptions. **Not proof of connectivity.**
- `blocked`: the supported model finds a firewall rejection/drop or missing/discard
  route on the evaluated path. A real device may have changed since capture.
- `unknown`: evidence is insufficient, a declared egress/next-hop disagrees, or the
  path encounters unsupported state. This is never converted to success.

Every result has `liveDelivery: "unverified"`, per-hop firewall/routing evidence,
snapshot IDs, capture times and content fingerprints. Full export bodies and raw
rule text are not included. Rule references are explanatory snapshot positions
and source lines, **not mutation identifiers**.

## Inputs

First capture/select snapshots using the existing snapshot workflow. Select the
first forward router as the MCP `device`. Replace the example names and IDs:

```json
{
  "snapshots": [
    { "device": "branch", "id": "branch-snapshot-id" },
    { "device": "edge", "id": "edge-snapshot-id" }
  ],
  "forward": [
    { "device": "branch", "ingress": "lan", "egress": "transit" },
    { "device": "edge", "ingress": "transit", "egress": "servers" }
  ],
  "reverse": [
    { "device": "edge", "ingress": "servers", "egress": "transit" },
    { "device": "branch", "ingress": "transit", "egress": "lan" }
  ],
  "packet": {
    "srcAddress": "192.0.2.10",
    "dstAddress": "198.51.100.10",
    "protocol": "tcp",
    "srcPort": 49152,
    "dstPort": 443
  },
  "maxAgeSeconds": 900,
  "maxSkewSeconds": 120
}
```

Exactly one snapshot is required for every referenced router. At most eight
distinct routers and eight hops per direction; loops/repeated routers in a leg
are rejected. TCP/UDP require both ports; the hypothetical reply swaps addresses
and ports. Supported protocols are TCP, UDP and ICMP.

The first return ingress must join the final forward egress, and the final return
egress must join the first forward ingress. At intermediate IP-gateway hops, the
selected next-hop must equal an address on the declared next router's ingress.
Interface gateways rely on the operator's explicit link declaration. The last
hop must reach a directly connected destination network, not an unmodelled
external default-route segment.

## Safety and freshness

All named devices are resolved and authorized **before any snapshot lookup**.
The handler checks each snapshot's owning device, content fingerprint, maximum
size (512 KiB), timestamp and capture skew. Missing/invalid/stale evidence causes
an error, not a guessed topology. Access is checked again before returning results.

Default maximum snapshot age is 15 minutes and maximum cross-router capture skew
is two minutes. Callers may choose age 1–86400 seconds and skew 0–3600 seconds;
snapshots over ten seconds in the future are rejected. These bounds do not detect
a change made after capture. The HTTP input is byte-limited to 8 KiB and rejects
cross-origin POST requests; dashboard token authentication still applies.

## Deliberate modelling boundaries

- Explicit links are **assumptions**, not discovered wiring or measured tunnel
  state. Layer-2 delivery, ARP, host firewalls, application responses, MTU and
  physical/tunnel liveness are not verified.
- The forward packet is hypothetical `new`; the reply assumes a responding
  endpoint and `established` conntrack. If the declared return path adds a router
  that never saw the forward leg, the result is `unknown`, not assumed established.
- Declared asymmetry is surfaced even if it cannot be evaluated. This is not live
  asymmetric-route discovery or connection-state synchronization.
- A traversed NAT rewrite stops composition with `unknown` and retains NAT
  evidence. No masquerade address, cross-router rewritten tuple or reverse NAT
  state is invented. NAT support remains future work for this feature.
- Dynamic routing sources, ECMP, raw rules, unsupported matches, unparsed input,
  VRF/routing rules, IPsec/hotspot forwarding state, global IP/conntrack settings,
  bridge filters/NAT/settings and configured disabled interfaces conservatively
  prevent a modelled success. This can produce false-unknowns on irrelevant
  configuration; it is intentional, not a healthy result.
- Router-local input/output and IPv6 are outside this transit feature. This does
  not claim complete RouterOS dataplane emulation or replace live client tests.
- Results are returned, not automatically persisted as new evidence cases. Saved
  source snapshots remain governed by the existing snapshot retention workflow.

## Verification

Offline tests cover two-router transit, return-only firewall failure, missing
return routes, NAT uncertainty, ECMP, unmodelled routing state, gateway/egress
mismatch, asymmetry, freshness/skew/integrity, ownership and access checks before
storage lookup, cross-origin requests and bounded input.

```bash
bunx vp test run tests/paths
bun run test:types
bunx tsc --noEmit -p ui/tsconfig.json
```

No production route/firewall changes or live packet-path claims were made while
testing this feature. The running MCP instance was not reloaded to test the new
tool; the dashboard passed type/build checks, but interactive visual review was
not available in the current environment. Full enterprise redesign is a separate
pending item in the [delivery tracker](enterprise-roadmap.md).
