# Config Narrative

You have just inherited a router. `/export` tells you everything and explains
nothing.

`explain_device` reads the configuration and writes the document that should
have been in the wiki: what this box is _for_, what VLANs exist, how traffic
reaches the internet, what each firewall chain actually does, and — the section
people actually read — **what is exposed to the internet**.

Three tools, in the **Config Narrative** module (Discovery & Meta):

| Tool                | Risk | What it does                                           |
| ------------------- | ---- | ------------------------------------------------------ |
| `explain_device`    | READ | The full architecture document, with a Mermaid diagram |
| `explain_section`   | READ | One area in depth — firewall, addressing, exposure, …  |
| `diff_explanations` | READ | Two configurations → what the difference **means**     |

## Why a tool and not a prompt

A prompt can already ask a model to describe a router, and it works — by pouring
three thousand lines of export into the context window every time,
unrepeatably.

This pre-digests the configuration into a structured model on the MCP host. The
model receives an analysed document instead of raw text, and the output is
deterministic: the same export always produces byte-identical Markdown, which is
what makes two dates comparable.

**The division of labour: the tool decides what is true and what matters; the
model decides how to say it.**

## What it produces

1. **What this device is** — model, RouterOS version, and an inferred role with
   the signals behind it.
2. **Exposed to the internet** — first, on purpose.
3. **Topology** — ports, bridges, VLANs and their subnets, as a Mermaid
   `graph LR` plus a table.
4. **Addressing** — subnets, DHCP scopes and ranges, static reservations, and
   which subnets have no DHCP at all.
5. **Internet path** — WAN interfaces, how each gets its address, NAT strategy,
   and which one wins on a multi-WAN box.
6. **Firewall** — every chain, one plain sentence per rule, and what happens to
   anything not matched.
7. **VPN and tunnels** — every tunnel, its peers, and the subnets it carries.
8. **Management services** — what is enabled, on which port, reachable from
   where.
9. **What this document does not cover** — see below.

## Role inference shows its work

```
Primary role: **Edge router**
Also acts as: Switch, Wireless controller

The signals behind that call:

- **Edge router** (score 5)
  - source NAT with no static default route (a DHCP/PPPoE WAN would learn one at runtime) — `/ip/firewall/nat`
  - 1 DHCP client(s) — an upstream hands this box an address — `/ip/dhcp-client`
- **Switch** (score 3)
  - 3 bridge ports — it switches traffic between them — `/interface/bridge/port`
```

An explicit scored signal table, not a heuristic buried in prose. A wrong
inference you can see the reasoning for is debuggable; one you cannot is just
wrong.

Several roles at once is normal and expected — a home router is edge + wireless +
switch, and forcing a single answer would be less true, not simpler.

| Signal                                        | Suggests            |
| --------------------------------------------- | ------------------- |
| default route + srcnat masquerade             | edge router         |
| CAPsMAN manager enabled                       | wireless controller |
| bridge ports with no routing or NAT           | switch              |
| PPP server + address pool, or a WireGuard hub | VPN concentrator    |
| BGP peers with public ASNs                    | border router       |
| `/container` entries                          | application host    |

## What it will not do

**It never claims to know more than the export does.** A configuration says what
is _defined_, never what is _running_ — so the VPN section lists tunnels that
exist, not tunnels that are up, and says so.

**It never silently drops what it did not understand.** Every menu the analyser
does not read lands in the final section with its line number:

```
## What this document does not cover

| Menu           | What                                                    | Line |
| -------------- | ------------------------------------------------------- | ---: |
| `/queue/tree`  | 1 record(s) in a menu this analyser does not describe    |    3 |
| `/tool/netwatch` | 1 record(s) in a menu this analyser does not describe  |    5 |
```

A document about an inherited router that quietly omits the one part nobody
understood is worse than no document, because the reader believes they have the
whole picture.

## `diff_explanations` — the sleeper feature

`diff_config_snapshots` shows that a rule moved. What a reviewer needs to know
is that the forward chain stopped dropping:

```
- **[critical/security]** the `forward` chain no longer ends in a drop — anything not matched is now allowed
- **[high/security]** www lost its address restriction — it now accepts from anywhere
- **[medium/connectivity]** VLAN 40 192.0.2.0/24 was added on vlan40-guest, served by DHCP and can reach the internet through the existing NAT rule
```

Same two files. One of these you can approve or reject; the other is a wall of
`+` and `-`.

Changes are ordered most consequential first, and tagged by impact — `security`,
`connectivity`, `structure`, `cosmetic`.

```
diff_explanations before_snapshot_id=snap_abc after_snapshot_id=snap_def
```

Leaving the _after_ side out compares a snapshot against the device as it is
right now, which is how you ask "what has changed since we documented this".

## Sources

Any of the three tools reads from:

- **the live device** (default) — `/export`, a read-only print that writes no
  file and changes nothing;
- **a snapshot** — `snapshot_id` from `list_config_snapshots`, so you can explain
  the router as it was three weeks ago;
- **raw text** — `config_text`, for an export you already have.

Everything is READ. Nothing here writes to a router.
