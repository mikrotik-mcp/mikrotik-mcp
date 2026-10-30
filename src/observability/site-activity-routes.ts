import { isIP } from "node:net";
import { getFlowCollector } from "../flows/collector";
import type { SiteActivityStore } from "./site-activity";
import { SITE_DNS_PORT } from "./site-activity-collector";

export async function siteActivityRoutes(
  req: Request,
  url: URL,
  store?: SiteActivityStore,
): Promise<Response | null> {
  if (
    !["/api/site-activity", "/api/site-activity/export", "/api/site-activity/policy"].includes(
      url.pathname,
    )
  )
    return null;
  if (!store)
    return Response.json({ error: "Site activity storage is unavailable" }, { status: 503 });
  if (url.pathname.endsWith("/policy")) {
    if (req.method === "GET") return Response.json(store.policy());
    if (req.method !== "PUT")
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    try {
      const body: unknown = await req.json();
      if (!body || typeof body !== "object") throw new Error("Invalid policy");
      const policy = body as Record<string, unknown>;
      if (
        typeof policy.enabled !== "boolean" ||
        !Array.isArray(policy.owners) ||
        policy.owners.length > 100 ||
        policy.owners.some(
          (owner) => typeof owner !== "string" || !owner.trim() || owner.length > 256,
        ) ||
        (policy.until !== null &&
          (!Number.isSafeInteger(policy.until) || Number(policy.until) <= Date.now()))
      )
        throw new Error("Invalid policy");
      store.setPolicy({
        enabled: policy.enabled,
        owners: [...new Set(policy.owners as string[])],
        until: policy.until as number | null,
      });
      return Response.json(store.policy());
    } catch {
      return Response.json({ error: "Invalid activity policy" }, { status: 400 });
    }
  }
  if (req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const now = Date.now();
  const from = Number(url.searchParams.get("from") ?? now - 86_400_000);
  const to = Number(url.searchParams.get("to") ?? now);
  const client = url.searchParams.get("client") ?? "";
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const kind = url.searchParams.get("kind") ?? "";
  const owner = url.searchParams.get("owner") ?? "";
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to - from > 30 * 86_400_000 ||
    (client && !isIP(client)) ||
    search.length > 128 ||
    owner.length > 256 ||
    !["", "wifi", "lan", "lan-wifi", "openvpn", "proxy", "unknown"].includes(kind) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100_000
  )
    return Response.json({ error: "Invalid activity filters" }, { status: 400 });
  try {
    const filters = { from, to, client, search, kind, owner };
    if (url.pathname.endsWith("/export")) {
      const csv = (value: string | number | null) =>
        `"${String(value ?? "")
          .replace(/"/g, '""')
          .replace(/^([=+@-])/, "'$1")}"`;
      const columns = [
        "Client IP",
        "Connection",
        "Owner",
        "Router",
        "Domain",
        "Destination IP",
        "Evidence",
        "First seen",
        "Last seen",
        "Observations",
        "Bytes",
      ];
      const rows = store
        .visits(filters, 0, 10_000)
        .map((r) => [
          r.client,
          r.kind,
          r.owner,
          r.device,
          r.domain,
          r.destination,
          r.source,
          new Date(r.firstSeen).toISOString(),
          new Date(r.lastSeen).toISOString(),
          r.connections,
          r.bytes,
        ]);
      return new Response([columns, ...rows].map((row) => row.map(csv).join(",")).join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": "attachment; filename=site-activity.csv",
          "cache-control": "no-store",
        },
      });
    }
    return Response.json({
      from,
      to,
      clients: store.clients(from, to),
      identities: store.identities(from, to),
      policy: store.policy(),
      visits: store.visits(filters, offset),
      summary: store.summary(filters),
      collection: {
        flows: getFlowCollector().stats(),
        dnsPort: SITE_DNS_PORT,
        proxyLogs: "polled",
      },
      note: "Only observed traffic is shown. DNS evidence is client-specific and time-limited; IP-only rows have no reliable hostname. HTTPS paths and page content are not collected.",
    });
  } catch {
    return Response.json({ error: "Could not read site activity" }, { status: 503 });
  }
}
