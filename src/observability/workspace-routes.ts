import { z } from "zod";
import { createContext } from "../core/context";
import { clientCheckTools } from "../tools/client-check";
import { DashboardInputError, readOperationBody } from "./bounded-request";

const routes: Record<string, string> = {
  "GET /api/client-checks": "list_client_checks",
  "POST /api/client-checks": "create_client_check",
  "POST /api/client-checks/close": "close_client_check",
  "POST /api/client-checks/compare": "compare_client_checks",
};
export async function workspaceRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!/^\/api\/(client-checks)(\/|$)/.test(url.pathname)) return null;
  try {
    const name = routes[`${req.method} ${url.pathname}`],
      tool = [...clientCheckTools].find((t) => t.name === name);
    if (!tool) return Response.json({ error: "Unsupported workspace route" }, { status: 405 });
    const device = url.searchParams.get("device");
    if (!device) throw new Error("Choose a router explicitly.");
    const input = req.method === "POST" ? JSON.parse(await readOperationBody(req, 32768)) : {};
    const output = await tool.handler(
      z.object(tool.inputSchema).strict().parse(input),
      createContext(undefined, device),
    );
    return new Response(output as string, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Workspace operation failed" },
      {
        status: e instanceof DashboardInputError ? e.status : 400,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
