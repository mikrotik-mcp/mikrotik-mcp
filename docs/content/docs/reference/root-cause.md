---
title: "Root-Cause Analyzer"
description: "Intelligent root-cause diagnosis: autonomously investigates across connectivity, interfaces, routing (BGP/OSPF), firewall, NAT, ARP/DHCP, DNS, system resources, logs, and VPN — correlates evidence into ranked hypotheses with fix commands."
---

## Tools

- [Intelligent Root-Cause Diagnosis](#diagnose)
- [Trace Network Path](#trace_path)
- [Correlate System Events](#correlate_events)
- [Suggest Fix Commands](#suggest_fix)

## diagnose

**Intelligent Root-Cause Diagnosis** · Risk: **read**

Autonomously investigate a network problem across all diagnostic dimensions: connectivity (ping), interface state & error counters, routing table & BGP/OSPF neighbors, firewall rules & hit counters, NAT & connection tracking, ARP/DHCP state, DNS resolution, CPU/memory pressure, system logs, and VPN tunnel state — including the tunnel MTU / TCP-MSS-clamp / WireGuard-keepalive checks that catch a PMTU black hole (tunnel pings fine but large transfers, uploads and some HTTPS hang). Correlates the evidence to deliver ranked root-cause hypotheses with confidence levels, plain-language explanations, and exact RouterOS fix commands. Pass an IP address, hostname, or symptom description as the target. For hop-by-hop path analysis use `trace_path`; for log-specific investigation use `correlate_events`; for fix commands only use `suggest_fix`.

| Parameter    | Required | Definition                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`     | Yes      | The target to investigate — an IP address (e.g. '8.8.8.8'), hostname (e.g. 'google.com'), or network/subnet (e.g. '10.0.0.0/24'). `{"type":"string"}`                                                                                                                                                                                                            |
| `dimensions` | No       | Limit investigation to specific dimensions. Omit to check all: connectivity, interfaces, routing, firewall, nat, arp_dhcp, dns, resources, logs, vpn `{"type":"array","items":{"type":"string","enum":["connectivity","interfaces","routing","firewall","nat","arp_dhcp","dns","resources","logs","vpn"],"description":"Diagnostic dimension to investigate."}}` |
| `symptom`    | No       | Free-text symptom description (e.g. 'client cannot reach internet', 'VPN tunnel keeps dropping', 'slow throughput'). `{"type":"string"}`                                                                                                                                                                                                                         |

## trace_path

**Trace Network Path** · Risk: **read**

Trace the full network path from this device to a destination with hop-by-hop analysis. Runs a traceroute, then for each hop that is a locally-connected device, checks interface state and routing. Also runs a parallel ping to measure end-to-end reachability and latency. Use for path-specific troubleshooting — where packets are being dropped or rerouted. For full multi-dimensional root-cause analysis use `diagnose`.

| Parameter | Required | Definition                                                                             |
| --------- | -------- | -------------------------------------------------------------------------------------- |
| `target`  | Yes      | Destination IP or hostname to trace to. `{"type":"string"}`                            |
| `count`   | Yes      | Probes per hop (default: 3). `{"default":3,"type":"integer","minimum":1,"maximum":10}` |
| `use_dns` | Yes      | Resolve hop addresses to hostnames. `{"default":true,"type":"boolean"}`                |

## correlate_events

**Correlate System Events** · Risk: **read**

Search and correlate system log events across topics (firewall, DHCP, routing, system, interface) to find patterns around a given time window or keyword. Groups related events chronologically and highlights sequences that indicate cascading failures (e.g. interface down → OSPF neighbor lost → route withdrawn). For full root-cause analysis use `diagnose`; for path tracing use `trace_path`.

| Parameter     | Required | Definition                                                                                                                                              |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyword`     | No       | Filter logs by keyword (IP address, interface name, error message). Omit to show all error/warning/critical events. `{"type":"string"}`                 |
| `topics`      | No       | Comma-separated log topics to search (e.g. 'firewall,dhcp,system'). Default: error, warning, critical, firewall, system, interface. `{"type":"string"}` |
| `time_window` | Yes      | How far back to search: '10m', '1h', '6h', '1d' (default: 30m). `{"default":"30m","type":"string"}`                                                     |
| `limit`       | Yes      | Maximum log entries to return (default: 100). `{"default":100,"type":"integer","minimum":1,"maximum":500}`                                              |

## suggest_fix

**Suggest Fix Commands** · Risk: **read**

Run a quick diagnosis and return ONLY the actionable fix commands — no verbose report. Useful when you already know the symptom and just need the remediation steps. Each fix command comes with a one-line explanation of what it addresses. For the full diagnostic report use `diagnose`.

| Parameter    | Required | Definition                                                                                                                                                                                                                                              |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`     | Yes      | Target to investigate (IP, hostname, or subnet). `{"type":"string"}`                                                                                                                                                                                    |
| `dimensions` | No       | Limit investigation to specific dimensions. `{"type":"array","items":{"type":"string","enum":["connectivity","interfaces","routing","firewall","nat","arp_dhcp","dns","resources","logs","vpn"],"description":"Diagnostic dimension to investigate."}}` |
