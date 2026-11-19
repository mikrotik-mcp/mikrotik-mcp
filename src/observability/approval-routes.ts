/**
 * Dashboard routes for human approval: list the requests, and let a person
 * approve or reject one. Deciding is a browser action only (same origin, behind
 * the dashboard token); no tool can do it.
 */
import { decideApproval, listApprovals } from "../core/approvals";
import { getConfig } from "../core/runtime";
import { DashboardInputError, readOperationBody } from "./bounded-request";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export async function approvalRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/approvals")) return null;
  const policy = getConfig().approvals;
  try {
    if (url.pathname === "/api/approvals" && req.method === "GET")
      return json({
        enabled: policy?.enabled === true,
        minRisk: policy?.minRisk ?? "DESTRUCTIVE",
        ttlMinutes: policy?.ttlMinutes ?? 30,
        requests: listApprovals(),
      });
    if (url.pathname === "/api/approvals/decide" && req.method === "POST") {
      // readOperationBody also refuses a cross-origin browser request.
      const body = JSON.parse((await readOperationBody(req)) || "{}") as Record<string, unknown>;
      if (typeof body.id !== "string" || typeof body.approve !== "boolean")
        return json({ error: "A request id and a decision are required." }, 400);
      const decided = decideApproval(
        body.id,
        body.approve,
        typeof body.note === "string" ? body.note : undefined,
        policy?.ttlMinutes ?? 30,
      );
      if (!decided)
        return json({ error: "That request is not waiting any more. Refresh the list." }, 409);
      return json({ request: decided });
    }
    return json({ error: "Unsupported approvals route" }, 405);
  } catch (error) {
    if (error instanceof DashboardInputError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: "The request body is not JSON." }, 400);
    throw error;
  }
}
