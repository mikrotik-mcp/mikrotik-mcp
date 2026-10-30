---
title: "Flow collector health"
description: "Practical setup, operations and limits for Flow collector health."
---

Open **Flows → Collector → Exporter signals**, or call `get_flow_collector_health`.
Each exporter/protocol/observation-domain has independent last-received, records,
decode-error, pending-template and template-layout-change counters. An identical
template refresh is not a layout change. Invalid headers cannot consume exporter
slots; the collector caps namespaces at 128.

NetFlow v9 sequence gaps are observed gaps, not confirmed loss: UDP delivery can
reorder, duplicate, or restart. Wraparound is handled. IPFIX sequence numbers count
data records, including options records, so no loss estimate is fabricated from
decoded flow counts. Silence for five minutes is a diagnostic hint, not an outage
verdict. Sampling, FastTrack and hardware offload can hide traffic independently
of collector health.

Failed storage batches are counted and shown as an incomplete-data warning. These
records cannot be recovered by refreshing the dashboard. All health counters are
process-local and reset at collector start; historical flow retention is unchanged.
This feature does not start exports or alter any router configuration.
