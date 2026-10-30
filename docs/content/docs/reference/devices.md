---
title: "Devices"
description: "List the configured MikroTik devices the AI can target via the `device` argument."
---

## Tools

- [List Configured MikroTik Devices](#list_mikrotik_devices)

## list_mikrotik_devices

**List Configured MikroTik Devices** · Risk: **read**

List all MikroTik devices registered in this server's configuration (server-side metadata — no RouterOS command is run, no SSH connection is opened). Use this to discover the exact device name strings required by the `device` argument on every other tool, especially when working across multiple routers (e.g. building a tunnel between two devices). Returns each device's name, username, host, port, auth method (key / password / none), optional description, and which entry is the default. Includes Primary, ordered alternate management IPs, open connections and last connection observations. Alternate IPs must all belong to the same physical router. Automatic failover happens only while connecting; dispatched commands are never replayed. Last success is historical, not proof of a currently open session. Call this to verify the exact target before any write/destructive change when several routers are configured. Credentials and private-key material are never included in the output.

No tool-specific parameters.
