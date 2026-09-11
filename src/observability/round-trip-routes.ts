import { createContext } from "../core/context";
import { roundTripTools } from "../tools/round-trip";
import { readOperationBody, DashboardInputError } from "./bounded-request";

export async function roundTripRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/round-trip") return null;
  if (req.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
  try {
    const input = JSON.parse(await readOperationBody(req));
    const result = await roundTripTools[0].handler(
      input,
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
          "Path analysis failed. Check topology, device access, snapshot ownership, age and capture skew.",
      },
      { status: 400 },
    );
  }
}
