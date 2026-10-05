import { createContext } from "../core/context";
import {
  listOpenVpnSessions,
  disconnectOpenVpnSession,
  disconnectOpenVpnInput,
  OpenVpnOperationError,
} from "../core/openvpn-sessions";
import { readOperationBody, DashboardInputError } from "./bounded-request";
import { clientError, errorResponse } from "./http-error";
import { getIpGeo } from "./geo";

/** Outer dashboard authentication and error mapping still apply; writes also enforce scoped access. */
export async function openVpnRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/openvpn/sessions" && url.pathname !== "/api/openvpn/disconnect")
    return null;
  try {
    const device = url.searchParams.get("device");
    if (!device?.trim()) throw new DashboardInputError(400, "Select an explicit router first.");
    const ctx = createContext(undefined, device);
    let result: unknown;
    if (req.method === "GET" && url.pathname === "/api/openvpn/sessions") {
      const snapshot = await listOpenVpnSessions(ctx);
      result = {
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          sourceGeo: getIpGeo(session.callerId),
        })),
      };
    } else if (req.method === "POST" && url.pathname === "/api/openvpn/disconnect") {
      const body = await readOperationBody(req);
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        throw new DashboardInputError(400, "Provide a valid JSON request.");
      }
      const parsed = disconnectOpenVpnInput.safeParse(input);
      if (!parsed.success)
        throw new DashboardInputError(
          400,
          "A valid session token and explicit confirmation are required.",
        );
      result = await disconnectOpenVpnSession(parsed.data, ctx);
    } else return Response.json({ error: "Method not allowed" }, { status: 405 });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof DashboardInputError || error instanceof OpenVpnOperationError)
      return Response.json(
        { error: clientError(error) },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    const response = errorResponse(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
