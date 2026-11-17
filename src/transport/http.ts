/**
 * Streamable-HTTP (and legacy SSE) transport on Bun's native `Bun.serve`.
 *
 * The SDK ships a Web-standard transport whose `handleRequest(Request)` returns
 * a `Response`, which slots directly into `Bun.serve` with no Node `http` shim.
 *
 * DNS-rebinding protection is reconciled with the actual bind host the same way
 * the Bun server did: a localhost bind gets a secure localhost
 * allowlist; an explicit allowlist is honored; binding to a public interface
 * with no allowlist disables the Host check (with a loud warning) so a reverse
 * proxy doesn't get every request rejected with HTTP 421.
 */
import { randomUUID } from "node:crypto";
import { serve } from "bun";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServerSettings } from "../config";
import { getConfig } from "../core/runtime";
import { checkForUpdate } from "../core/update-check";
import { corsHeaders } from "./cors";
import { logger } from "../logger";
import { createServer } from "../server";
import { VERSION } from "../version";

const LOCALHOST = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

interface SecuritySettings {
  enableDnsRebindingProtection: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

function buildSecurity(mcp: McpServerSettings): SecuritySettings {
  const hosts = mcp.allowedHosts
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const origins = mcp.allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (hosts.includes("*")) {
    logger.warn(
      "DNS-rebinding protection is DISABLED (allowed-hosts=*). Ensure the server is only reachable by trusted clients.",
    );
    return { enableDnsRebindingProtection: false };
  }
  if (hosts.length || origins.length) {
    logger.info(
      `DNS-rebinding protection enabled for hosts=[${hosts.join(",")}] origins=[${origins.join(",")}]`,
    );
    return {
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
      allowedOrigins: origins,
    };
  }
  if (LOCALHOST.has(mcp.host) && mcp.host !== "0.0.0.0") {
    // The SDK compares Host and Origin exactly, so each entry carries the real
    // port: a "127.0.0.1:*" pattern matches nothing and rejects every request.
    const names = ["127.0.0.1", "localhost", "[::1]"];
    return {
      enableDnsRebindingProtection: true,
      allowedHosts: names.map((name) => `${name}:${mcp.port}`),
      allowedOrigins: names.map((name) => `http://${name}:${mcp.port}`),
    };
  }
  logger.warn(
    `Serving HTTP on a non-localhost host (${mcp.host}) without an allow-list, so DNS-rebinding ` +
      "protection is disabled. Behind a reverse proxy, set --mcp-allowed-hosts to your domain.",
  );
  return { enableDnsRebindingProtection: false };
}

export async function runHttp(mcp: McpServerSettings): Promise<void> {
  const security = buildSecurity(mcp);
  // Counts for the startup banner (a throwaway build — served sessions get their
  // own server instances below).
  const { toolCount, promptCount, uiViewCount, readOnly } = createServer();

  // Session-keyed transports: an `initialize` request creates a transport and
  // its own server and returns an `Mcp-Session-Id`; later requests reuse them.
  // Nothing else may create one. A request with an id this process does not
  // know (after a restart, an eviction, or the idle TTL) gets HTTP 404, which is
  // what tells an MCP client to initialize again. A new transport here would
  // answer 400 "Server not initialized", which clients do not recover from.
  interface Session {
    transport: WebStandardStreamableHTTPServerTransport;
    server: { close: () => Promise<void> };
    lastSeen: number;
    /** Set when the cause is known before the transport reports its close. */
    closeReason?: string;
  }
  const sessions = new Map<string, Session>();

  const jsonError = (
    status: number,
    code: number,
    message: string,
    cors: Record<string, string>,
  ): Response =>
    Response.json(
      { jsonrpc: "2.0", error: { code, message }, id: null },
      { status, headers: cors },
    );

  /** Close a session's transport and server and forget it. Safe to call twice. */
  function evict(id: string, reason: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    logger.info(
      `MCP session ${id} evicted (${session.closeReason ?? reason}); ${sessions.size} open`,
    );
    void session.server.close().catch(() => {});
    void session.transport.close().catch(() => {});
  }

  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        const idle = now - session.lastSeen;
        if (idle >= mcp.sessionIdleTimeout) evict(id, `expired: idle ${Math.round(idle / 1000)}s`);
      }
    },
    Math.min(mcp.sessionIdleTimeout, 60_000),
  );
  sweep.unref?.();

  /** Answer an `initialize` POST with a new session, or close what was built. */
  async function openSession(req: Request, body: unknown): Promise<Response> {
    const { server } = createServer();
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        ...security,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastSeen: Date.now() });
          logger.info(`MCP session ${id} created; ${sessions.size} open`);
        },
      });
    // Set before connect(): the server chains its own close handler onto this.
    transport.onclose = () => {
      if (transport.sessionId) evict(transport.sessionId, "transport closed");
    };
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req, { parsedBody: body });
      // Rejected before a session existed (bad Host, bad protocol version, …).
      if (!transport.sessionId || !sessions.has(transport.sessionId))
        void server.close().catch(() => {});
      return res;
    } catch (error) {
      if (transport.sessionId) evict(transport.sessionId, "initialize failed");
      void server.close().catch(() => {});
      throw error;
    }
  }

  async function handleMcp(req: Request, cors: Record<string, string>): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const session = sessions.get(sid);
      if (!session) return jsonError(404, -32001, "Session not found", cors);
      session.lastSeen = Date.now();
      // The SDK closes the transport on DELETE, which evicts the session.
      if (req.method === "DELETE") session.closeReason = "deleted by client";
      return session.transport.handleRequest(req);
    }
    if (req.method !== "POST")
      return jsonError(400, -32000, "Bad Request: Mcp-Session-Id header is required", cors);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, -32700, "Parse error: Invalid JSON", cors);
    }
    const isInitialize = (Array.isArray(body) ? body : [body]).some(
      (message) => (message as { method?: unknown } | null)?.method === "initialize",
    );
    if (!isInitialize)
      return jsonError(400, -32000, "Bad Request: Mcp-Session-Id header is required", cors);
    return openSession(req, body);
  }

  const mcpPath = "/mcp";
  serve({
    hostname: mcp.host,
    port: mcp.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const cors = corsHeaders(req.headers.get("origin"), mcp.corsOrigins);

      // CORS preflight — answer before anything else (ChatGPT/Claude send this).
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      if (url.pathname === "/health") {
        return new Response("OK", {
          headers: { "content-type": "text/plain", ...cors },
        });
      }
      if (url.pathname === mcpPath || url.pathname === `${mcpPath}/`) {
        const res = await handleMcp(req, cors);
        if (Object.keys(cors).length === 0) return res;
        // Merge CORS onto the transport's response (its headers are preserved).
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
      return new Response("Not Found", { status: 404, headers: cors });
    },
  });

  logger.info(
    `MCP server ready on http://${mcp.host}:${mcp.port}${mcpPath} — ${toolCount} tools, ${promptCount} prompts, ${uiViewCount} app views ` +
      `(${mcp.transport})${readOnly ? " [READ-ONLY]" : ""}`,
  );

  // Background update whisper — seed the file cache so the next session's
  // instructions injection has data, and log the result to stderr.
  if (!getConfig().disableUpdateCheck) {
    void checkForUpdate()
      .then((r) => {
        if (r.release?.isNewer) {
          logger.info(
            `[update] MikroTik MCP v${r.release.version} available (running v${VERSION}). ` +
              `Upgrade: bun i -g @usex/mikrotik-mcp@latest`,
          );
        }
      })
      .catch(() => {});
  }
}
