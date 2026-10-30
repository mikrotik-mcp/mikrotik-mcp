---
title: "Network Tools"
description: "ping, traceroute, bandwidth-test, DNS resolve, netwatch (`/tool`)."
---

## Tools

- [Ping Host via Router](#ping)
- [Traceroute to Host](#traceroute)
- [Run Bandwidth Test](#bandwidth_test)
- [Resolve DNS Name on Device](#resolve_dns)
- [Add Netwatch Host Monitor](#add_netwatch)
- [List Netwatch Host Monitor Entries](#list_netwatch)
- [Get Netwatch Entry Detail](#get_netwatch)
- [Remove Netwatch Host Monitor Entry](#remove_netwatch)

## ping

**Ping Host via Router** · Risk: **read**

Sends ICMP echo requests to a target host (`/ping`) from the RouterOS device — use to verify reachability or measure round-trip latency from the router's vantage point. Output is a single bounded run of `count` packets (1–100, default 4); it does not stream continuously. Optional `interface` pins egress to a specific interface; `src_address` sets the source IP for the probe. Returns packet statistics (sent/received/loss/RTT) or a failure message if unreachable. For hop-by-hop path discovery use `traceroute`; for throughput measurement use `bandwidth_test`.

| Parameter     | Required | Definition                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `address`     | Yes      | Target host or IP to ping `{"type":"string"}`                                                    |
| `count`       | Yes      | Number of echo requests (1-100) `{"default":4,"type":"integer","minimum":1,"maximum":100}`       |
| `interface`   | No       | Outgoing interface `{"type":"string"}`                                                           |
| `src_address` | No       | Source address to ping from `{"type":"string"}`                                                  |
| `size`        | No       | Packet size in bytes `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## traceroute

**Traceroute to Host** · Risk: **read**

Traces the network path to a target host hop by hop (`/tool traceroute`) — use to diagnose routing problems or identify where packets are dropped between the router and a destination. Output is a bounded run of `count` probes per hop (default 3; keep small to prevent long runtimes). Set `use_dns=true` to resolve hop addresses to hostnames. Returns a hop-by-hop list with RTTs, or an error if the command fails. For simple reachability checks use `ping`; for throughput measurement use `bandwidth_test`.

| Parameter | Required | Definition                                                                                                                                     |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `address` | Yes      | Target host or IP to trace `{"type":"string"}`                                                                                                 |
| `count`   | Yes      | Number of probes per hop (keep small to bound the run) `{"default":3,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `use_dns` | No       | Resolve hop addresses to names `{"type":"boolean"}`                                                                                            |

## bandwidth_test

**Run Bandwidth Test** · Risk: **read**

Runs a RouterOS throughput test to a remote host (`/tool bandwidth-test`) — use to measure available bandwidth between the router and a target that must be running the RouterOS bandwidth-test server. `direction` controls traffic flow: `receive` (download from server), `transmit` (upload to server), or `both`. `duration` (default 5 s) bounds the run so it terminates; it does not run indefinitely. `protocol` is `tcp` (default) or `udp`. Supply `user`/`password` if the remote server requires authentication. Returns throughput results or a failure message if the remote end is unreachable or not running the bandwidth-test server. For reachability checks use `ping`; for path diagnostics use `traceroute`.

| Parameter   | Required | Definition                                                                                                       |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `address`   | Yes      | Target running a bandwidth-test server `{"type":"string"}`                                                       |
| `duration`  | Yes      | Test duration in seconds `{"default":5,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `direction` | Yes      | `{"default":"receive","type":"string","enum":["receive","transmit","both"]}`                                     |
| `user`      | No       | Username for the bandwidth-test server `{"type":"string"}`                                                       |
| `password`  | No       | Password for the bandwidth-test server `{"type":"string"}`                                                       |
| `protocol`  | Yes      | `{"default":"tcp","type":"string","enum":["tcp","udp"]}`                                                         |

## resolve_dns

**Resolve DNS Name on Device** · Risk: **read**

Resolves a DNS hostname to an IP address (`[:resolve]`) using the RouterOS device's configured system resolver — use to verify that DNS resolution works correctly from the router's own perspective. The optional `server` IP directs the query to that DNS server instead of the system resolver; explicit-server queries are not cached by RouterOS. Returns the resolved IP address string, or an error if resolution fails. For managing static DNS entries on the device use `add_dns_static`.

| Parameter | Required | Definition                                                                                         |
| --------- | -------- | -------------------------------------------------------------------------------------------------- |
| `name`    | Yes      | DNS name to resolve, e.g. 'example.com' `{"type":"string","minLength":1}`                          |
| `server`  | No       | Specific DNS server IP to query; defaults to the system resolver `{"type":"string","minLength":1}` |

## add_netwatch

**Add Netwatch Host Monitor** · Risk: **write**

Creates a host-monitoring entry (`/tool netwatch add`) that probes a host at a set interval and runs RouterOS scripts on up/down state transitions — use to trigger automated responses (e.g. failover scripts) when a host becomes reachable or unreachable. `interval` and `timeout` accept RouterOS time strings (e.g. `'00:00:10'`). `up_script` and `down_script` are inline RouterOS script strings executed on state change. Returns the detail of the created entry, confirmed by a follow-up `/tool netwatch print detail` lookup. To view existing entries use `list_netwatch`; to inspect one entry's detail use `get_netwatch`; to delete use `remove_netwatch`.

| Parameter     | Required | Definition                                                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `host`        | Yes      | Host to monitor `{"type":"string"}`                                                                                |
| `type`        | No       | Probe type: simple, icmp, tcp-conn, or http-get `{"type":"string","enum":["simple","icmp","tcp-conn","http-get"]}` |
| `port`        | No       | Target port (tcp-conn/http-get types) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`  |
| `src_address` | No       | Source address for the probe `{"type":"string"}`                                                                   |
| `interval`    | No       | Probe interval, e.g. '00:00:10' `{"type":"string"}`                                                                |
| `timeout`     | No       | Probe timeout, e.g. '00:00:01' `{"type":"string"}`                                                                 |
| `up_script`   | No       | Script to run when the host comes up `{"type":"string"}`                                                           |
| `down_script` | No       | Script to run when the host goes down `{"type":"string"}`                                                          |
| `comment`     | No       | `{"type":"string"}`                                                                                                |
| `disabled`    | Yes      | `{"default":false,"type":"boolean"}`                                                                               |

## list_netwatch

**List Netwatch Host Monitor Entries** · Risk: **read**

Returns all netwatch host-monitoring entries (`/tool netwatch print`) — use to review which hosts are being probed and their current up/down status. Optionally filter by partial hostname with `host_filter`. Returns the full netwatch table, or a message if no entries match. For a single entry's full configuration detail use `get_netwatch`; to create an entry use `add_netwatch`; to delete one use `remove_netwatch`.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `host_filter` | No       | Partial host match `{"type":"string"}` |

## get_netwatch

**Get Netwatch Entry Detail** · Risk: **read**

Returns full detail for a single netwatch host-monitoring entry (`/tool netwatch print detail where host=`) — use to inspect the current up/down status, probe interval, timeout, and up/down scripts for one monitored host. Looks up by exact `host` value (same string used in `add_netwatch`). Returns the detailed record, or a not-found message if no entry matches. For a summary list of all entries use `list_netwatch`; to delete this entry use `remove_netwatch`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `host`    | Yes      | `{"type":"string"}` |

## remove_netwatch

**Remove Netwatch Host Monitor Entry** · Risk: **destructive**

Permanently removes a netwatch host-monitoring entry (`/tool netwatch remove [find host=]`) — use to stop monitoring a host and delete its associated up/down scripts. Performs a `count-only` existence check first and returns an error if no entry matches the given `host`. Takes the exact `host` value (same string used in `add_netwatch`). To review entries before deleting use `list_netwatch` or `get_netwatch`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `host`    | Yes      | `{"type":"string"}` |
