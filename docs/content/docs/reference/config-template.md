---
title: "Configuration Templates"
description: "Keep a reviewed RouterOS configuration with {{variable}} places on the MCP host, and apply it to a new router or to many with each router's values: parsed on the router first, then written in Safe Mode after a snapshot."
---

## Tools

- [List Configuration Templates](#list_config_templates)
- [Save a Configuration Template](#save_config_template)
- [Remove a Configuration Template](#remove_config_template)
- [Apply a Configuration Template to Routers](#apply_config_template)

## list_config_templates

**List Configuration Templates** · Risk: **read**

Lists the configuration templates kept on the MCP host, each with the variables it needs. A template is RouterOS script text with `{{variable}}` places, applied to routers with apply_config_template. It contacts no router. Use it to see which templates exist before you provision a router. Returns one line per template.

No tool-specific parameters.

## save_config_template

**Save a Configuration Template** · Risk: **write**

Saves a configuration template on the MCP host. `content` is RouterOS script text: full commands, or export style with a menu line (`/ip address`) and `add …` lines under it. Write `{{name}}` where a value differs between routers, and `{{name|default}}` to give a default. A place stands for one whole value (`name={{identity}}`) and must NOT be inside quotes: the value is quoted for you when it is applied, which is also what stops a value from adding commands. A template with a place inside quotes is refused. Saving a name that exists replaces it. It changes no router. Returns the variables the template needs.

| Parameter | Required | Definition                                                                                         |
| --------- | -------- | -------------------------------------------------------------------------------------------------- |
| `name`    | Yes      | Template name `{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$"}`                     |
| `content` | Yes      | RouterOS script text with {{variable}} places `{"type":"string","minLength":1,"maxLength":200000}` |

## remove_config_template

**Remove a Configuration Template** · Risk: **destructive**

Deletes one configuration template from the MCP host. It changes no router: a router that the template was applied to keeps its configuration. Returns whether a template was removed.

| Parameter | Required | Definition                                                                     |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `name`    | Yes      | Template name `{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$"}` |

## apply_config_template

**Apply a Configuration Template to Routers** · Risk: **write**

Applies a saved configuration template to one or more routers, each with its own values: the way to provision a new router, or to give many routers the same reviewed configuration. `variables` holds the values for every router; `per_device` holds values for one router and wins. Two variables are always set for you: `device` (the name in this server's device list) and `host` (its address). DEFAULTS TO A DRY RUN (`apply=false`) that returns the rendered commands for each router. Before anything is written, every command is parsed on that router; a command that is not valid there stops that router with the place of the problem, and nothing is written to it. Applying takes a config snapshot and writes in Safe Mode, so a change that cuts the connection is rolled back. Routers are done one at a time, and the run stops at the first router that fails. To provision a factory-default router, first add it to the device list (by its MAC address for MAC-Telnet, or its default address); Safe Mode needs SSH, so a MAC-Telnet router is written directly.

| Parameter    | Required | Definition                                                                                                                                                                                                                                    |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | Yes      | Template name `{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$"}`                                                                                                                                                                |
| `devices`    | Yes      | Routers to apply the template to `{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string"}}`                                                                                                                                      |
| `variables`  | Yes      | Values for every router `{"default":{},"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}`                                                                                                           |
| `per_device` | Yes      | Values for one router: { router: { variable: value } } `{"default":{},"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}}` |
| `apply`      | Yes      | false = show the commands; true = apply `{"default":false,"type":"boolean"}`                                                                                                                                                                  |
