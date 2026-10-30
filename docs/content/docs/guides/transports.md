---
title: "Transports"
description: "Practical setup, operations and limits for Transports."
---

> Two different things are called "transport" in this project. **This page is
> about how an MCP client reaches the server.** How the server reaches a
> _router_ — SSH, MAC-Telnet or the RouterOS REST API — is a separate axis,
> documented in **[Configuration](/docs/guides/configuration#rest-api-routeros-79)**.
> The dashboard labels them `mcp transport` and `device link` for the same
> reason.

Select the MCP transport with `--transport` (`MIKROTIK_MCP__TRANSPORT`).
The default is `stdio`. There are two implementations; the accepted `sse`
configuration value currently uses the Streamable HTTP implementation.

| Transport                | Value             | Best for                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------- |
| Standard I/O             | `stdio` (default) | Local clients like Claude Desktop; one client per process. |
| Streamable HTTP          | `streamable-http` | Networked / remote clients; the modern MCP HTTP transport. |
| HTTP compatibility value | `sse`             | Same implementation as Streamable HTTP; not legacy SSE.    |

Both HTTP configuration values use the same `Bun.serve` listener, endpoints
and security logic below. See [Connecting clients](/docs/guides/connecting-clients)
for app-specific configuration formats.

## stdio

The default. The server reads JSON-RPC from **stdin** and writes responses to
**stdout**; all logs go to **stderr**. There is no network listener — the client
launches the binary as a subprocess and talks to it over the pipe.

```bash
mikrotik-mcp serve                       # transport defaults to stdio
mikrotik-mcp serve --transport stdio     # explicit
```

> Because stdout is the protocol channel, never print to stdout from custom
> code — it would corrupt the stream. The built-in logger writes to stderr for
> exactly this reason.

## streamable-http

```bash
mikrotik-mcp serve \
  --transport streamable-http \
  --mcp-host 127.0.0.1 \
  --mcp-port 8000
```

Each initialization creates a separate MCP server session with a generated
`Mcp-Session-Id`. The client must preserve that header on subsequent requests.
JSON responses are enabled. Reconnect clients after restarting the server;
session separation does not create separate router credentials or permissions.

## sse

```bash
mikrotik-mcp serve --transport sse --mcp-port 8000
```

This accepted configuration value uses the same listener and Streamable HTTP
implementation. It does **not** expose the legacy `/sse` and `/messages`
endpoint pair. Prefer `streamable-http`; a legacy SSE-only client needs an
update or a compatible protocol adapter.

## Endpoints

Both HTTP configuration values expose these endpoints:

| Path                 | Method  | Purpose                                            |
| -------------------- | ------- | -------------------------------------------------- |
| `/mcp` (and `/mcp/`) | per MCP | The MCP JSON-RPC endpoint. Point your client here. |
| `/health`            | `GET`   | Liveness probe. Returns `200 OK` with body `OK`.   |

Any other path returns `404 Not Found`. A client connecting over HTTP uses a URL
like `http://your-host:8000/mcp`.

```bash
curl http://127.0.0.1:8000/health        # -> OK
```

## DNS-rebinding protection

When served over HTTP, the SDK can reject requests whose `Host`/`Origin` headers
aren't on an allow-list, defeating DNS-rebinding attacks from a browser. The
server reconciles this protection with the **actual bind host** so you don't have
to hand-tune it for the common cases. The logic:

| Situation                                                                  | Behavior                                                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--mcp-allowed-hosts` contains `*`                                         | Protection **disabled**. A warning is logged. Use only when the listener is already restricted to trusted clients.                      |
| An explicit allow-list is set (hosts and/or origins)                       | Protection **enabled** with exactly your allow-list.                                                                                    |
| Bind host is localhost (`127.0.0.1`, `localhost`, `::1`) and no allow-list | Protection **enabled** with a secure localhost allow-list (`127.0.0.1:*`, `localhost:*`, `[::1]:*` and the matching `http://` origins). |
| Bind host is a public interface (e.g. `0.0.0.0`) and no allow-list         | Protection **disabled**, with a warning. This avoids every request being rejected with HTTP 421 behind a reverse proxy.                 |

Note that `0.0.0.0` is treated as a public bind, not localhost — binding to it
without an allow-list disables the `Host` check.

### Behind a reverse proxy

The bundled HTTP listener does not validate bearer tokens or provide OAuth.
The dashboard token does not authenticate `/mcp`. For remote access, use an
authenticated HTTPS MCP gateway and restrict access to the underlying listener.

If you terminate TLS or route through a gateway on a public host, set an explicit
allow-list to your real domain so rebinding protection stays on. For a gateway
on the same machine:

```bash
mikrotik-mcp serve \
  --transport streamable-http \
  --mcp-host 127.0.0.1 \
  --mcp-port 8000 \
  --mcp-allowed-hosts mcp.example.com \
  --mcp-allowed-origins https://mcp.example.com
```

Both `--mcp-allowed-hosts` and `--mcp-allowed-origins` accept comma-separated
lists. They are not authentication. A gateway on another host needs a reachable
private bind address and network access controls rather than loopback.

See [Security](/docs/guides/security) for how this fits the wider threat model.
