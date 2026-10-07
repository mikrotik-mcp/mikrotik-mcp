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
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import type { OpenVpnHistoryStore } from "./openvpn-history";

/** Outer dashboard authentication and error mapping still apply; writes also enforce scoped access. */
export async function openVpnRoutes(
  req: Request,
  url: URL,
  history?: OpenVpnHistoryStore,
): Promise<Response | null> {
  if (
    !["/api/openvpn/sessions", "/api/openvpn/disconnect", "/api/openvpn/history"].includes(
      url.pathname,
    )
  )
    return null;
  try {
    const device = url.searchParams.get("device");
    if (!device?.trim()) throw new DashboardInputError(400, "Select an explicit router first.");
    const ctx = createContext(undefined, device);
    let result: unknown;
    if (req.method === "GET" && url.pathname === "/api/openvpn/history") {
      let resolved: string;
      try {
        resolved = resolveDeviceName(device);
      } catch {
        throw new DashboardInputError(400, "Unknown router.");
      }
      try {
        assertDeviceAccess([resolved], "list_ovpn_sessions", "READ");
      } catch {
        throw new DashboardInputError(403, "Device access denied.");
      }
      if (!history)
        return Response.json({ error: "OpenVPN history storage is unavailable." }, { status: 503 });
      const user = url.searchParams.get("user") ?? "";
      const from = Number(url.searchParams.get("from") ?? 0);
      const to = Number(url.searchParams.get("to") ?? 8640000000000000);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (
        user.length > 256 ||
        ![from, to, offset].every(Number.isSafeInteger) ||
        from < 0 ||
        to < from ||
        to > 8640000000000000 ||
        offset < 0 ||
        offset > 1_000_000
      )
        throw new DashboardInputError(400, "Provide a valid user, date range and page.");
      result = history.report({ device: resolved, user, from, to, offset });
    } else if (req.method === "GET" && url.pathname === "/api/openvpn/sessions") {
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
