import { z } from "zod";
import { createContext } from "../core/context";
import { serviceRoutingTools } from "../tools/service-routing";
import { flightRecorderTools } from "../tools/flight-recorder";
import { readOperationBody, DashboardInputError } from "./bounded-request";

const routing: Record<string, string> = {
  "GET /api/flight-recorder": "get_flight_recorder",
  "POST /api/flight-recorder/configure": "configure_flight_recorder",
  "POST /api/flight-recorder/freeze": "freeze_network_incident",
  "POST /api/flight-recorder/export": "export_network_incident",
  "GET /api/service-routing": "list_service_routing",
  "GET /api/service-routing/inventory": "service_routing_inventory",
  "POST /api/service-routing": "create_service_routing",
  "POST /api/service-routing/probe": "probe_service_routing",
  "POST /api/service-routing/preview": "preview_service_routing",
  "POST /api/service-routing/apply": "apply_service_routing",
  "POST /api/service-routing/arm": "arm_service_routing",
};
export async function operationsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!["/api/service-routing", "/api/flight-recorder"].some((p) => url.pathname.startsWith(p)))
    return null;
  const tool = [...serviceRoutingTools, ...flightRecorderTools].find(
    (t) => t.name === routing[`${req.method} ${url.pathname}`],
  );
  if (!tool) return Response.json({ error: "Unsupported workspace operation" }, { status: 405 });
  try {
    const input = req.method === "POST" ? JSON.parse(await readOperationBody(req)) : {};
    const device = url.searchParams.get("device");
    if (!device) throw new DashboardInputError(400, "Select an explicit router first.");
    const result = await tool.handler(
      z.object(tool.inputSchema).parse(input),
      createContext(undefined, device),
    );
    return new Response(result as string, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Workspace operation failed" },
      { status: error instanceof DashboardInputError ? error.status : 400 },
    );
  }
}
