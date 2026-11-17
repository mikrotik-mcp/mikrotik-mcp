# Changelog

Notable changes to `@usex/mikrotik-mcp`. Releases before 6.14.1 are described in
the GitHub release notes.

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
