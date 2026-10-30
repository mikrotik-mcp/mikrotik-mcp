---
title: "Management address failover"
description: "Primary and fallback addresses, connection memory and safe retry boundaries."
---

In **Devices → Add device / Edit settings → Connection**, add internal, VPN or public static IPs
and choose **Primary**. The existing `host` is Primary; `fallbackHosts` holds up to seven
alternate IPv4/IPv6 addresses in priority order. All addresses must reach the **same router**,
using its shared SSH/REST ports, credentials and jump-host configuration.

```json
{
  "host": "10.10.10.1",
  "fallbackHosts": ["203.0.113.10", "2001:db8::10"],
  "port": 22,
  "username": "admin",
  "keyFilename": "/keys/home"
}
```

- A successful connection remembers its IP for **5 minutes**, separately for each device and
  transport/port. New connections try that IP first; each successful connection renews the window.
  Failure clears the preference immediately. Without a cached success, Primary and then alternatives
  are tried in order, with a 30-second cooldown for failed addresses. Healthy pooled/Safe Mode sessions
  stay open even after expiry; commands already dispatched are never replayed on another IP.
- Device cards automatically refresh address observations every 4 seconds: open connections,
  remembered IP and remaining preference time, last failures, and untested addresses. These are real
  connection observations, not continuous probes of unused addresses. Primary is never rewritten;
  preference is in-memory and resets on server restart or device configuration replacement.
- SSH, SSH jump devices, SFTP, initial Safe Mode setup, REST probes and dashboard tests use this
  selection. Authentication/key errors stop that connection attempt; MAC-Telnet has no IP failover.
- Device cards and `list_mikrotik_devices` distinguish **Connected**, historical success, failed
  attempts and untested addresses. **Test connection / Connect & Save** reports the IP that authenticated.
- Failover happens **before command dispatch**. A lost command response is not automatically replayed
  on another IP or over SSH. An active Safe Mode transaction never migrates between connections.
- Existing single-address configurations remain valid. No router interface, routing or firewall
  settings are changed by adding management addresses to MCP.
