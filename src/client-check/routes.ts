import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PROJECT_ROOT } from "../paths";
import { readOperationBody, DashboardInputError } from "../observability/bounded-request";
import { authorizedCheck, saveCheckRun } from "./service";
import { noteClientPresence } from "./presence";

const MiB = 1048576;
const budgets = new Map<
  string,
  { expires: number; bytes: number; requests: number; presenceRequests: number; active: number }
>();
/** Capability-only public surface. No dashboard cookie/token, router reads or arbitrary fetches. */
export async function clientCheckRoutes(
  req: Request,
  url: URL,
  peer = "unknown",
): Promise<Response | null> {
  if (url.pathname === "/client-check" && req.method === "GET") {
    try {
      return new Response(readFileSync(join(PROJECT_ROOT, "dist/ui/client-check.html"), "utf8"), {
        headers: {
          "content-type": "text/html;charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        },
      });
    } catch {
      return new Response("Client Check is not built. Run bun run build:ui.", { status: 503 });
    }
  }
  if (!url.pathname.startsWith("/client-check-api/")) return null;
  let budget: ReturnType<typeof budgets.get>;
  let acquired = false;
  try {
    const parts = url.pathname.split("/");
    if (parts.length !== 4) throw new Error("Invalid check endpoint");
    const [, , id, action] = parts;
    const token = req.headers.get("x-client-check-token") ?? "";
    const session = await authorizedCheck(id, token);
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin)
      throw new DashboardInputError(403, "Cross-origin test denied");
    if (
      ![
        "GET info",
        "GET ping",
        "GET download",
        "POST upload",
        "POST result",
        "POST presence",
      ].includes(`${req.method} ${action}`)
    )
      throw new DashboardInputError(405, "Unsupported test phase");
    for (const [key, b] of budgets) if (b.expires < Date.now()) budgets.delete(key);
    budget = budgets.get(id) ?? {
      expires: session.expiresAt,
      bytes: 0,
      requests: 0,
      presenceRequests: 0,
      active: 0,
    };
    if (
      (action === "presence" ? budget.presenceRequests >= 450 : budget.requests >= 300) ||
      budget.active >= 4
    )
      throw new DashboardInputError(429, "Session request budget reached");
    if (action === "presence") budget.presenceRequests++;
    else budget.requests++;
    budget.active++;
    budgets.set(id, budget);
    acquired = true;
    const headers = {
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (action === "presence") {
      await readOperationBody(req, 512);
      // Re-authorize after the body read: revocation/expiry must win over a slow client.
      const current = await authorizedCheck(id, token);
      noteClientPresence(current, peer, req.headers.get("user-agent") ?? "");
      return Response.json({ connected: true, at: Date.now() }, { headers });
    }
    if (action === "info")
      return Response.json(
        {
          id,
          label: session.label,
          expiresAt: session.expiresAt,
          runs: session.runs.length,
          maxRuns: 6,
          scope:
            "This browser → this MCP host. A local host measures LAN/VPN access, not internet speed.",
          maxBytesPerRun: 20 * MiB,
        },
        { headers },
      );
    if (session.runs.length >= 6) throw new DashboardInputError(429, "Six runs already saved");
    if (action === "ping")
      return Response.json({ ok: true, peerAddress: peer, at: Date.now() }, { headers });
    const reserve = (bytes: number) => {
      if (budget!.bytes + bytes > 128 * MiB)
        throw new DashboardInputError(429, "Session transfer budget reached");
      budget!.bytes += bytes;
    };
    if (action === "download") {
      reserve(4 * MiB);
      return new Response(randomBytes(4 * MiB), {
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "content-length": String(4 * MiB),
        },
      });
    }
    if (action === "upload") {
      reserve(MiB);
      if (Number(req.headers.get("content-length")) > MiB)
        throw new DashboardInputError(413, "Upload too large");
      const reader = req.body?.getReader();
      let bytes = 0;
      if (reader) {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          void reader.cancel().catch(() => {});
        }, 20000);
        try {
          while (true) {
            const chunk = await reader.read();
            if (timedOut) throw new DashboardInputError(408, "Upload timed out");
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MiB) {
              await reader.cancel();
              throw new DashboardInputError(413, "Upload too large");
            }
          }
        } finally {
          clearTimeout(timer);
          reader.releaseLock();
        }
      }
      return Response.json({ bytes }, { headers });
    }
    const result = await saveCheckRun(
      id,
      token,
      JSON.parse(await readOperationBody(req, 16384)),
      peer,
      url.origin,
    );
    return Response.json(result, { headers });
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof DashboardInputError
            ? e.message
            : "Check unavailable, expired or invalid. Create a new invitation if needed.",
      },
      {
        status: e instanceof DashboardInputError ? e.status : 400,
        headers: { "cache-control": "no-store" },
      },
    );
  } finally {
    if (budget && acquired) budget.active = Math.max(0, budget.active - 1);
  }
}
