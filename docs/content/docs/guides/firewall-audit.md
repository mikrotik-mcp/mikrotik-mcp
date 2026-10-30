---
title: "Firewall Audit & Explainer"
description: "Practical setup, operations and limits for Firewall Audit & Explainer."
---

Makes a router's most security-critical and most error-prone subsystem legible.
`firewall_audit` pulls the filter (and optionally NAT/mangle) rulesets and runs a
structured analysis, returning a plain-language report, a risk score, and — in
MCP App hosts — an interactive findings table with one-click fixes.

One tool, in the **Firewall — Audit** module (Security):

```
firewall_audit                    # filter (+ NAT) audit
firewall_audit include_mangle=true
```

## What it detects

| Finding                         | Meaning                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unreachable / shadowed rule** | A terminal earlier rule already matches everything this rule would (set-containment over the match conditions, with real CIDR containment for addresses, IPv4 **and** IPv6). |
| **Overly-broad accept**         | An `accept` that matches all traffic in a chain, bypassing every rule after it.                                                                                              |
| **Missing default-drop**        | The `input`/`forward` chain has no catch-all drop — RouterOS's default policy is **accept**, so anything not explicitly handled is allowed.                                  |
| **Duplicate rule**              | Two enabled rules with identical match + action.                                                                                                                             |
| **Dead rule**                   | Enabled but 0 packets since the counters last reset — possibly unused.                                                                                                       |

Each finding carries a plain-language explanation ("Rule 7 can never match — rule
3 already accepts all traffic it would, earlier in the input chain"), a suggested
fix, and a severity. The report includes a **0–100 risk score** and a grade.

The shadowing analysis is **sound** (no false positives): it only treats a rule
as a shadower when its match set provably contains the later rule's, and it
excludes non-deterministic matchers (`limit=`, `random=`, `nth=`,
`connection-bytes=`, …) that only match _sometimes_.

## The interactive table (MCP Apps)

In a host that renders MCP Apps (Claude, ChatGPT), `firewall_audit` also returns
a `firewall-audit` view: a risk gauge, severity counts, and a card per finding
with the offending rule and a **one-click "Disable rule N"** button that calls
`disable_filter_rule` / `disable_nat_rule` and re-audits. Text-only hosts get the
full plain-text report.
