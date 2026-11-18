---
title: Dashboard terminal
description: RouterOS consoles in the browser — panes, command blocks, an interactive shell, history, and the rules that keep it safe.
---

The **Terminal** page of the [dashboard](/docs/guides/observability) gives you RouterOS consoles in the browser, as the Terminal of WinBox does. You open one pane for each console, on any configured router, and arrange the panes as you like.

A pane is one of two kinds:

| Kind       | What it is                                                                                      | Use it for                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Blocks** | Each command is a block: the command, its live output, its result and its actions. The default. | Daily work. Every command is recorded, can run again, and can be compared.    |
| **Shell**  | A real RouterOS console over one SSH session (a PTY).                                           | Entering a menu, answering a y/n prompt, a live monitor, the built-in editor. |

For a tour of the page itself, see [Terminal in the dashboard reference](/docs/dashboard/terminal).

## Turn it on

The terminal is part of the dashboard. Start the server with the dashboard enabled:

```bash
mikrotik-mcp serve --dashboard --dashboard-host 127.0.0.1
```

Then open the dashboard and go to **Router configuration → Terminal** (`#terminal`).

The terminal is on by default. It does not need a dashboard token and it does not need a loopback bind.

> **Warning:** The terminal runs any command on a router. Anyone who can open the dashboard can use it, and the dashboard listens on `0.0.0.0` by default. On a network that you do not trust, set a dashboard token (`--dashboard-token`), or turn the terminal off.

To turn it off or on, use **Config → Dashboard → Terminal page** in the dashboard (the change applies at once, with no restart), or the flag below. When it is off, the page shows **Terminal is turned off** and every terminal route answers HTTP 403.

| Env var                        | Flag                   | Default | Meaning                                                                        |
| ------------------------------ | ---------------------- | ------- | ------------------------------------------------------------------------------ |
| `MIKROTIK_DASHBOARD__TERMINAL` | `--dashboard-terminal` | `true`  | Serve the terminal. Set `false` to turn it off, also on a protected dashboard. |

The config file key is `dashboard.terminal`.

## Panes

- **Open.** Choose **Blocks** or **Shell** beside **New terminal**, then click a router. **All routers** opens one pane for each router.
- **Arrange.** Drag a pane tab to split, stack as tabs, or float the pane. Drag a border to resize. You can open several panes for one router.
- **Name and colour.** Right-click a pane tab (or double-click it) to rename the pane or give it one of seven colours. The colour fills the tab and marks the pane.
- **Workspaces.** **Workspaces** saves the current layout under a name and opens it again later.

The layout, the titles and the colours are kept in the browser, so they survive a reload.

## Command blocks

Type a RouterOS command and press `Enter`. Use the full path (`/ip address print`): each command runs by itself, so a block pane has no "current menu". For that, use a Shell pane.

