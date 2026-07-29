# Traffic Flow (NetFlow / IPFIX)

"Who is using my bandwidth?" — answered continuously and cheaply.

The router exports **flow metadata** (source, destination, ports, protocol, byte
and packet counts) to a collector; this server binds that UDP port, decodes
NetFlow v5/v9 and IPFIX, stores the records locally, and turns them into top
talkers, conversations, application mix and anomalies.

**No payload is ever carried or stored.** That is the whole trade against
[Packet Capture Studio](./packet-capture.md): the sniffer is precise, heavy and
point-in-time; flows are aggregate, cheap and continuous. They complement each
other — use flows to find _what_ is loud, the sniffer to see _why_.

Nine tools, in the **Traffic Flow** module (Tools group):

| Tool                         | Risk             | What it does                                 |
| ---------------------------- | ---------------- | -------------------------------------------- |
| `get_traffic_flow_settings`  | READ             | Current `/ip traffic-flow` config            |
| `set_traffic_flow_settings`  | WRITE_IDEMPOTENT | Enable/disable, interfaces, cache, timeouts  |
| `list_traffic_flow_targets`  | READ             | Configured collectors                        |
| `add_traffic_flow_target`    | WRITE            | Point the device at this host                |
| `remove_traffic_flow_target` | DESTRUCTIVE      | Remove a collector                           |
| `start_flow_collector`       | WRITE            | Start the local UDP receiver                 |
| `stop_flow_collector`        | WRITE            | Stop it                                      |
| `flow_top_talkers`           | READ             | Top src / dst / conversation / application   |
| `analyze_flows`              | READ             | Full report incl. protocol mix and anomalies |

There is deliberately **no** one-shot "set it all up" tool: pointing a router at
a collector means streaming a description of your network somewhere, and the
model should explain that first. That composite lives in the
[`setup-traffic-flow` prompt](./prompts.md).

## Getting started

```
start_flow_collector                       # bind UDP 2055 on this host
add_traffic_flow_target dst_address=192.168.88.50 port=2055 version=9
set_traffic_flow_settings enabled=true interfaces=all
… wait for the first template …
flow_top_talkers dimension=source window=1h
```

Order matters: start the receiver first, or the first exports are thrown away.

## The template trap

v9 and IPFIX are **template-based** — the exporter periodically describes its
field layout, and data records reference that template by id. A collector that
has not yet seen the template **cannot decode anything**, and RouterOS only
resends templates every few minutes. A naive collector started mid-stream
silently discards everything until the next refresh.

This one doesn't: undecodable data sets are buffered (bounded) and replayed the
moment their template arrives, each keeping its own packet context so a replayed
flow is still dated correctly. `templatesPending` on the collector-health strip
is the number that explains an otherwise-empty page, and every "no flows" tool
response names which of the possible causes applies.

Choose **version=9 or ipfix**. v5 has no templates, is IPv4-only, and will
silently omit every IPv6 flow.

## Timestamps

v5/v9 report flow start/end as milliseconds since the _exporter booted_, not
wall clock; they are converted using the header's `sysUpTime` and `unixSecs`.
IPFIX carries absolute milliseconds. An exporter whose clock is unset (reporting
`unixSecs=0`) would date every flow to 1970, so those flows are stamped with
their arrival time and a warning instead.

## Retention & cost

Flow volume on a busy link is unbounded, so storage is two-tiered:

| Tier             | Default retention | What it answers                     |
| ---------------- | ----------------- | ----------------------------------- |
| Raw flow records | 24 hours          | "what exactly happened at 14:03"    |
| 1-minute rollups | 30 days           | trends, timelines, long comparisons |

Plus a hard row cap (2 M by default), oldest evicted first. **Every eviction is
logged** — a silently truncated monitoring feature shows an empty chart, which
reads as "no traffic" rather than "we threw it away".

Config block:

```jsonc
{
  "flows": {
    "enabled": false, // start the collector with the server
    "port": 2055,
    "db": "~/.mikrotik-mcp/flows.db",
    "retentionHours": 24,
    "rollupDays": 30,
    "maxRows": 2000000,
  },
}
```

## Reading the analysis

`analyze_flows` reports anomalies as a **ratio against the same talker's own
baseline** from the preceding four windows, with a minimum-volume floor. Flow
volume is bursty and skewed, so a z-score over a handful of windows is mostly
noise, while "this host moved 8× its usual traffic" is actionable.

It is a volume comparison, **not a verdict**: a backup window, a game download
and data exfiltration all look the same from the outside. The report says so,
and lists the conversations behind each anomaly so the next step is obvious.

## Architecture

```
src/flows/decode.ts     PURE — v5/v9/IPFIX packet → FlowRecord[]
src/flows/templates.ts  PURE — template registry + pending-data buffer
src/flows/collector.ts  node:dgram receiver → decode → batched insert
src/flows/store.ts      bun:sqlite (dynamic import), raw + rollups, retention
src/flows/aggregate.ts  PURE — top-N, conversations, app naming, anomalies
src/tools/traffic-flow.ts  the nine tools
```

The decoder and the aggregation are pure and take plain values, so all 68 tests
run from fixture buffers with no socket and no device — non-negotiable given how
fiddly template decoding is.

The collector uses `node:dgram`, the same API the
[TZSP capture receiver](./packet-capture.md) already uses under the vendored Bun
runtime — one UDP mechanism, not two. Importing the module never binds a port.
