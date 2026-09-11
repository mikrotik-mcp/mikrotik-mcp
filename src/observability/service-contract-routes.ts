/** Token gating is handled by the dashboard; handlers additionally enforce tool/device access. */
import { z } from "zod";
import { createContext } from "../core/context";
import { serviceContractTools } from "../tools/service-contracts";
import { readOperationBody, DashboardInputError } from "./bounded-request";

export async function serviceContractRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/service-contracts")) return null;
  const route = `${req.method} ${url.pathname}`;
  const names: Record<string, string> = {
    "GET /api/service-contracts": "list_service_contracts",
    "GET /api/service-contracts/targets": "list_service_probe_targets",
    "POST /api/service-contracts": "create_service_contract",
    "POST /api/service-contracts/run": "run_service_contract",
    "GET /api/service-contracts/history": "service_contract_history",
  };
  const tool = serviceContractTools.find((t) => t.name === names[route]);
  if (!tool) return Response.json({ error: "Unsupported service contract route" }, { status: 405 });
  try {
    const raw = req.method === "POST" ? await readOperationBody(req) : "";
    if (raw.length > 8192) return Response.json({ error: "Request too large" }, { status: 413 });
    const input =
      req.method === "POST" ? JSON.parse(raw) : { id: url.searchParams.get("id") ?? undefined };
    const args = z.object(tool.inputSchema).parse(input);
    const result = await tool.handler(
      args,
      createContext(undefined, url.searchParams.get("device") ?? undefined),
    );
    return new Response(result as string, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DashboardInputError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      {
        error:
          "Service contract request failed. Check input, device access, approved targets and local storage.",
      },
      { status: 400 },
    );
  }
}
