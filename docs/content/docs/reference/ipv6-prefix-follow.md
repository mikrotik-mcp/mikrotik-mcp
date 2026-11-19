---
title: "IPv6 Prefix Follow"
description: "Keeps IPv6 firewall address lists on the prefix the ISP delegates today: a script on the DHCPv6 client rewrites the lists each time the prefix changes, so rules that use them stay right."
---

## Tools

- [Keep IPv6 Address Lists on the Delegated Prefix](#follow_ipv6_prefix)
- [Stop Following the Delegated IPv6 Prefix](#unfollow_ipv6_prefix)

## follow_ipv6_prefix

**Keep IPv6 Address Lists on the Delegated Prefix** · Risk: **write**

Makes IPv6 firewall address lists follow the prefix your ISP delegates, so rules keep working when the ISP changes the prefix. It installs a script on the DHCPv6 client of `interface`; RouterOS runs it each time a prefix is bound, and it rewrites: the address list `list` with the whole delegated prefix, and for each entry in `hosts` a list `<list>-<name>` with that host's address (the new prefix plus its fixed `suffix`). Point your firewall rules at these lists instead of at literal addresses, for example `dst-address-list=isp-prefix-web` to allow inbound HTTPS to one server. The client must request a prefix (`request=prefix`). DEFAULTS TO A DRY RUN (`apply=false`) that shows the script. An existing script on the client that this tool did not write is kept unless `replace=true`. The lists are filled at the next bind: run `renew_ipv6_dhcp_client` afterwards to fill them now. A suffix names a host inside the prefix: `::10` is host ::10 in the first /64, `::1:0:0:0:10` is host ::10 in the second /64.

| Parameter   | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interface` | Yes      | Interface of the DHCPv6 client, e.g. 'ether1' or 'pppoe-out1' `{"type":"string"}`                                                                                                                                                                                                                                                                                                                                      |
| `list`      | Yes      | Address list that gets the whole delegated prefix `{"default":"isp-prefix","type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$"}`                                                                                                                                                                                                                                                                              |
| `hosts`     | Yes      | `{"default":[],"maxItems":32,"type":"array","items":{"type":"object","properties":{"name":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$","description":"Short name, becomes list '<list>-<name>'"},"suffix":{"type":"string","pattern":"^::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,4}$","description":"Fixed part of the address, e.g. '::10'"}},"required":["name","suffix"],"additionalProperties":false}}` |
| `replace`   | Yes      | Replace a script this tool did not write `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                          |
| `apply`     | Yes      | false = show the script; true = install `{"default":false,"type":"boolean"}`                                                                                                                                                                                                                                                                                                                                           |

## unfollow_ipv6_prefix

**Stop Following the Delegated IPv6 Prefix** · Risk: **destructive**

Undoes `follow_ipv6_prefix`: clears the script it installed on the DHCPv6 client of `interface` and removes the address-list entries the script made for `list`. A script that this tool did not write is left alone. Firewall rules that use those lists then match nothing: change or remove them first. Returns what was cleared.

| Parameter   | Required | Definition                                                                              |
| ----------- | -------- | --------------------------------------------------------------------------------------- |
| `interface` | Yes      | Interface of the DHCPv6 client `{"type":"string"}`                                      |
| `list`      | Yes      | `{"default":"isp-prefix","type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$"}` |
