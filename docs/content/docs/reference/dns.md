---
title: "DNS"
description: "DNS settings, static records, cache and regexp (`/ip dns`)."
---

## Tools

- [Configure DNS Resolver Settings](#set_dns_servers)
- [Get DNS Resolver Settings](#get_dns_settings)
- [Add DNS Static Record](#add_dns_static)
- [List DNS Static Records](#list_dns_static)
- [Get DNS Static Record Detail](#get_dns_static)
- [Update DNS Static Record](#update_dns_static)
- [Remove DNS Static Record](#remove_dns_static)
- [Enable DNS Static Record](#enable_dns_static)
- [Disable DNS Static Record](#disable_dns_static)
- [Get DNS Cache Entries](#get_dns_cache)
- [Flush DNS Cache](#flush_dns_cache)
- [Get DNS Cache Statistics](#get_dns_cache_statistics)
- [Add DNS Regexp Static Record](#add_dns_regexp)
- [Test DNS Resolution From Router](#test_dns_query)
- [Export DNS Configuration to File](#export_dns_config)

## set_dns_servers

**Configure DNS Resolver Settings** · Risk: **write**

Configures the DNS resolver (`/ip dns set`) — sets upstream server IPs, enables or disables forwarding client queries to this router (allow_remote_requests), tunes cache limits (cache_size in KiB, cache_max_ttl, max_udp_packet_size, max_concurrent_queries), and optionally switches to DNS-over-HTTPS (use_doh=true + doh_server URL + verify_doh_cert). Use this when you need to CHANGE which servers the router queries or how its resolver behaves. To read current settings without changing them use get_dns_settings. Returns the updated `/ip dns print` output after applying changes.

| Parameter                     | Required | Definition                                                                                                                   |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `servers`                     | Yes      | DNS server IP addresses `{"type":"array","items":{"type":"string"}}`                                                         |
| `allow_remote_requests`       | Yes      | `{"default":false,"type":"boolean"}`                                                                                         |
| `max_udp_packet_size`         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                  |
| `max_concurrent_queries`      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                  |
| `max_concurrent_tcp_sessions` | No       | Maximum number of simultaneous TCP DNS sessions `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`  |
| `query_server_timeout`        | No       | Per-upstream-server query timeout, e.g. "2s" `{"type":"string"}`                                                             |
| `query_total_timeout`         | No       | Total query timeout across all servers, e.g. "10s" `{"type":"string"}`                                                       |
| `cache_size`                  | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                                                  |
| `cache_max_ttl`               | No       | `{"type":"string"}`                                                                                                          |
| `use_doh`                     | Yes      | `{"default":false,"type":"boolean"}`                                                                                         |
| `doh_server`                  | No       | `{"type":"string"}`                                                                                                          |
| `verify_doh_cert`             | Yes      | `{"default":true,"type":"boolean"}`                                                                                          |
| `doh_max_server_connections`  | No       | Maximum concurrent connections to the DoH server `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `doh_max_concurrent_queries`  | No       | Maximum concurrent queries over DoH `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`              |
| `doh_timeout`                 | No       | DoH request timeout, e.g. "5s" `{"type":"string"}`                                                                           |
| `vrf`                         | No       | VRF the resolver uses for upstream queries `{"type":"string"}`                                                               |

## get_dns_settings

**Get DNS Resolver Settings** · Risk: **read**

Reads the current DNS resolver configuration (`/ip dns print`) — upstream server IPs, allow-remote-requests flag, cache-size, cache-max-ttl, max-udp-packet-size, max-concurrent-queries, and DNS-over-HTTPS settings. To change these settings use set_dns_servers. For cache entry counts and utilization metrics use get_dns_cache_statistics. Returns the full `/ip dns print` settings block.

No tool-specific parameters.

## add_dns_static

**Add DNS Static Record** · Risk: **write**

Creates a static DNS record in `/ip dns static` — the local override table that answers DNS queries before upstream resolvers are consulted. Supports A (address), CNAME (cname), MX (mx_preference + mx_exchange), TXT (text), and SRV (srv_priority + srv_weight + srv_port + srv_target) record types; provide exactly one record type's fields per call. A regexp pattern may also be set for wildcard hostname matching — for a simpler regexp-only interface use add_dns_regexp instead. To inspect existing records use list_dns_static. Returns the created entry's full detail including its `.id`.

| Parameter         | Required | Definition                                                                                  |
| ----------------- | -------- | ------------------------------------------------------------------------------------------- |
| `name`            | Yes      | `{"type":"string"}`                                                                         |
| `type`            | No       | Record type, e.g. "A", "AAAA", "CNAME", "NS", "FWD", "MX", "SRV", "TXT" `{"type":"string"}` |
| `address`         | No       | `{"type":"string"}`                                                                         |
| `cname`           | No       | `{"type":"string"}`                                                                         |
| `ns`              | No       | Name server FQDN for an NS-type record `{"type":"string"}`                                  |
| `forward_to`      | No       | DNS server to forward to for a FWD-type record `{"type":"string"}`                          |
| `match_subdomain` | No       | Also match all subdomains of name/regexp `{"type":"boolean"}`                               |
| `address_list`    | No       | Add resolved addresses to this firewall address-list `{"type":"string"}`                    |
| `mx_preference`   | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `mx_exchange`     | No       | `{"type":"string"}`                                                                         |
| `text`            | No       | `{"type":"string"}`                                                                         |
| `srv_priority`    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `srv_weight`      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `srv_port`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `srv_target`      | No       | `{"type":"string"}`                                                                         |
| `ttl`             | No       | `{"type":"string"}`                                                                         |
| `comment`         | No       | `{"type":"string"}`                                                                         |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                        |
| `regexp`          | No       | `{"type":"string"}`                                                                         |

## list_dns_static

**List DNS Static Records** · Risk: **read**

Lists static DNS records from `/ip dns static print` — the local resolver override table. Supports optional filters: name_filter (substring match on hostname), address_filter (substring match on IP), type_filter (exact record type, e.g. "A", "CNAME", "MX"), disabled_only (only disabled entries), regexp_only (only regexp-pattern entries). To retrieve full field detail for one specific entry by `.id` use get_dns_static. Returns a table of all matching static DNS records with their `.id` values.

| Parameter        | Required | Definition                           |
| ---------------- | -------- | ------------------------------------ |
| `name_filter`    | No       | `{"type":"string"}`                  |
| `address_filter` | No       | `{"type":"string"}`                  |
| `type_filter`    | No       | `{"type":"string"}`                  |
| `disabled_only`  | Yes      | `{"default":false,"type":"boolean"}` |
| `regexp_only`    | Yes      | `{"default":false,"type":"boolean"}` |

## get_dns_static

**Get DNS Static Record Detail** · Risk: **read**

Retrieves full detail of a single static DNS record (`/ip dns static print detail where .id=…`). Use when you need all field values for one known entry rather than a table of all records. The `entry_id` is the `.id` returned by list_dns_static. For a table of all records (or to search by name/address/type) use list_dns_static. Returns the full detail output for the specified entry, or a not-found message.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `entry_id` | Yes      | `{"type":"string"}` |

## update_dns_static

**Update DNS Static Record** · Risk: **write-idempotent**

Modifies fields on an existing static DNS record (`/ip dns static set`) — can update the hostname (name), record-type data (address, cname, mx_preference, mx_exchange, text, srv fields), ttl, comment, disabled state, or regexp pattern. Pass an empty string for a field to clear it (e.g. address="" removes the address field). The `entry_id` is the `.id` from list_dns_static. To activate or deactivate without touching other fields use enable_dns_static or disable_dns_static. Returns the updated entry's full detail.

| Parameter         | Required | Definition                                                                                  |
| ----------------- | -------- | ------------------------------------------------------------------------------------------- |
| `entry_id`        | Yes      | `{"type":"string"}`                                                                         |
| `name`            | No       | `{"type":"string"}`                                                                         |
| `type`            | No       | Record type, e.g. "A", "AAAA", "CNAME", "NS", "FWD", "MX", "SRV", "TXT" `{"type":"string"}` |
| `address`         | No       | `{"type":"string"}`                                                                         |
| `cname`           | No       | `{"type":"string"}`                                                                         |
| `ns`              | No       | Name server FQDN for an NS-type record `{"type":"string"}`                                  |
| `forward_to`      | No       | DNS server to forward to for a FWD-type record `{"type":"string"}`                          |
| `match_subdomain` | No       | Also match all subdomains of name/regexp `{"type":"boolean"}`                               |
| `address_list`    | No       | Add resolved addresses to this firewall address-list `{"type":"string"}`                    |
| `mx_preference`   | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `mx_exchange`     | No       | `{"type":"string"}`                                                                         |
| `text`            | No       | `{"type":"string"}`                                                                         |
| `srv_priority`    | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `srv_weight`      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `srv_port`        | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`                 |
| `srv_target`      | No       | `{"type":"string"}`                                                                         |
| `ttl`             | No       | `{"type":"string"}`                                                                         |
| `comment`         | No       | `{"type":"string"}`                                                                         |
| `disabled`        | No       | `{"type":"boolean"}`                                                                        |
| `regexp`          | No       | `{"type":"string"}`                                                                         |

## remove_dns_static

**Remove DNS Static Record** · Risk: **destructive**

Permanently deletes a static DNS record from `/ip dns static` — verifies the entry exists first via a count-only check, then runs `/ip dns static remove`. The `entry_id` is the `.id` from list_dns_static. To temporarily suppress a record without deleting it use disable_dns_static. Returns confirmation of deletion, or a not-found message if the ID does not exist.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `entry_id` | Yes      | `{"type":"string"}` |

## enable_dns_static

**Enable DNS Static Record** · Risk: **write-idempotent**

Re-activates a disabled static DNS record (`/ip dns static set disabled=no`) so it participates in local DNS resolution again. The `entry_id` is the `.id` from list_dns_static. To suppress a record temporarily use disable_dns_static. To permanently delete use remove_dns_static. Returns the updated entry's full detail.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `entry_id` | Yes      | `{"type":"string"}` |

## disable_dns_static

**Disable DNS Static Record** · Risk: **write-idempotent**

Deactivates a static DNS record (`/ip dns static set disabled=yes`) without deleting it — the entry is retained but ignored during resolution. The `entry_id` is the `.id` from list_dns_static. To re-activate use enable_dns_static. To permanently delete use remove_dns_static. Returns the updated entry's full detail.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `entry_id` | Yes      | `{"type":"string"}` |

## get_dns_cache

**Get DNS Cache Entries** · Risk: **read**

Lists all hostnames currently held in the router's DNS resolver cache (`/ip dns cache print`). Use to inspect what the router has already resolved and what is available without re-querying upstream servers. For summary statistics (cache-size, cache-used, cache-max-ttl, total entry count) use get_dns_cache_statistics. To clear the cache use flush_dns_cache. Returns the full cache table, or a message if the cache is empty.

No tool-specific parameters.

## flush_dns_cache

**Flush DNS Cache** · Risk: **destructive**

Clears all cached DNS entries from the router's resolver (`/ip dns cache flush`) — forces the router to re-query upstream servers for all subsequent lookups. Use after changing upstream servers or adding static records to evict stale cached responses. To inspect the cache before flushing use get_dns_cache. Returns confirmation of the flush.

No tool-specific parameters.

## get_dns_cache_statistics

**Get DNS Cache Statistics** · Risk: **read**

Reports DNS cache utilization metrics — extracts cache-size, cache-used, and cache-max-ttl from `/ip dns print`, then appends the live count of cached entries from `/ip dns cache print count-only`. Use to assess cache utilization without listing every entry. Works on RouterOS v6 and v7 (there is no `/ip dns cache print stats` command). To see all cached entries use get_dns_cache. To change cache-size or cache-max-ttl use set_dns_servers. Returns cache-related fields and the total entry count.

No tool-specific parameters.

## add_dns_regexp

**Add DNS Regexp Static Record** · Risk: **write**

Creates a regexp-pattern static DNS record (`/ip dns static add`) that matches any hostname satisfying the given regular expression and resolves it to a fixed IP address (IPv4 or IPv6) — useful for wildcard domains, captive portals, or ad-blocking. Simplified interface requiring only `regexp` (RouterOS regex) and `address` (IPv4 or IPv6), plus optional `ttl` (default 1d), `comment`, and `disabled`. For full record-type support (CNAME, MX, SRV, TXT) or to set both a hostname and regexp use add_dns_static. Returns the created entry's full detail including its `.id`.

| Parameter  | Required | Definition                           |
| ---------- | -------- | ------------------------------------ |
| `regexp`   | Yes      | `{"type":"string"}`                  |
| `address`  | Yes      | `{"type":"string"}`                  |
| `ttl`      | Yes      | `{"default":"1d","type":"string"}`   |
| `comment`  | No       | `{"type":"string"}`                  |
| `disabled` | Yes      | `{"default":false,"type":"boolean"}` |

## test_dns_query

**Test DNS Resolution From Router** · Risk: **read**

Resolves a hostname using the router's own DNS resolver (`:put [:resolve ...]`) — tests what address the router itself would obtain for a given name. Optionally directs the query to a specific upstream `server` (IP). `type` is "A" (IPv4 only, default), "AAAA" (IPv6 only), "ANY" (IPv4 then IPv6 fallback), or "ANY6" (IPv6 then IPv4 fallback). Returns one resolved IP address, not all DNS records; MX queries are not supported. Use to verify DNS reachability, that a static record override is active, or that DoH is working — all from the router's perspective, not from a client behind it. Queries with an explicit server are not cached by RouterOS.

| Parameter | Required | Definition                                                              |
| --------- | -------- | ----------------------------------------------------------------------- |
| `name`    | Yes      | DNS name to resolve, e.g. example.com `{"type":"string","minLength":1}` |
| `server`  | No       | Optional DNS server IP address `{"type":"string","minLength":1}`        |
| `type`    | Yes      | `{"default":"A","type":"string","enum":["A","AAAA","ANY","ANY6"]}`      |

## export_dns_config

**Export DNS Configuration to File** · Risk: **read**

Exports the full DNS configuration (resolver settings and static records) to a RouterOS script file on the router's flash storage (`/ip dns export file=<filename>`). The router appends `.rsc` to the filename automatically; defaults to `dns_config.rsc`. The exported file can be imported on another RouterOS device to replicate DNS configuration. To read current settings as structured output without writing a file use get_dns_settings. To list static records use list_dns_static. Returns the filename of the exported `.rsc` file on the router.

| Parameter  | Required | Definition          |
| ---------- | -------- | ------------------- |
| `filename` | No       | `{"type":"string"}` |
