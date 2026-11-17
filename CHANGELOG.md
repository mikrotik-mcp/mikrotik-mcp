# Changelog

Notable changes to `@usex/mikrotik-mcp`. Releases before 6.14.1 are described in
the GitHub release notes.

## 6.15.0 — unreleased

### Added

- **Dashboard Terminal page.** RouterOS consoles in dockable panes: split,
  resize, move, stack as tabs, float and maximise, with several panes per router
  and the layout restored after a reload.
  - Each command is a block with live output, a Stop button, copy output, copy
    command, run again, watch (run again every 5 s and mark changed lines) and
    add to favourites.
  - Each pane shows its connection state, the router identity, the transport,
    the round-trip latency with a sparkline, and command counts. A lost
    connection is retried with a growing delay.
  - Syntax highlighting with Shiki and a RouterOS TextMate grammar. The router
    also checks the input (`/console/inspect request=highlight`) and marks what
    it does not accept before the command runs. Tab completes from the router.
  - Completion opens while you type, and an earlier command that starts with
    the input is suggested inline (`→` accepts it).
  - Find bar (`Ctrl+F`): search one terminal or all terminals, with match case,
    whole words, regular expressions, a result counter, next/previous and a
    filter that hides blocks without a match.
  - Per-pane command time limit (30 s, 2 min, 10 min) and watch interval.
  - A pane keeps its last 40 blocks across a reload.
  - Interactive shell panes: a real RouterOS console over one SSH PTY
    (xterm.js), for menus, prompts and live monitors. Keys are not recorded.
  - Safe Mode from a pane: enable, commit, roll back.
  - Optional config snapshot before every command that is not a read, with a
    "what changed?" diff. A failed snapshot stops the command.
  - Snippets with `{{name}}` / `{{name=default}}` placeholders.
  - Table view of a `print` output; comparison of two outputs.
  - Script runner with a syntax check that runs nothing.
  - Inline help and completion descriptions from the router.
  - Broadcast groups with a result summary; named workspaces.
  - Alerts on a watched command; export of a pane or a block.
  - Right-click a pane tab to rename the pane or give it a colour.
  - Command history and favourites are saved on the server
    (`~/.mikrotik-mcp/terminal.db`). Any entry can be run again on any router.
  - Broadcast runs one command in every open pane.
  - Destructive commands (`remove`, `reboot`, `reset-configuration`, …) ask for
    confirmation. A read-only server runs only `print`, `export` and
    diagnostic commands.
  - Auto-retry sends a command again only when the router was not reached or
    the command only reads. A change that may already have run is not repeated.
  - Every command is written to the audit feed as `dashboard_terminal`.
- `dashboard.terminal` (`--dashboard-terminal`, `MIKROTIK_DASHBOARD__TERMINAL`,
  default `true`). The terminal is served only when the dashboard has a token or
  listens on loopback, because it runs any command on a router.

## 6.14.1 — 2026-11-17

### Fixed

- **Streamable HTTP: clients now recover after the server loses their session.**
  A request with an `Mcp-Session-Id` the server did not know (after a service
  restart, or after the session was closed) created a new, uninitialized
  transport and was answered with HTTP 400 `Server not initialized`. MCP clients
  such as `mcp-remote` initialize again only on HTTP 404, so the connector stayed
  broken until the host application was restarted. The server now answers
  HTTP 404 with JSON-RPC error `-32001` `Session not found`, and the client
  initializes again by itself.
- **Streamable HTTP: no server instance is leaked per stray request.** Each such
  request also built a full server instance that was never closed. A transport
  and server are now created only for an `initialize` POST without a session id.
  Any other request without a session id gets HTTP 400. A failed `initialize`,
  a closed transport and `DELETE /mcp` each close both the transport and its
  server.
- **Streamable HTTP: a localhost bind works without `--mcp-allowed-hosts`.** The
  built-in allow-list used `127.0.0.1:*`, but the Host header is compared
  exactly, so every request got HTTP 403 `Invalid Host header`. The allow-list
  now holds the real port.
- **SSH: no `MaxListenersExceededWarning` on a busy pooled connection.** Each
  command in flight added its own `error`, `end` and `close` listeners to the
  shared connection, so eight concurrent commands passed Node's limit of ten.
  All commands on a connection now share one set of listeners.

### Added

- `mcp.sessionIdleTimeout` (`--mcp-session-idle-timeout`,
  `MIKROTIK_MCP__SESSION_IDLE_TIMEOUT`): an HTTP session with no request for this
  many milliseconds is closed. Default: 24 hours. Every request resets it.
- One `INFO` log line for each session that is created, evicted or expired, with
  the session id and the reason.
