---
title: "Traffic Generator"
description: "Synthetic traffic: ports, streams and run control (`/tool traffic-generator`)."
---

## Tools

- [Add Traffic Generator Port](#add_traffic_generator_port)
- [List Traffic Generator Ports](#list_traffic_generator_ports)
- [Remove Traffic Generator Port](#remove_traffic_generator_port)
- [Add Traffic Generator Stream](#add_traffic_generator_stream)
- [List Traffic Generator Streams](#list_traffic_generator_streams)
- [Remove Traffic Generator Stream](#remove_traffic_generator_stream)
- [Start Traffic Generator](#start_traffic_generator)
- [Stop Traffic Generator](#stop_traffic_generator)

## add_traffic_generator_port

**Add Traffic Generator Port** · Risk: **write**

Adds a traffic-generator port (`/tool traffic-generator port add`), binding a logical name to a physical interface — required before any stream can reference that interface. For listing existing ports use list_traffic_generator_ports; for defining what to transmit on a port use add_traffic_generator_stream. Returns the newly created port's detail.

| Parameter   | Required | Definition                           |
| ----------- | -------- | ------------------------------------ |
| `name`      | Yes      | `{"type":"string"}`                  |
| `interface` | Yes      | `{"type":"string"}`                  |
| `disabled`  | Yes      | `{"default":false,"type":"boolean"}` |

## list_traffic_generator_ports

**List Traffic Generator Ports** · Risk: **read**

Lists traffic-generator port entries (`/tool traffic-generator port print`) — returns the name-to-interface bindings that streams reference. Optionally filter by name substring (name_filter). For stream definitions use list_traffic_generator_streams.

| Parameter     | Required | Definition          |
| ------------- | -------- | ------------------- |
| `name_filter` | No       | `{"type":"string"}` |

## remove_traffic_generator_port

**Remove Traffic Generator Port** · Risk: **destructive**

Removes a traffic-generator port (`/tool traffic-generator port remove`) — destroys the interface binding, which also invalidates any streams referencing it. Accepts the port name or RouterOS `.id` (e.g. `*1`) from list_traffic_generator_ports. Verifies existence before attempting removal. For removing streams use remove_traffic_generator_stream.

| Parameter | Required | Definition                                      |
| --------- | -------- | ----------------------------------------------- |
| `port_id` | Yes      | Port name or RouterOS '.id' `{"type":"string"}` |

## add_traffic_generator_stream

**Add Traffic Generator Stream** · Risk: **write**

Adds a traffic-generator stream (`/tool traffic-generator stream add`) — defines what to transmit on a named port: packet template (name of an existing packet-template to send), packet size or range, and transmit rate in bits/second. The referenced port must already exist (use add_traffic_generator_port). For listing streams use list_traffic_generator_streams; to begin transmission use start_traffic_generator. Returns the created stream's detail.

| Parameter     | Required | Definition                                                                                                           |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `name`        | Yes      | `{"type":"string"}`                                                                                                  |
| `port`        | Yes      | Traffic-generator port name `{"type":"string"}`                                                                      |
| `tx_template` | No       | Packet-template name to transmit `{"type":"string"}`                                                                 |
| `packet_size` | No       | Packet size or range `{"type":"string"}`                                                                             |
| `tx_rate`     | No       | Transmit rate in bits/second `{"type":"string"}`                                                                     |
| `num`         | No       | Stream number (0-15) `{"type":"integer","minimum":0,"maximum":15}`                                                   |
| `pps`         | No       | Target throughput in packets per second `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`  |
| `mbps`        | No       | Target throughput in megabits per second `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `comment`     | No       | `{"type":"string"}`                                                                                                  |
| `disabled`    | Yes      | `{"default":false,"type":"boolean"}`                                                                                 |

## list_traffic_generator_streams

**List Traffic Generator Streams** · Risk: **read**

Lists traffic-generator stream definitions (`/tool traffic-generator stream print`) — shows name, port binding, packet template, packet size, and transmit rate for each configured stream. Optionally filter by name substring (name_filter) or exact port name (port_filter). For port bindings use list_traffic_generator_ports.

| Parameter     | Required | Definition          |
| ------------- | -------- | ------------------- |
| `name_filter` | No       | `{"type":"string"}` |
| `port_filter` | No       | `{"type":"string"}` |

## remove_traffic_generator_stream

**Remove Traffic Generator Stream** · Risk: **destructive**

Removes a traffic-generator stream (`/tool traffic-generator stream remove`) — deletes the transmit definition without affecting the port it referenced. Accepts the stream name or RouterOS `.id` (e.g. `*1`) from list_traffic_generator_streams. Verifies existence before removal. For removing the port binding use remove_traffic_generator_port.

| Parameter   | Required | Definition                                        |
| ----------- | -------- | ------------------------------------------------- |
| `stream_id` | Yes      | Stream name or RouterOS '.id' `{"type":"string"}` |

## start_traffic_generator

**Start Traffic Generator** · Risk: **write**

Starts the traffic generator (`/tool traffic-generator start`) — begins transmitting packets for all enabled streams on their configured ports. Accepts an optional duration in seconds; omit to run until explicitly halted with stop_traffic_generator. Requires ports (add_traffic_generator_port) and streams (add_traffic_generator_stream) to be configured first.

| Parameter  | Required | Definition                                                                                                             |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `duration` | No       | Optional run duration in seconds (else runs until stopped) `{"type":"integer","minimum":1,"maximum":9007199254740991}` |

## stop_traffic_generator

**Stop Traffic Generator** · Risk: **write**

Stops a running traffic generator (`/tool traffic-generator stop`) — halts all active stream transmission immediately. Use when a timed run (start_traffic_generator with duration) needs to be aborted early, or when the generator was started without a duration limit.

No tool-specific parameters.
