---
title: "Terminal"
description: "RouterOS consoles in dockable panes — history, favourites, broadcast"
---

## Open a terminal

Open **Router configuration → Terminal** (`#terminal`). Beside **New terminal**, choose the kind of pane, then click a router:

- **Blocks** — each command is a block with its output and its actions. Every command is recorded.
- **Shell** — a real RouterOS console, for menus, prompts and live monitors.

**All routers** opens one pane for each router. If the page shows **Terminal is turned off**, turn it on in **Config → Dashboard → Terminal page**: see [Turn it on](/docs/guides/terminal#turn-it-on).

## Arrange the panes

Drag a pane tab to split, stack or float the pane, and drag a border to resize. Right-click a tab to rename the pane or give it a colour. **Workspaces** saves the layout under a name. The layout is kept in the browser.

## Run a command

Type a full RouterOS command (`/ip address print`) and press `Enter`. While you type:

- a list of completions opens — `↑` `↓` move, `Tab` accepts, `Esc` closes;
- the router checks the input and underlines what it does not accept;
- a strip under the input explains what can follow.

With the completion list closed, `↑` and `↓` walk through the blocks of the pane and put their command in the input.

Each block has its actions on its header and in its right-click menu: **Stop**, **Run again**, **Watch**, **Table**, **Compare**, **Copy**, **Save**, **Favourite**, **Pin**, **Schedule**. Click an IP or MAC address in an output for commands about it.

## The status bar of a pane

The bar shows the connection state, the router identity and the round-trip latency. Chips for running, failed and watched commands show only when they apply. On the right:

- the **shield** opens Safe Mode, then offers **Commit** and **Roll back**;
- the **settings** button holds auto-retry, snapshot before changes, the time limit, the watch interval, the chart number and the alert rule;
- the **⋯** button holds script, share, check connection, the exports and clear.

A dot on the settings button means that a setting is not at its default.

## The toolbar

| Button         | Opens                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| **Workspaces** | Saved pane layouts.                                                                   |
| **Broadcast**  | Where a typed command also runs: off, all open panes, or a saved group of routers.    |
| **Find**       | Search in this terminal or in all terminals (`Ctrl+F`).                               |
| **History**    | Every command that ran. Run or edit one on the active pane or on a router you choose. |
| **Recordings** | Playback and search of Shell sessions.                                                |
| **Scheduled**  | Read commands that the server runs at a time or on a repeat.                          |
| **Favourites** | Starred commands and snippets.                                                        |

`Ctrl+Shift+P` opens the command palette, which lists all of these and more.

## Before you change a router

- A destructive command (`remove`, `reboot`, `reset-configuration` and similar) asks for confirmation.
- Auto-retry repeats a command only when the router was not reached, or when the command only reads.
- Turn on **Snapshot before changes** for a restore point before every change, or open **Safe Mode** so that the router undoes uncommitted changes if the session is lost.
- A read-only server runs only `print`, `export` and diagnostic commands, and has no Shell pane.

See the [terminal guide](/docs/guides/terminal) for every feature, the safety rules, what is recorded and the API.
