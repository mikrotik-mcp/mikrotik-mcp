import { z } from "zod";
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import type { RiskLevel } from "../core/access";
import { assertDeviceAccess } from "../core/scoped-access";
import { resolveDeviceName } from "../core/runtime";
import { looksLikeError } from "../core/routeros";
import { parseKeyValues, parseRecords } from "../core/routeros-parse";
import { webProxyTools } from "../tools/web-proxy";
import { readOperationBody, DashboardInputError } from "./bounded-request";
import { clientError, errorResponse } from "./http-error";
import { recordToolCall } from "./recorder";
import { PROXY_RANGES } from "./web-proxy-history";
import type { ProxyHistory, ProxyRange } from "./web-proxy-history";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
function permitted(device: string, name: string, risk: RiskLevel) {
  try {
    assertDeviceAccess([device], name, risk);
    return true;
  } catch {
    return false;
  }
}
function requireAccess(device: string, name: string, risk: RiskLevel) {
  if (!permitted(device, name, risk))
    throw new DashboardInputError(403, "This operation is outside the current access scope.");
}
const mutations = {
  settings: { name: "update_web_proxy", risk: "DANGEROUS" },
  add: { name: "add_web_proxy_access_rule", risk: "WRITE" },
  remove: { name: "remove_web_proxy_access_rule", risk: "DESTRUCTIVE" },
} as const;
export async function webProxyRoutes(req: Request, url: URL, history?: ProxyHistory) {
  if (!url.pathname.startsWith("/api/web-proxy/")) return null;
  try {
    const requested = url.searchParams.get("device");
    if (!requested) throw new DashboardInputError(400, "Select a router.");
    const device = resolveDeviceName(requested);
    const ctx = createContext(undefined, device);
    const action = url.pathname.slice("/api/web-proxy/".length);
    if (req.method === "GET") {
      ctx.risk = "READ";
      if (action === "history") {
        requireAccess(device, "monitor_web_proxy", "READ");
        const range = url.searchParams.get("range") ?? "1h";
        if (!Object.hasOwn(PROXY_RANGES, range))
          throw new DashboardInputError(400, "Unknown time range.");
        if (!history) throw new DashboardInputError(503, "Proxy history storage is unavailable.");
        return json(history.report(device, range as ProxyRange));
      }
      if (action === "settings") {
        requireAccess(device, "get_web_proxy", "READ");
        const raw = await executeMikrotikCommand("/ip proxy print", ctx);
        const settings = parseKeyValues(raw);
        if (!settings.enabled) throw new Error("The router did not return its web proxy settings.");
        return json({
          settings,
          canEdit: permitted(device, mutations.settings.name, mutations.settings.risk),
        });
      }
      if (action === "rules") {
        requireAccess(device, "list_web_proxy_access_rules", "READ");
        // Read the .id and the match fields together. Never target a mutable print row number.
        let records: Record<string, string>[];
        try {
          const result = await executeMikrotikCommand(
            ":put [:serialize to=json options=json.no-string-conversion value=[/ip proxy access print as-value]]",
            ctx,
          );
          records = JSON.parse(result);
          if (!Array.isArray(records)) throw new Error("Invalid rule list");
        } catch {
          const raw = await executeMikrotikCommand("/ip proxy access print detail", ctx);
          if (looksLikeError(raw)) throw new Error(raw);
          records = parseRecords(raw).rows;
        }
        return json({
          rules: records.map((r) => ({
            id: r[".id"] ?? null,
            action: r.action,
            src: r["src-address"],
            dst: r["dst-address"],
            host: r["dst-host"],
            path: r.path,
            method: r.method,
            port: r["dst-port"],
            localPort: r["local-port"],
            redirect: r["redirect-to"],
            hits: r.hits,
            comment: r.comment,
            disabled:
              String(r.disabled) === "true" || r.disabled === "yes" || r.flags?.includes("X"),
          })),
          canAdd: permitted(device, mutations.add.name, mutations.add.risk),
          canRemove: permitted(device, mutations.remove.name, mutations.remove.risk),
        });
      }
    }
    if (req.method !== "POST" || !Object.hasOwn(mutations, action))
      throw new DashboardInputError(405, "Unsupported proxy operation.");
    const { name, risk } = mutations[action as keyof typeof mutations];
    requireAccess(device, name, risk);
    const tool = webProxyTools.find((t) => t.name === name)!;
    const input = z
      .object(tool.inputSchema ?? {})
      .strict()
      .parse(JSON.parse(await readOperationBody(req)));
    if (action === "remove" && !/^\*[0-9a-f]+$/i.test(String(input.rule_id)))
      throw new DashboardInputError(400, "Select a rule by its router ID.");
    ctx.risk = risk;
    const started = Date.now();
    let message = "Proxy operation failed",
      ok = false;
    try {
      const output = await tool.handler(input as never, ctx);
      if (typeof output !== "string") throw new Error("Unexpected web proxy response.");
      message = output;
      ok =
        !looksLikeError(message) && !/^(?:Refusing|Failed|No updates)|not found\./i.test(message);
      return json(ok ? { ok } : { error: clientError(message) }, ok ? 200 : 400);
    } finally {
      recordToolCall({
        tool: name,
        title: tool.title,
        risk,
        device,
        ts: started,
        durationMs: Date.now() - started,
        isError: !ok,
        args: { ...input, source: "dashboard" },
        output: message.split("\n")[0] ?? "",
        hasStructured: false,
      });
    }
  } catch (e) {
    if (e instanceof z.ZodError || e instanceof SyntaxError)
      return json({ error: "Invalid proxy settings or rule." }, 400);
    if (e instanceof DashboardInputError) return json({ error: e.message }, e.status);
    return errorResponse(e);
  }
}
