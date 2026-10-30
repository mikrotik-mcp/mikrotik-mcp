---
title: "Web Proxy"
description: "HTTP/HTTPS CONNECT proxy settings, live status and ordered access rules (`/ip proxy`)."
---

## Tools

- [Get Web Proxy Settings](#get_web_proxy)
- [Update Web Proxy Settings](#update_web_proxy)
- [Monitor Web Proxy](#monitor_web_proxy)
- [List Web Proxy Access Rules](#list_web_proxy_access_rules)
- [Add Web Proxy Access Rule](#add_web_proxy_access_rule)
- [Remove Web Proxy Access Rule](#remove_web_proxy_access_rule)
- [Move Web Proxy Access Rule](#move_web_proxy_access_rule)

## get_web_proxy

**Get Web Proxy Settings** · Risk: **read**

Read RouterOS `/ip proxy` settings, including enabled, port, outgoing source and cache.

No tool-specific parameters.

## update_web_proxy

**Update Web Proxy Settings** · Risk: **dangerous**

Configure RouterOS `/ip proxy`. Enabling a listener does not restrict who may connect: configure IPv4/IPv6 input firewall rules and inspect web proxy access rules first. The outgoing src_address can select existing source-based policy routing; verify the route and NAT separately.

| Parameter                | Required | Definition                                                                                          |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `enabled`                | No       | `{"type":"boolean"}`                                                                                |
| `port`                   | No       | `{"type":"integer","minimum":1,"maximum":65535}`                                                    |
| `src_address`            | No       | `{"type":"string"}`                                                                                 |
| `anonymous`              | No       | `{"type":"boolean"}`                                                                                |
| `max_cache_size`         | No       | `{"type":"string"}`                                                                                 |
| `confirm_firewall_ready` | No       | Required when enabling: IPv4 and IPv6 input firewall access has been verified. `{"type":"boolean"}` |

## monitor_web_proxy

**Monitor Web Proxy** · Risk: **read**

Read one `/ip proxy monitor once` sample, including connection and request counters.

No tool-specific parameters.

## list_web_proxy_access_rules

**List Web Proxy Access Rules** · Risk: **read**

Read ordered `/ip proxy access` rules and their `.id`s. An unmatched request is allowed by RouterOS; use firewall input rules to control source address lists.

No tool-specific parameters.

## add_web_proxy_access_rule

**Add Web Proxy Access Rule** · Risk: **write**

Add an allow/deny rule to `/ip proxy access`. Order matters; place_before is an existing `.id` or zero-based row. Use dst_address to block private targets; the proxy firewall controls client sources.

| Parameter      | Required | Definition                                  |
| -------------- | -------- | ------------------------------------------- |
| `action`       | Yes      | `{"type":"string","enum":["allow","deny"]}` |
| `src_address`  | No       | `{"type":"string"}`                         |
| `dst_address`  | No       | `{"type":"string"}`                         |
| `comment`      | No       | `{"type":"string"}`                         |
| `place_before` | No       | `{"type":"string"}`                         |

## remove_web_proxy_access_rule

**Remove Web Proxy Access Rule** · Risk: **destructive**

Remove one `/ip proxy access` rule by `.id` or zero-based row, after inspecting the ordered list.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `rule_id` | Yes      | `{"type":"string"}` |

## move_web_proxy_access_rule

**Move Web Proxy Access Rule** · Risk: **write-idempotent**

Move one `/ip proxy access` rule before the item at a zero-based destination position; reads back the resulting order.

| Parameter     | Required | Definition                                                  |
| ------------- | -------- | ----------------------------------------------------------- |
| `rule_id`     | Yes      | `{"type":"string"}`                                         |
| `destination` | Yes      | `{"type":"integer","minimum":0,"maximum":9007199254740991}` |
