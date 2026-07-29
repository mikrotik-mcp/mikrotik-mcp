---
name: setup-traffic-flow
title: Set up continuous traffic analytics (NetFlow/IPFIX)
description: Enable /ip traffic-flow, point the router at this host's collector, and start answering "who is using my bandwidth" continuously — cheap flow metadata, no packet payload.
arguments:
  - name: collector_address
    description: The IP address of THIS MCP host as the router sees it (e.g. 192.168.88.50). If omitted, work it out from the router's neighbour/ARP table or ask.
    required: false
  - name: interfaces
    description: Which interfaces to sample (e.g. "ether1", "bridge"). Defaults to all.
    required: false
---

Set up continuous traffic-flow analytics for this MikroTik device.

Collector address: {{collector_address}}
Interfaces to sample: {{interfaces}}

**Explain this before you do it.** Traffic Flow makes the router export a
continuous stream of flow records — source and destination address, ports,
protocol, byte and packet counts — to a collector over UDP. It carries **no
packet payload**, which is exactly why it is cheap and privacy-preserving next
to the packet sniffer, but it is still a description of who on the network talks
to whom, sent continuously to a host. Say where it will be sent, and confirm the
address is one the user controls.

Follow these steps:

1. **Look before you write.** `get_traffic_flow_settings` and
   `list_traffic_flow_targets` — flow export may already be on and pointed
   somewhere. If a target already exists that is NOT this host, mention it
   rather than silently adding a second.

2. **Work out the collector address.** It must be this MCP host's address _as
   the router sees it_ — not `127.0.0.1`, which would make the router export to
   itself. If it was not supplied, look at the router's `/ip address` and
   neighbour tables to find the management subnet, and confirm the choice with
   the user rather than guessing.

3. **Start the receiver first.** `start_flow_collector` (default UDP 2055).
   Starting the exporter before the collector just throws the first minutes of
   data away.

4. **Point the device at it.** `add_traffic_flow_target` with
   `dst_address=<collector>`, `port=2055`, `version=9`. Use **9 or ipfix** —
   v5 is IPv4-only and has no template mechanism, so IPv6 flows would be missing
   entirely. A short `v9_template_timeout` (e.g. `30s`) makes the first decoded
   flows appear sooner.

5. **Enable export.** `set_traffic_flow_settings` with `enabled=true` and the
   requested `interfaces` (default all). Mention the two timeouts:
   `active_flow_timeout` (default 30m) is how long a long-lived flow is held
   before being reported — lower it if the user wants fresher numbers and can
   accept more export traffic.

6. **Wait for the first template, then verify.** v9/IPFIX exporters send the
   template periodically and data records are undecodable until it arrives, so
   the first minute or two can legitimately be empty. Then run
   `flow_top_talkers` — if it is still empty, its output names the reason
   (collector not running, nothing received, templates pending, decode errors);
   act on that rather than guessing.

7. **Report what they now have.** Top talkers for the last window, and where to
   look next: `analyze_flows` for the full report, the dashboard's **Flows**
   page for the live view.

To undo all of this later: `remove_traffic_flow_target`,
`set_traffic_flow_settings enabled=false`, `stop_flow_collector`.
