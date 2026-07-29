# Transports

> Two different things are called "transport" in this project. **This page is
> about how an MCP client reaches the server.** How the server reaches a
> _router_ — SSH, MAC-Telnet or the RouterOS REST API — is a separate axis,
> documented in **[Configuration](./configuration.md#rest-api-routeros-79)**.
> The dashboard labels them `mcp transport` and `device link` for the same
> reason.

The server speaks one of three MCP transports, selected with `--transport`
(`MIKROTIK_MCP__TRANSPORT`). The default is `stdio`.

| Transport       | Value             | Best for                                                   |
| --------------- | ----------------- | ---------------------------------------------------------- |
| Standard I/O    | `stdio` (default) | Local clients like Claude Desktop; one client per process. |
| Streamable HTTP | `streamable-http` | Networked / remote clients; the modern MCP HTTP transport. |
| HTTP + SSE      | `sse`             | Legacy HTTP clients that expect Server-Sent Events.        |

Both HTTP variants are served by the same `Bun.serve` listener and share the
same endpoints and security logic below.

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
  --mcp-host 0.0.0.0 \
  --mcp-port 8000
```

The server runs as a stateless single-session transport (no session IDs; one
shared MCP session reused across requests) with JSON responses enabled.

## sse

```bash
mikrotik-mcp serve --transport sse --mcp-port 8000
```

Same listener and endpoints as `streamable-http`; choose it only when a client
specifically requires the older SSE-style transport.

## Endpoints

Both HTTP transports expose exactly two paths:

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

If you terminate TLS or route through a proxy on a public host, set an explicit
allow-list to your real domain so protection stays on:

```bash
mikrotik-mcp serve \
  --transport streamable-http \
  --mcp-host 0.0.0.0 \
  --mcp-port 8000 \
  --mcp-allowed-hosts mcp.example.com \
  --mcp-allowed-origins https://mcp.example.com
```

Both `--mcp-allowed-hosts` and `--mcp-allowed-origins` accept comma-separated
lists.

See [Security](./security.md) for how this fits the wider threat model.
