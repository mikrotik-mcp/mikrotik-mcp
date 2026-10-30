---
title: "Speed Test"
description: "Latency/throughput test to another RouterOS (`/tool speed-test`)."
---

## Tools

- [Run RouterOS Speed Test](#speed_test)

## speed_test

**Run RouterOS Speed Test** · Risk: **read**

Runs a bandwidth and latency speed test from the router to a target RouterOS device (`/tool speed-test`) — measures ping, jitter, and TCP/UDP throughput between two MikroTik/RouterOS nodes. The target `address` must be a reachable RouterOS device; this is NOT a general ICMP ping/traceroute (for that use the ping or traceroute tools). The tool automatically runs both directions (receive and transmit) — there is no direction selector on `/tool speed-test`. Each sub-test runs for `duration` seconds (the tool runs ping + TCP recv/send + UDP recv/send, so total wall time is a few times this). `connection_count` sets the number of parallel streams (default 20, or the core count if higher). Optional `user`/`password` authenticate to the remote device. Returns measured throughput and latency figures.

| Parameter          | Required | Definition                                                                                                                               |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `address`          | Yes      | Target RouterOS device address `{"type":"string"}`                                                                                       |
| `duration`         | Yes      | Per-test duration in seconds (maps to RouterOS `test-duration`) `{"default":10,"type":"integer","minimum":1,"maximum":9007199254740991}` |
| `connection_count` | No       | Parallel connections to use (RouterOS `connection-count`, default 20) `{"type":"integer","minimum":1,"maximum":9007199254740991}`        |
| `user`             | No       | Username for the target device `{"type":"string"}`                                                                                       |
| `password`         | No       | Password for the target device `{"type":"string"}`                                                                                       |
