---
title: "Traffic Flow"
description: "NetFlow/IPFIX export (`/ip traffic-flow`) plus the host-side collector and analytics: top talkers, conversations, application mix and anomalies — cheap continuous metadata, no payload."
---

## Tools

- [Inspect Flow Collector Health](#get_flow_collector_health)
- [Get Traffic Flow Settings](#get_traffic_flow_settings)
- [Set Traffic Flow Settings](#set_traffic_flow_settings)
- [List Traffic Flow Targets](#list_traffic_flow_targets)
- [Add Traffic Flow Target](#add_traffic_flow_target)
- [Remove Traffic Flow Target](#remove_traffic_flow_target)
- [Start Local Flow Collector](#start_flow_collector)
- [Stop Local Flow Collector](#stop_flow_collector)
- [Flow Top Talkers](#flow_top_talkers)
- [Analyze Traffic Flows](#analyze_flows)

## get_flow_collector_health

**Inspect Flow Collector Health** · Risk: **read**

Reads host collector health per exporter, protocol and observation domain: last receipt, template changes, pending templates, decode errors and failed storage writes. NetFlow v9 sequence gaps are observations, not proven packet loss (UDP can reorder). IPFIX loss is not estimated. Silent >5m means no exports received, not proof the router is offline. Counters reset when the collector restarts. No router changes.

No tool-specific parameters.

## get_traffic_flow_settings

**Get Traffic Flow Settings** · Risk: **read**

Reads `/ip traffic-flow` — whether NetFlow/IPFIX export is enabled, which interfaces are sampled, the cache size and the active/inactive flow timeouts. Traffic Flow is the cheap, continuous alternative to the packet sniffer: it exports flow METADATA (who talked to whom, how much) and never any payload. To see where the flows are sent use list_traffic_flow_targets; to change these settings use set_traffic_flow_settings.

No tool-specific parameters.

## set_traffic_flow_settings

**Set Traffic Flow Settings** · Risk: **write-idempotent**

Configures `/ip traffic-flow` — enable/disable export, choose interfaces, and tune the flow cache and timeouts. Idempotent: setting the same values twice changes nothing. `active_flow_timeout` (default 30m) caps how long a long-lived flow is held before it is reported, so a lower value gives fresher data at the cost of more exports; `inactive_flow_timeout` (default 15s) is how quickly a finished flow is flushed. `cache_entries` bounds device memory — raise it on a busy router that reports dropped flows. Enabling export alone does nothing until a collector target exists (add_traffic_flow_target).

| Parameter               | Required | Definition                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------------ |
| `enabled`               | No       | Turn flow export on or off `{"type":"boolean"}`                                |
| `interfaces`            | No       | Interface list, or "all" (default). e.g. "ether1,bridge" `{"type":"string"}`   |
| `cache_entries`         | No       | Flow cache size, e.g. "4k", "16k" — bound on device memory `{"type":"string"}` |
| `active_flow_timeout`   | No       | e.g. "30m" — report long flows sooner `{"type":"string"}`                      |
| `inactive_flow_timeout` | No       | e.g. "15s" `{"type":"string"}`                                                 |

## list_traffic_flow_targets

**List Traffic Flow Targets** · Risk: **read**

Lists the collectors the device exports flows to (`/ip traffic-flow target print`) — each target's destination address, port and NetFlow version. Use this to confirm the device is pointed at this MCP host before wondering why the Flows page is empty. To add one use add_traffic_flow_target.

No tool-specific parameters.

## add_traffic_flow_target

**Add Traffic Flow Target** · Risk: **write**

Points the device at a flow collector (`/ip traffic-flow target add`) — normally THIS MCP host, so the flows land in the local collector and the Flows dashboard. `version` should be **9 or ipfix**: v5 is IPv4-only and has no template mechanism, so IPv6 flows are simply absent from it. The device will send flow metadata (addresses, ports, byte counts — never payload) to `dst_address` continuously, so point it somewhere you control. Start the local receiver first with start_flow_collector, or the exports go nowhere.

| Parameter             | Required | Definition                                                                                                       |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `dst_address`         | Yes      | Collector IP — the address of this MCP host as the router sees it `{"type":"string"}`                            |
| `port`                | Yes      | Collector UDP port `{"default":2055,"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}`           |
| `version`             | Yes      | Export version; prefer 9 or ipfix `{"default":"9","type":"string","enum":["1","5","9","ipfix"]}`                 |
| `v9_template_refresh` | No       | Packets between template resends (v9/IPFIX) `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}` |
| `v9_template_timeout` | No       | Time between template resends, e.g. "30s" — lower means faster first decode `{"type":"string"}`                  |

## remove_traffic_flow_target

**Remove Traffic Flow Target** · Risk: **destructive**

Removes a flow collector target (`/ip traffic-flow target remove`), stopping export to that address. Verifies the target exists first. Removing every target leaves flow export enabled but going nowhere — to stop collection entirely also set enabled=no with set_traffic_flow_settings.

| Parameter     | Required | Definition                                                    |
| ------------- | -------- | ------------------------------------------------------------- |
| `dst_address` | Yes      | Collector address of the target to remove `{"type":"string"}` |

## start_flow_collector

**Start Local Flow Collector** · Risk: **write**

Starts the MCP host's UDP collector so exported NetFlow/IPFIX packets are decoded and stored locally. Nothing on the router changes — this is the receiving half. Point the device at this host with add_traffic_flow_target (same port). Records are kept per the `flows` config (24 h raw, 30 d of 1-minute rollups by default) and contain no payload. Reports the listening port and current health counters; stop with stop_flow_collector.

| Parameter | Required | Definition                                                                                                                               |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `port`    | No       | UDP port to listen on (defaults to the configured flows.port, 2055) `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}` |

## stop_flow_collector

**Stop Local Flow Collector** · Risk: **write**

Stops the local UDP flow collector and releases the port. Already-collected flows stay in the store and remain queryable; anything the device exports while stopped is lost. The device keeps exporting until you also remove its target (remove_traffic_flow_target).

No tool-specific parameters.

## flow_top_talkers

**Flow Top Talkers** · Risk: **read**

Ranks collected flows by bytes over a window — the direct answer to 'who is using my bandwidth'. Group by `source`, `destination`, `conversation` (an address pair) or `application` (well-known port naming). Needs the local collector running and the device exporting to it; if the result is empty the tool explains which of those is missing. For a fuller narrative including protocol mix and anomalies use analyze_flows.

| Parameter   | Required | Definition                                                                                                          |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `dimension` | Yes      | What to rank by `{"default":"source","type":"string","enum":["source","destination","conversation","application"]}` |
| `window`    | Yes      | How far back to look `{"default":"1h","type":"string","enum":["5m","15m","1h","6h","24h"]}`                         |
| `limit`     | Yes      | `{"default":10,"type":"integer","exclusiveMinimum":0,"maximum":100}`                                                |
| `address`   | No       | Restrict to flows touching this address `{"type":"string"}`                                                         |

## analyze_flows

**Analyze Traffic Flows** · Risk: **read**

A rendered traffic report over the collected flows: top talkers, busiest conversations with the applications inside them, protocol mix, and anomalies — talkers well above their own baseline from the preceding period, or ones never seen before. This is the tool to reach for when asked 'what is using the bandwidth', 'is anything unusual on the network', or 'what is that host doing'. Reads only the local flow store; no device command is issued.

| Parameter       | Required | Definition                                                                                          |
| --------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `window`        | Yes      | How far back to look `{"default":"1h","type":"string","enum":["5m","15m","1h","6h","24h"]}`         |
| `address`       | No       | Focus the whole report on one address `{"type":"string"}`                                           |
| `anomaly_ratio` | Yes      | Flag a talker at this multiple of its baseline `{"default":3,"type":"number","exclusiveMinimum":0}` |
