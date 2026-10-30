---
title: "RADIUS"
description: "RADIUS client servers, incoming CoA, counters (`/radius`)."
---

## Tools

- [Add RADIUS Server Entry](#add_radius_server)
- [List RADIUS Server Entries](#list_radius_servers)
- [Get RADIUS Server Entry Detail](#get_radius_server)
- [Update RADIUS Server Entry](#update_radius_server)
- [Remove RADIUS Server Entry](#remove_radius_server)
- [Enable RADIUS Server Entry](#enable_radius_server)
- [Disable RADIUS Server Entry](#disable_radius_server)
- [Get RADIUS Incoming (CoA) Settings](#get_radius_incoming)
- [Set RADIUS Incoming (CoA) Settings](#set_radius_incoming)
- [Reset RADIUS Counters](#reset_radius_counters)

## add_radius_server

**Add RADIUS Server Entry** · Risk: **write**

Adds a RADIUS server entry (`/radius add`) — configures the router as a RADIUS client that authenticates PPP users, hotspot clients, wireless stations, DHCP leases, login sessions, IPsec peers, or dot1x supplicants against an external RADIUS server. For listing existing entries use `list_radius_servers`. Returns the created entry's detail with the shared secret redacted. `service` is a comma-separated list, e.g. `"login,ppp,hotspot,wireless,dhcp,ipsec,dot1x"`; `timeout` is a RouterOS duration string, e.g. `"300ms"`; default authentication port is 1812 and accounting port is 1813.

| Parameter             | Required | Definition                                                                                            |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `address`             | Yes      | RADIUS server IP address or hostname `{"type":"string"}`                                              |
| `secret`              | Yes      | Shared secret used with the RADIUS server `{"type":"string"}`                                         |
| `service`             | Yes      | Comma-separated services, e.g. "login,ppp,hotspot,wireless,dhcp,ipsec,dot1x" `{"type":"string"}`      |
| `authentication_port` | Yes      | `{"default":1812,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`            |
| `accounting_port`     | Yes      | `{"default":1813,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`            |
| `timeout`             | No       | Request timeout, e.g. "300ms" `{"type":"string"}`                                                     |
| `src_address`         | No       | `{"type":"string"}`                                                                                   |
| `realm`               | No       | `{"type":"string"}`                                                                                   |
| `called_id`           | No       | `{"type":"string"}`                                                                                   |
| `domain`              | No       | `{"type":"string"}`                                                                                   |
| `protocol`            | No       | Transport protocol used to reach the server (default udp) `{"type":"string","enum":["udp","radsec"]}` |
| `certificate`         | No       | Certificate name to present when protocol is radsec `{"type":"string"}`                               |
| `accounting_backup`   | Yes      | Mark this entry as a backup accounting server `{"default":false,"type":"boolean"}`                    |
| `comment`             | No       | `{"type":"string"}`                                                                                   |
| `disabled`            | Yes      | `{"default":false,"type":"boolean"}`                                                                  |

## list_radius_servers

**List RADIUS Server Entries** · Risk: **read**

Lists all configured RADIUS server entries (`/radius print`) — the router's RADIUS client table. Optionally filter by partial service name or partial address string. Returns all matching entries with shared secrets redacted; use the `.id` values from this output with `get_radius_server`, `update_radius_server`, `remove_radius_server`, `enable_radius_server`, or `disable_radius_server`.

| Parameter        | Required | Definition                                |
| ---------------- | -------- | ----------------------------------------- |
| `service_filter` | No       | Partial service match `{"type":"string"}` |
| `address_filter` | No       | Partial address match `{"type":"string"}` |

## get_radius_server

**Get RADIUS Server Entry Detail** · Risk: **read**

Retrieves full detail of a single RADIUS server entry (`/radius print detail where .id=`) — use when you need the exact current configuration of one entry. The `radius_id` is the `.id` returned by `list_radius_servers` (e.g. `'*1'`). Returns the entry's full field set with the shared secret redacted. For a summary list of all entries use `list_radius_servers`.

| Parameter   | Required | Definition                                               |
| ----------- | -------- | -------------------------------------------------------- |
| `radius_id` | Yes      | RADIUS entry internal .id, e.g. '*1' `{"type":"string"}` |

## update_radius_server

**Update RADIUS Server Entry** · Risk: **write-idempotent**

Updates one or more fields on an existing RADIUS server entry (`/radius set <id>`) — use to change the address, shared secret, services, ports, timeout, realm, or enabled state without recreating the entry. The `radius_id` is the `.id` returned by `list_radius_servers`. Returns the updated entry's full detail with the shared secret redacted. To create a new entry use `add_radius_server`; to toggle enabled state only use `enable_radius_server` or `disable_radius_server`.

| Parameter             | Required | Definition                                                                                            |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `radius_id`           | Yes      | RADIUS entry internal .id, e.g. '*1' `{"type":"string"}`                                              |
| `address`             | No       | `{"type":"string"}`                                                                                   |
| `secret`              | No       | `{"type":"string"}`                                                                                   |
| `service`             | No       | `{"type":"string"}`                                                                                   |
| `authentication_port` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                           |
| `accounting_port`     | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                           |
| `timeout`             | No       | `{"type":"string"}`                                                                                   |
| `src_address`         | No       | `{"type":"string"}`                                                                                   |
| `realm`               | No       | `{"type":"string"}`                                                                                   |
| `called_id`           | No       | `{"type":"string"}`                                                                                   |
| `domain`              | No       | `{"type":"string"}`                                                                                   |
| `protocol`            | No       | Transport protocol used to reach the server (default udp) `{"type":"string","enum":["udp","radsec"]}` |
| `certificate`         | No       | Certificate name to present when protocol is radsec `{"type":"string"}`                               |
| `accounting_backup`   | No       | Mark this entry as a backup accounting server `{"type":"boolean"}`                                    |
| `comment`             | No       | `{"type":"string"}`                                                                                   |
| `disabled`            | No       | `{"type":"boolean"}`                                                                                  |

## remove_radius_server

**Remove RADIUS Server Entry** · Risk: **destructive**

Permanently deletes a RADIUS server entry (`/radius remove [find .id=...]`) — use when an external RADIUS server is decommissioned or should no longer be used for any service. The `radius_id` is the `.id` returned by `list_radius_servers`. Performs an existence check before removal and reports if the entry is not found. To temporarily stop using a server without deleting it use `disable_radius_server`.

| Parameter   | Required | Definition                                               |
| ----------- | -------- | -------------------------------------------------------- |
| `radius_id` | Yes      | RADIUS entry internal .id, e.g. '*1' `{"type":"string"}` |

## enable_radius_server

**Enable RADIUS Server Entry** · Risk: **write-idempotent**

Re-enables a previously disabled RADIUS server entry (`/radius enable [find .id=...]`) — the router resumes sending authentication/accounting requests to this server for the services it covers. The `radius_id` is the `.id` returned by `list_radius_servers`. To disable without deleting use `disable_radius_server`; to remove permanently use `remove_radius_server`.

| Parameter   | Required | Definition                                               |
| ----------- | -------- | -------------------------------------------------------- |
| `radius_id` | Yes      | RADIUS entry internal .id, e.g. '*1' `{"type":"string"}` |

## disable_radius_server

**Disable RADIUS Server Entry** · Risk: **write-idempotent**

Disables a RADIUS server entry without removing it (`/radius disable [find .id=...]`) — the router stops sending authentication/accounting requests to this server but preserves its configuration for later re-activation. The `radius_id` is the `.id` returned by `list_radius_servers`. To re-enable use `enable_radius_server`; to delete permanently use `remove_radius_server`.

| Parameter   | Required | Definition                                               |
| ----------- | -------- | -------------------------------------------------------- |
| `radius_id` | Yes      | RADIUS entry internal .id, e.g. '*1' `{"type":"string"}` |

## get_radius_incoming

**Get RADIUS Incoming (CoA) Settings** · Risk: **read**

Reads the global RADIUS Change of Authorization (CoA) listener settings (`/radius incoming print`) — shows whether the router accepts incoming CoA/Disconnect packets from RADIUS servers and on which UDP port it listens. This is a router-wide singleton; no `radius_id` is needed. To change these settings use `set_radius_incoming`.

No tool-specific parameters.

## set_radius_incoming

**Set RADIUS Incoming (CoA) Settings** · Risk: **write-idempotent**

Configures the global RADIUS Change of Authorization (CoA) listener (`/radius incoming set`) — controls whether the router accepts unsolicited CoA or Disconnect-Request packets pushed by the RADIUS server to forcibly terminate or update active sessions. `accept` enables/disables the listener; `port` sets the UDP listen port (default 3799). This is a router-wide singleton; no `radius_id` is needed. To read current CoA settings use `get_radius_incoming`.

| Parameter | Required | Definition                                                                                                         |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `accept`  | No       | Whether to accept incoming CoA requests `{"type":"boolean"}`                                                       |
| `port`    | No       | UDP port to listen on for CoA requests `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## reset_radius_counters

**Reset RADIUS Counters** · Risk: **destructive**

Zeroes all RADIUS request/response packet counters on the router (`/radius reset-counters`) — use after a measurement window ends or before starting a new traffic test to get a clean baseline. This does not modify any server entry configuration; to delete an entry use `remove_radius_server`.

No tool-specific parameters.
