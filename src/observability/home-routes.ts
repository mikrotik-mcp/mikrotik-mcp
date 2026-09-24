import { z } from "zod";
import { createContext } from "../core/context";
import { homeInternetTools } from "../tools/home-internet";
import { readOperationBody, DashboardInputError } from "./bounded-request";

const routes: Record<string, string> = {
  "GET /api/home-internet": "get_home_internet",
  "POST /api/home-internet/refresh": "refresh_home_devices",
  "POST /api/home-internet/name": "name_home_device",
  "POST /api/home-internet/diagnose": "diagnose_home_internet",
  "POST /api/home-internet/compare": "compare_home_paths",
  "POST /api/home-internet/preview": "preview_home_policy",
  "POST /api/home-internet/apply": "apply_home_policy",
  "POST /api/home-internet/undo": "undo_home_policy",
};
export async function homeRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/home-internet")) return null;
  const tool = homeInternetTools.find((t) => t.name === routes[`${req.method} ${url.pathname}`]);
  if (!tool) return Response.json({ error: "Unsupported Home Internet route" }, { status: 405 });
  try {
    const device = url.searchParams.get("device");
    if (!device) throw new Error("Choose a router explicitly.");
    const input = req.method === "POST" ? JSON.parse(await readOperationBody(req)) : {};
    const result = await tool.handler(
      z.object(tool.inputSchema).strict().parse(input),
      createContext(undefined, device),
    );
    return new Response(result as string, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof z.ZodError
            ? "Invalid input. Check IP/MAC addresses, duration and required fields."
            : e instanceof Error
              ? e.message
              : "Home Internet operation failed.",
      },
      {
        status: e instanceof DashboardInputError ? e.status : 400,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
