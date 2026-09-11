/** Dashboard adapter uses the MCP handlers, validation and device-scope guards. */
import { z } from "zod";
import { createContext } from "../core/context";
import { investigationTools } from "../tools/investigations";
import { readOperationBody, DashboardInputError } from "./bounded-request";
import { FlowPathError } from "../investigations/flow-path-service";

export async function investigationRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/investigations")) return null;
  const base = url.pathname === "/api/investigations";
  const flowTool =
    url.pathname === "/api/investigations/flow-path"
      ? "inspect_flow_path"
      : url.pathname === "/api/investigations/client-flows"
        ? "list_client_flow_candidates"
        : null;
  const match = url.pathname.match(/^\/api\/investigations\/([\da-f-]+)$/i);
  if (
    (!base && !match && !flowTool) ||
    (flowTool ? req.method !== "POST" : !base && req.method !== "GET") ||
    (base && !["POST", "GET"].includes(req.method))
  )
    return Response.json({ error: "Unsupported investigation route or method" }, { status: 405 });
  const name =
    flowTool ??
    (match
      ? "get_investigation"
      : req.method === "POST"
        ? "create_investigation"
        : "list_investigations");
  const tool = investigationTools.find((t) => t.name === name)!;
  try {
    const raw = req.method === "POST" ? await readOperationBody(req) : "";
    if (raw.length > 8192) return Response.json({ error: "Request too large" }, { status: 413 });
    const args = z
      .object(tool.inputSchema)
      .parse(match ? { id: match[1] } : raw ? JSON.parse(raw) : {});
    const result = await tool.handler(
      args,
      createContext(undefined, url.searchParams.get("device") ?? undefined),
    );
    return new Response(result as string, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof FlowPathError)
      return Response.json(
        { error: e.message },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    if (e instanceof DashboardInputError)
      return Response.json({ error: e.message }, { status: e.status });
    return Response.json(
      {
        error:
          e instanceof z.ZodError
            ? flowTool
              ? "Use exact IPv4 endpoints, TCP/UDP, valid ports and at most eight interface names."
              : "Invalid investigation input: use an IPv4 or colon-separated MAC client, a hostname/IP target and a service label."
            : "Investigation request failed. Check the selected device, access scope and local storage.",
      },
      { status: 400 },
    );
  }
}
