---
title: "RouterOS CLI"
description: "Universal escape hatch — run any raw RouterOS CLI command (read or write) when a dedicated tool isn't found (`run_routeros_command`)."
---

## Tools

- [Run a RouterOS Command (raw CLI)](#run_routeros_command)

## run_routeros_command

**Run a RouterOS Command (raw CLI)** · Risk: **write**

⚠️ LAST RESORT — do NOT call this tool directly. ALWAYS call `find_tools` first to locate the dedicated tool for your task, then run it via `invoke_tool`. Dedicated tools provide schema validation, structured output, and accurate risk annotations that this raw command lacks. Only use this tool when `find_tools` returned zero results for your query AND you are certain no dedicated tool exists.

When you do use it: pass one RouterOS CLI command exactly as typed in the terminal. The command is executed as-is with NO validation — it can be destructive, so review carefully. Runs one command per call; call again with `… print` to verify a change. For multi-command scripts use add_script + run_script instead.

| Parameter | Required | Definition                                                                               |
| --------- | -------- | ---------------------------------------------------------------------------------------- |
| `command` | Yes      | Full RouterOS CLI command exactly as typed, e.g. '/ip address print' `{"type":"string"}` |
