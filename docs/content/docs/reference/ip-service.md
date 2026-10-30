---
title: "IP Services"
description: "Management service ports — ssh/www/api/telnet (`/ip service`)."
---

## Tools

- [List IP Management Services](#list_ip_services)
- [Get IP Management Service Details](#get_ip_service)
- [Configure IP Management Service](#set_ip_service)
- [Enable IP Management Service](#enable_ip_service)
- [Disable IP Management Service](#disable_ip_service)

## list_ip_services

**List IP Management Services** · Risk: **read**

Lists all built-in router management services (`/ip service`) — telnet, ftp, www, ssh, www-ssl, api, api-ssl, winbox — with their port, allowed source subnets, certificate, and enabled/disabled state. Use this to audit which management protocols are exposed before hardening. Returns the full `/ip service print` table. For a single service's detail use `get_ip_service`.

No tool-specific parameters.

## get_ip_service

**Get IP Management Service Details** · Risk: **read**

Retrieves full detail for a single router management service (`/ip service print detail`) — port, allowed source subnets, TLS certificate, and enabled/disabled state. Accepts a service name such as `ssh`, `www`, `winbox`, `api`, `api-ssl`, `telnet`, `ftp`, or `www-ssl`. To view all services at once use `list_ip_services`; to change the service use `set_ip_service`.

| Parameter | Required | Definition                                                    |
| --------- | -------- | ------------------------------------------------------------- |
| `name`    | Yes      | Service name, e.g. 'ssh', 'www', 'winbox' `{"type":"string"}` |

## set_ip_service

**Configure IP Management Service** · Risk: **write-idempotent**

Updates one or more attributes of a router management service (`/ip service set`) — port number, allowed source subnets (`address`, comma-separated CIDRs), TLS certificate name, or enabled/disabled state (`disabled: true/false`). Accepts a service name such as `ssh`, `winbox`, `api`, or `api-ssl`. Note: two services cannot share a port — if the chosen port is already used by another service the device rejects it (list_ip_services shows current ports). To toggle only the enabled state use `enable_ip_service` or `disable_ip_service` instead. Returns updated service detail on success.

| Parameter     | Required | Definition                                                                                 |
| ------------- | -------- | ------------------------------------------------------------------------------------------ |
| `name`        | Yes      | Service name to update, e.g. 'ssh' `{"type":"string"}`                                     |
| `port`        | No       | Listening port `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `address`     | No       | Allowed source subnets, comma-separated `{"type":"string"}`                                |
| `disabled`    | No       | Disable (true) or enable (false) the service `{"type":"boolean"}`                          |
| `certificate` | No       | Certificate name (for TLS services) `{"type":"string"}`                                    |
| `vrf`         | No       | VRF the service is bound to (default 'main') `{"type":"string"}`                           |

## enable_ip_service

**Enable IP Management Service** · Risk: **write-idempotent**

Enables a previously disabled router management service (`/ip service enable`). Accepts a service name such as `ssh`, `winbox`, or `api`. To also change the port, source address filter, or certificate use `set_ip_service` instead; to disable a service use `disable_ip_service`.

| Parameter | Required | Definition                                             |
| --------- | -------- | ------------------------------------------------------ |
| `name`    | Yes      | Service name to enable, e.g. 'ssh' `{"type":"string"}` |

## disable_ip_service

**Disable IP Management Service** · Risk: **write-idempotent**

Disables a router management service (`/ip service disable`) — use this to harden the router by turning off insecure or unused protocols such as `telnet`, `ftp`, or `www`. Accepts a service name. To also change the port, source address filter, or certificate use `set_ip_service` instead; to re-enable a service use `enable_ip_service`.

| Parameter | Required | Definition                                                 |
| --------- | -------- | ---------------------------------------------------------- |
| `name`    | Yes      | Service name to disable, e.g. 'telnet' `{"type":"string"}` |
