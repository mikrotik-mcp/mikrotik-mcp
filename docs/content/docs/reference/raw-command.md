---
title: "RouterOS CLI"
description: "Universal escape hatch — run any raw RouterOS CLI command (read or write) when a dedicated tool isn't found (`run_routeros_command`)."
---

## Tools

- [Run a RouterOS Command (raw CLI)](#run_routeros_command)
- [Validate a RouterOS Command (no execution)](#validate_routeros_command)

## run_routeros_command

**Run a RouterOS Command (raw CLI)** · Risk: **write**

⚠️ LAST RESORT — do NOT call this tool directly. ALWAYS call `find_tools` first to locate the dedicated tool for your task, then run it via `invoke_tool`. Dedicated tools provide schema validation, structured output, and accurate risk annotations that this raw command lacks. Only use this tool when `find_tools` returned zero results for your query AND you are certain no dedicated tool exists.

When you do use it: pass one RouterOS CLI command exactly as typed in the terminal. The command is executed as-is with NO validation — it can be destructive, so review carefully. By default the command is first parsed on the router WITHOUT running it; a command the router does not know (a wrong menu, a misspelled parameter, RouterOS v6 syntax) is refused with the place of the problem, and nothing runs. Runs one command per call; call again with `… print` to verify a change. For multi-command scripts use add_script + run_script instead.

| Parameter      | Required | Definition                                                                                                   |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `command`      | Yes      | Full RouterOS CLI command exactly as typed, e.g. '/ip address print' `{"type":"string"}`                     |
| `check_syntax` | Yes      | Parse the command on the router first and refuse it when it is not valid `{"default":true,"type":"boolean"}` |

## validate_routeros_command

**Validate a RouterOS Command (no execution)** · Risk: **read**

Checks RouterOS CLI text on the router WITHOUT running it. The router's own parser compiles the text (`:parse`) and reports the first problem with its line and column: an unknown menu, a misspelled parameter, a syntax error, or RouterOS v6 syntax on a v7 router. Use it before you run or propose a command or a script you wrote yourself, so a wrong command is caught before it reaches a change. The answer is exact for that router's RouterOS version and packages. It does NOT check values that are only looked up at run time (an interface that does not exist, an address already in use). Accepts one command or a multi-line script. Returns 'valid' or the problem and where it is.

| Parameter | Required | Definition                                                           |
| --------- | -------- | -------------------------------------------------------------------- |
| `command` | Yes      | A RouterOS command, or a script of several lines `{"type":"string"}` |