A block shows the output as it arrives. Its actions are on the block, and also in its right-click menu (`Shift` + right-click keeps the browser's menu):

| Action            | What it does                                                                            |
| ----------------- | --------------------------------------------------------------------------------------- |
| Stop              | Stops the command on the router. `Ctrl+C` does the same.                                |
| Run again         | Runs the same command again in a new block.                                             |
| Edit in the input | Puts the command in the input, to change it first.                                      |
| Watch             | Runs the block again on a timer and marks the lines that changed.                       |
| Table             | Shows a `print` output as a table that sorts by a column and filters rows.              |
| Compare           | Pick a block, then a second one in any pane, to see the differences.                    |
| Copy / Save       | Copies the output, the command or the selected text, or saves the block as a text file. |
| Favourite         | Adds the command to your favourites.                                                    |
| Pin               | Keeps the block above the scrolling list, always in view.                               |
| Schedule          | Opens the schedule form with this command.                                              |
| Undo              | Offered when the opposite command is certain. See [Undo](#undo).                        |

A new command scrolls the pane to its end. When you scroll up, a button returns to the end.

### Keys

| Key            | Action                                                                               |
| -------------- | ------------------------------------------------------------------------------------ |
| `Enter`        | Run the command.                                                                     |
| `Shift+Enter`  | New line.                                                                            |
| `Tab`          | Accept the marked completion.                                                        |
| `↑` / `↓`      | Completion list open: move in the list. Closed: walk through the blocks of the pane. |
| `→`            | Accept the grey suggestion from the history.                                         |
| `Esc`          | Close the completion list.                                                           |
| `Ctrl+C`       | Stop the running command.                                                            |
| `Ctrl+L`       | Clear the pane.                                                                      |
| `Ctrl+F`       | Find in the terminals.                                                               |
| `Ctrl+K`       | Search the command history.                                                          |
| `Ctrl+Shift+P` | Command palette.                                                                     |

When you walk through the blocks with `↑` and `↓`, the block is marked and scrolled into view, and its command is put in the input. `↓` past the last block returns to what you were typing.

### Help while you type

The router itself helps with the input. Nothing here is a guess from a fixed list: it comes from the RouterOS version of that router.

- **Syntax colours.** The input is coloured at once from a RouterOS grammar. A moment later the router checks the input and the colours become the router's own.
- **Syntax check.** A part that the router does not accept is underlined, and the pane shows `router: syntax error`, before you run the command.
- **Completion.** A list of words opens while you type. It also opens with `Tab`.
- **Help.** A strip under the input explains what can follow the typed word. Turn it off with the `?` button.
- **History suggestion.** An earlier command that starts with what you typed is shown in grey.

### Pipes

End a command with one or more filters. The router gets the command only; the filters run on the output in the browser.

```text
/interface print | grep ether | count
/log print | grep -v dhcp | tail 20
```

The filters are `grep` (with `-v` to invert), `count`, `sort` (with `-r`), `uniq`, `head N` and `tail N`. A `|` inside quotes or brackets, or one that no filter follows, stays in the command.

### Snippets

A command may hold placeholders. Running it opens a small form for the values, with a preview of the filled command.

```text
/ip firewall address-list add list={{list=blocked}} address={{ip}}
```

`{{name}}` asks for a value. `{{name=default}}` offers a default. The star beside the input saves what is typed as a favourite without running it.

### Addresses in an output

Click an IPv4 address or a MAC address in an output for commands about it: ping, traceroute, ARP, connections, bridge port, DHCP lease, address list. The command you choose goes to the input, where you review it. It is not run.

### Undo

A block offers the opposite command when that is certain:

- `enable` and `disable` swap,
- `disabled=yes` and `disabled=no` swap, when it is the only property set,
- a plain `add` is undone by removing the new item.

For an `add`, the pane sends the command as `:put [...]` so that the router prints the id of the new item. The undo removes exactly that id. The undo goes to the input to review; you run it.

A `set` of other properties, a `remove` and a script offer no undo, because the old values are not known. Use a [snapshot](#snapshot-before-a-change) or [Safe Mode](#safe-mode) for those.

## Watch, chart and alerts

**Watch** runs one block again on a timer (2 seconds to 1 minute, set in the pane settings). Lines that differ from the run before are marked. A watch tick does not move your view.

For the watched block, the pane settings take two more things:

- **Chart.** Name a number of the output (`cpu-load`, `free-memory`, `rx-byte`). Each run adds a point to a line chart above the output.
- **Alert.** A rule. When the rule starts to hold, the block shows it and the browser notifies you.

| Rule            | Holds when                                                                     |
| --------------- | ------------------------------------------------------------------------------ |
| `changed`       | The output differs from the run before.                                        |
| `cpu-load > 80` | The number after that name passes the limit (`>`, `>=`, `<`, `<=`, `=`, `!=`). |
| `/down\|error/` | The output matches the regular expression.                                     |
| any other text  | The output contains that text.                                                 |

Pin a watched block to keep it in view: together they make a small live panel for the router.

## Interactive shell

Choose **Shell** beside **New terminal** to open a real RouterOS console. It behaves as the console of WinBox or SSH does: you can enter a menu, answer a prompt, run `/system resource monitor`, and use the built-in editor.

- Each Shell pane has its own SSH connection. At most 12 are open at a time.
- A session closes when you close the pane, and after 30 minutes without a key or an output.
- A router that is reached over MAC-Telnet has no Shell pane, because the shell needs SSH.
- A read-only server has no Shell pane, because keys cannot be sorted into reads and changes.

### Recordings

What the router prints in a Shell pane is recorded, one file for each session (asciicast v2, in `terminal-recordings/` beside the databases). **Recordings** lists the sessions by day, plays one back with play, pause, a seek bar and four speeds, and searches its text.

**Typed keys are not recorded.** The router echoes the commands you type, so they are in the recording. It does not echo what you type at a password prompt, so that is not. If the router prints something sensitive (for example `/export show-sensitive`), it is in the recording.

A recording stops growing at 5 MB and the newest 200 are kept. Nothing is recorded when the dashboard database is `:memory:`.

## Work on several routers

- **Broadcast.** With broadcast on, a command typed in one pane also runs in other panes: every open pane, or the panes of a saved group of routers. A bar then lists the result of each pane.
- **Script.** The script dialog of a pane runs several commands, one for each line, in order. Lines that start with `#` are skipped, and a line that ends with `\` continues on the next. **Check syntax** validates every line with the router and runs nothing.
- **Compare.** Run one command on two routers, then compare the two blocks.
- **Run from history.** The history drawer runs or edits any earlier command on the active pane or on a router you choose.

## History, favourites and search

- **History.** Every command of a block pane is saved on the server with its output, its result and its time. The drawer searches it and filters it by router.
- **Favourites.** Star a command to keep it. Favourites may be [snippets](#snippets).
- **Find.** `Ctrl+F` opens a find bar that searches commands and outputs in this terminal or in all terminals, with match case, whole words and regular expressions. The filter button hides the blocks without a match.
- **Command palette.** `Ctrl+Shift+P` lists every action of the page. Start the query with `?` to ask in words: you get earlier commands, favourites and MCP tools whose words match. No language model is used, so it finds existing commands; it does not write new ones.
- **Export.** Save a pane as a transcript (`.txt`), a report (`.md`), or the commands that succeeded (`.rsc`).

## Scheduled commands

**Scheduled** runs a command at a time or on a repeat (one minute to one day). The server runs it, also when no browser is open, and saves each result to the history and to the audit feed.

**Only commands that read can be scheduled**: `print`, `export`, `ping` and `traceroute`. The server refuses anything else when you create the schedule, and checks again before each run. A change must be run by a person. At most 50 schedules are kept.

## Shared view

**Share a read-only view** in the pane menu gives a link. The link shows the commands that run on that router from that moment, with their outputs, and updates every two seconds. It has no input. It ends after 24 hours.

The link is a view, not a permission. Whoever opens it still needs access to the dashboard, and the link does not limit that access. To let a colleague follow along without your token in their browser, give them a [remote dashboard](/docs/guides/observability#run-the-dashboard-on-another-machine).

## Safety

The terminal sends raw commands. These rules apply to every pane.

### Destructive commands ask first

A command that holds `remove`, `reset-configuration`, `reset`, `reboot`, `shutdown`, `format`, `downgrade`, `uninstall` or `wipe` shows a confirmation bar before it runs. With broadcast on, the bar says so. In a script, such lines must be marked as reviewed before **Run** is available.

### Auto-retry never repeats a change

A pane retries a failed command up to three times, with a growing delay. It does that only when a retry cannot repeat a change:

- the router was not reached, so the command was never sent, or
- the command only reads.

A change that was sent, and then lost its connection, is not sent again: it may already have run. The block reports the failure and you decide.

### Snapshot before a change

With **Snapshot before changes** on in the pane settings, the configuration is stored before every command that is not a read. The snapshot is kept on this computer (see [configuration snapshots](/docs/guides/config-snapshots)), not on the router. If the snapshot fails, the command does not run. The block then offers **what changed?**, a diff of the newest snapshot against the router.

A snapshot takes a full `/export`, so each change waits for it.

### Safe Mode

The shield button of a pane opens RouterOS [Safe Mode](/docs/guides/safe-mode), then offers **Commit** and **Roll back**. While it is open, the pane is marked and changes run through the Safe Mode session, so the router undoes them if the session is lost.

### Read-only server

On a server in read-only mode, a block pane runs only `print`, `export` and diagnostic commands. Shell panes and Safe Mode are not available.

### Time limit

A command stops at the time limit of the pane: 30 seconds by default, or 2 or 10 minutes. This keeps a command that never ends, such as a continuous ping, from holding the connection.

## What is recorded, and where

| What                                                       | Where                                                                  | Limit                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| Commands of block panes, with output                       | `terminal.db` beside the dashboard database                            | 5,000 commands; 200,000 characters each |
| Favourites and schedules                                   | `terminal.db`                                                          | 50 schedules                            |
| Every command, as an audit event                           | The [Live Feed](/docs/guides/observability), tool `dashboard_terminal` | The dashboard's retention               |
| Shell sessions (output only)                               | `terminal-recordings/` beside the dashboard database                   | 5 MB each; newest 200                   |
| Pane layout, titles, colours, workspaces, broadcast groups | The browser (`localStorage`)                                           | —                                       |
| The last blocks of each pane                               | The browser (`localStorage`)                                           | 40 blocks; 20,000 characters each       |

Scheduled commands and Safe Mode actions are audit events too. For a Shell pane, the audit feed has the opening and the closing of the session; the content is in the recording.

## API

The page uses these routes on the dashboard port. All of them need the dashboard token when one is set, and all except `state` answer 403 when the terminal is turned off.

| Endpoint                                          | Does                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/terminal/state`                         | Whether the terminal is available, why not, and whether the server is read-only. |
| `POST /api/terminal/run`                          | Runs `{device, command, maxMs?, snapshot?}`. The answer is a stream (see below). |
| `POST /api/terminal/probe`                        | Round trip to the router, its identity and transport, and the Safe Mode state.   |
| `POST /api/terminal/highlight`                    | The router's token class for each character of `{device, input}`.                |
| `POST /api/terminal/complete`                     | The words the router offers for `{device, input}`.                               |
| `POST /api/terminal/syntax`                       | The router's explanations of what can follow `{device, input}`.                  |
| `POST /api/terminal/safe-mode`                    | `{device, action}` with `enable`, `commit` or `rollback`.                        |
| `POST /api/terminal/changes`                      | Diff of the newest snapshot of `{device}` against the router.                    |
| `GET` / `DELETE /api/terminal/history`            | Reads (`device`, `q`, `limit`) or deletes (`id`, `device`, or all) the history.  |
| `GET` / `POST` / `DELETE /api/terminal/favorites` | Reads, saves or removes a favourite.                                             |
| `GET` / `POST` / `DELETE /api/terminal/schedules` | Reads, creates or removes a schedule. Only reads are accepted.                   |
| `GET /api/terminal/suggest?q=`                    | Known commands and MCP tools whose words match.                                  |
| `POST /api/terminal/share`                        | Starts a shared view of `{device}` and returns its id.                           |
| `GET /api/terminal/shared?id=`                    | The commands of a shared view.                                                   |
| `POST /api/terminal/shell/open`                   | Opens a shell on `{device, cols, rows}`. The answer body is the terminal output. |
| `POST /api/terminal/shell/input`                  | Sends `{id, data}` (keys) to a shell.                                            |
| `POST /api/terminal/shell/resize`                 | Sets the window size `{id, cols, rows}` of a shell.                              |
| `POST /api/terminal/shell/close`                  | Closes a shell.                                                                  |
| `GET /api/terminal/recordings`                    | Lists the shell recordings.                                                      |
| `GET /api/terminal/recording?id=`                 | One recording, as asciicast v2 text.                                             |

`POST /api/terminal/run` answers with newline-delimited JSON:

```text
{"t":"start","ts":1794936926342,"device":"lab","risk":"READ","snapshot":false}
{"t":"out","d":"  uptime: 2d21h\r\n"}
{"t":"end","ok":true,"ms":98,"stopped":false,"historyId":12,"transport":"ssh","retryable":false}
```

Closing the request stops the command on the router. A shell works the same way: the open request stays open and carries the output, and closing it closes the session. Because both are plain HTTP, they work through the remote dashboard.

Requests that change something are refused when they come from another origin.

## Limits to know

- A block pane runs each command by itself. Menus, prompts and live monitors need a Shell pane.
- Output is live over SSH. A router reached over REST or MAC-Telnet, and a command that runs in Safe Mode, return the output in one piece.
- The find bar does not search Shell panes, collapsed blocks, or panes behind another tab.
- Syntax check, completion and help use `/console/inspect`, which MikroTik does not document. Its answers can differ between RouterOS versions.
- Match highlighting in the find bar needs Chrome 105, Safari 17.2 or Firefox 140, or newer. Older browsers still count and jump to results.
