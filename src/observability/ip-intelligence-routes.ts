import { IpIntelligenceInput, lookupIpIntelligence } from "../core/ip-intelligence";
import { readOperationBody, DashboardInputError } from "./bounded-request";

/** Outer token authentication still applies; lookup is explicit and same-origin. */
export async function ipIntelligenceRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/ip-intelligence") return null;
  const headers = { "cache-control": "no-store" };
  if (req.method !== "POST")
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  try {
    const text = await readOperationBody(req, 512);
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return Response.json({ error: "Provide a valid JSON request" }, { status: 400, headers });
    }
    const parsed = IpIntelligenceInput.safeParse(input);
    if (!parsed.success)
      return Response.json(
        { error: "Enter a valid IPv4 or IPv6 address, without a hostname, URL, port or CIDR." },
        { status: 400, headers },
      );
    return Response.json(await lookupIpIntelligence(parsed.data), { headers });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof DashboardInputError
            ? error.message
            : "IP lookup is busy. Please retry shortly.",
      },
      { status: error instanceof DashboardInputError ? error.status : 503, headers },
    );
  }
}
