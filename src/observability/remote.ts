/**
 * Remote dashboard — `mikrotik-mcp dashboard --server <url>`.
 *
 * Runs the dashboard on a machine that has no MCP server and no device config.
 * It is a reverse proxy to the dashboard port of a server started with
 * `--dashboard` somewhere else: REST, SSE and WebSocket all pass through. The
 * page itself is this machine's own build (`bun run build:ui`) when there is
 * one, so local UI work shows here; without a build the server's page is used.
 * The server's token is added here, so the browser never holds it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { serve } from "bun";
import { logger } from "../logger";
import { UI_DIST_DIR } from "../paths";

export interface RemoteDashboardOptions {
  /** Base URL of the server's dashboard, e.g. `http://192.168.1.10:9090`. */
  server: string;
  /** The server's `--dashboard-token`, when it has one. */
  token?: string;
  host: string;
  port: number;
}

/** Validate the server URL and reduce it to its origin (no path, query or credentials). */
export function serverOrigin(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error(`--server must be a URL like http://192.168.1.10:9090 (got "${server}")`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`--server must use http or https (got "${url.protocol}")`);
  return url.origin;
}

/** Where a local request goes on the server. `ws` picks the WebSocket scheme. */
export function upstreamUrl(origin: string, pathAndQuery: string, ws = false): string {
  const url = new URL(pathAndQuery, origin);
  if (ws) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** Request headers for the server: the client's own, minus hop headers, plus the token. */
export function upstreamHeaders(incoming: Headers, token?: string): Headers {
  const out = new Headers(incoming);
  // `host` must name the server; a client-sent `authorization` must not reach it.
  // `origin` names this proxy, not the server, so the server's same-origin check
  // would refuse every write. The proxy makes that check itself (`crossOrigin`).
  for (const name of ["host", "connection", "authorization", "accept-encoding", "origin"])
    out.delete(name);
  if (token) out.set("authorization", `Bearer ${token}`);
  return out;
}

/** True when a browser sent the request from a page of another origin. */
export function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin !== new URL(req.url).origin;
}

/** This machine's built dashboard page, or undefined when it has not been built. */
export function localPage(dir = UI_DIST_DIR): string | undefined {
  try {
    return readFileSync(join(dir, "observability.html"), "utf8");
  } catch {
    return undefined;
  }
}

interface Bridge {
  target: string;
  upstream?: WebSocket;
}

export function runRemoteDashboard(options: RemoteDashboardOptions): { stop: () => void } {
  const origin = serverOrigin(options.server);
  const auth = options.token ? { authorization: `Bearer ${options.token}` } : undefined;

  const server = serve<Bridge>({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0, // SSE and long polls stay open
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname + url.search;
      // The server cannot see the browser's origin any more, so it is checked here.
      if (crossOrigin(req)) return new Response("Cross-origin operation denied", { status: 403 });

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const target = upstreamUrl(origin, path, true);
        return srv.upgrade(req, { data: { target } })
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Read per request: a rebuild shows on the next refresh, no restart.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const page = localPage();
        if (page !== undefined)
          return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      try {
        const res = await fetch(upstreamUrl(origin, path), {
          method: req.method,
          headers: upstreamHeaders(req.headers, options.token),
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          redirect: "manual",
          signal: req.signal,
        });
        // fetch already decoded the body, so these two no longer describe it.
        const headers = new Headers(res.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        return new Response(res.body, { status: res.status, headers });
      } catch (e) {
        if (req.signal.aborted) return new Response(null, { status: 499 });
        const reason = e instanceof Error ? e.message : String(e);
        return new Response(`Cannot reach the MikroTik MCP server at ${origin}: ${reason}`, {
          status: 502,
        });
      }
    },
    websocket: {
      open(ws: ServerWebSocket<Bridge>) {
        // Bun's WebSocket takes headers, so the token stays out of the URL.
        const upstream = new WebSocket(ws.data.target, { headers: auth } as never);
        ws.data.upstream = upstream;
        upstream.onmessage = (m) => ws.send(m.data as string);
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
      },
      message(ws: ServerWebSocket<Bridge>, message) {
        const upstream = ws.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
      },
      close(ws: ServerWebSocket<Bridge>) {
        ws.data.upstream?.close();
      },
    },
  });

  logger.info(
    `Remote dashboard ready — open http://${options.host === "0.0.0.0" ? "localhost" : options.host}:${options.port} ` +
      `(server ${origin}${options.token ? ", token set" : ""}, page: ` +
      `${localPage() === undefined ? "the server's — no local build, run `bun run build:ui` to use this machine's UI" : "this machine's build"})`,
  );
  if (options.host !== "127.0.0.1" && options.host !== "localhost" && options.host !== "::1") {
    logger.warn(
      "The remote dashboard is reachable from other machines and asks for no token of its own: " +
        "anyone who can open it gets the server's dashboard, including its config editor. " +
        "Bind it to 127.0.0.1 unless that is intended.",
    );
  }
  return { stop: () => server.stop(true) };
}
