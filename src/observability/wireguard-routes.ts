/**
 * Dashboard routes for WireGuard remote users: list them, onboard one, revoke
 * one, and act on the expired ones. They run the same tool handlers the model
 * uses, so the behaviour is one piece of code.
 *
 * Onboarding returns the client profile, which holds the user's private key.
 * It goes to the browser that asked, with `no-store`, and is not written to the
 * audit record or kept on the server.
 */
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import type { ToolContext } from "../core/context";
import { parseAccountingUptimeSeconds } from "../core/openvpn-analytics";
import { looksLikeError } from "../core/routeros";
import { parseRecords, parseSize } from "../core/routeros-parse";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { isExpired, readUserComment } from "../core/wireguard-portal";
import { vpnOnboardTools } from "../tools/vpn-onboard";
import { DashboardInputError, readOperationBody } from "./bounded-request";
import { recordToolCall } from "./recorder";
import { z } from "zod";

const noStore = { "cache-control": "no-store" };
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStore });

type Risk = "READ" | "WRITE" | "DESTRUCTIVE";

async function runTool(
  name: string,
  device: string,
  risk: Risk,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = vpnOnboardTools.find((t) => t.name === name)!;
  assertDeviceAccess([device], name, risk);
  const ctx: ToolContext = createContext(undefined, device);
  ctx.risk = risk;
  const parsed = z.object(tool.inputSchema ?? {}).parse(args);
  const started = Date.now();
  const result = await tool.handler(parsed as never, ctx);
  const text = typeof result === "string" ? result : (result as { text: string }).text;
  if (risk !== "READ")
    recordToolCall({
      tool: name,
      title: tool.title,
      risk,
      device,
      ts: started,
      durationMs: Date.now() - started,
      isError: /^(?:Failed|Cannot|A WireGuard user named)/.test(text),
      // The first line only: the lines after it are the profile with the private key.
      args: { ...args, source: "dashboard" },
      output: text.split("\n")[0] ?? "",
      hasStructured: false,
    });
  return text;
}

export async function wireguardRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/wireguard/")) return null;
  try {
    if (url.pathname === "/api/wireguard/users" && req.method === "GET") {
      const device = resolveDeviceName(url.searchParams.get("device") ?? undefined);
      assertDeviceAccess([device], "list_wireguard_users", "READ");
      const ctx = createContext(undefined, device);
      ctx.risk = "READ";
      let includeUnmanaged = true;
      try {
        assertDeviceAccess([device], "list_wireguard_peers", "READ");
      } catch {
        includeUnmanaged = false;
      }
      const fields = "name,interface,comment,allowed-address,disabled,last-handshake,rx,tx";
      const [interfacesText, counters] = await Promise.all([
        executeMikrotikCommand(
          "/interface wireguard print detail proplist=name,listen-port,disabled,comment",
          ctx,
        ),
        executeMikrotikCommand(
          `:put [:serialize to=json options=json.no-string-conversion value=[/interface wireguard peers print as-value proplist=${fields}]]`,
          ctx,
        ).catch((error: unknown) => {
          if (
            /bad command name serialize|syntax error|expected end of command/i.test(String(error))
          )
            return "";
          throw error;
        }),
      ]);
      if (looksLikeError(interfacesText)) throw new Error(interfacesText);
      let rows: Record<string, string | number | boolean>[];
      if (counters.trim().startsWith("[")) {
        rows = JSON.parse(counters);
      } else {
        // Older RouterOS releases have no JSON serializer. Request the runtime fields explicitly.
        const detail = await executeMikrotikCommand(
          `/interface wireguard peers print detail proplist=${fields}`,
          ctx,
        );
        if (looksLikeError(detail)) throw new Error(detail);
        rows = parseRecords(detail).rows;
      }
      const host = getDevice(device).host;
      const interfaceOptions = parseRecords(interfacesText)
        .rows.filter((row) => row.name)
        .map((row) => ({
          name: row.name,
          comment: row.comment || "",
          disabled: row.disabled === "yes" || row.disabled === "true" || !!row.flags?.includes("X"),
          endpoint:
            host && row["listen-port"]
              ? `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${row["listen-port"]}`
              : "",
        }));
      const observedAt = Date.now();
      const today = new Date(observedAt).toISOString().slice(0, 10);
      const peers = rows.flatMap((row) => {
        const tag = readUserComment(String(row.comment ?? ""));
        if (!tag && !includeUnmanaged) return [];
        const iface = String(row.interface ?? "");
        const address = String(row["allowed-address"] ?? "");
        const lastHandshake =
          row["last-handshake"] == null ? null : String(row["last-handshake"]) || null;
        const age = parseAccountingUptimeSeconds(lastHandshake);
        return [
          {
            id: String(row[".id"] ?? `${iface}/${row.name ?? address}`),
            user: tag?.user || String(row.name || address || iface),
            interface: iface,
            comment: String(row.comment ?? ""),
            address,
            managed: !!tag,
            expires: tag?.expires ?? null,
            expired: isExpired(tag?.expires, today),
            disabled:
              ["yes", "true"].includes(String(row.disabled)) ||
              String(row.flags ?? "").includes("X"),
            lastHandshake,
            handshakeAt: age == null ? null : observedAt - age * 1000,
            rx: parseSize(String(row.rx ?? "")) ?? null,
            tx: parseSize(String(row.tx ?? "")) ?? null,
          },
        ];
      });
      const users = peers
        .filter((p) => p.managed)
        .map(({ user, interface: iface, address, expires, expired, disabled, lastHandshake }) => ({
          user,
          interface: iface,
          address,
          expires,
          expired,
          disabled,
          lastHandshake,
        }));
      return json({
        device,
        observedAt,
        interfaces: interfaceOptions.map((i) => i.name),
        interfaceOptions,
        users,
        peers,
      });
    }
    if (req.method !== "POST") return json({ error: "Unsupported WireGuard route" }, 405);
    // readOperationBody also refuses a cross-origin browser request.
    const body = JSON.parse((await readOperationBody(req)) || "{}") as Record<string, unknown>;
    const device = resolveDeviceName(typeof body.device === "string" ? body.device : undefined);
    const text = (key: string): string | undefined =>
      typeof body[key] === "string" && body[key] !== "" ? (body[key] as string) : undefined;

    if (url.pathname === "/api/wireguard/onboard") {
      const answer = await runTool("onboard_wireguard_user", device, "WRITE", {
        interface: text("interface"),
        user: text("user"),
        endpoint: text("endpoint"),
        address: text("address"),
        dns: text("dns"),
        allowed_ips: text("allowed_ips"),
        expires: text("expires"),
      });
      const at = answer.indexOf("[Interface]");
      if (at < 0) return json({ ok: false, error: answer }, 400);
      return json({ ok: true, message: answer.split("\n")[0], config: answer.slice(at) });
    }
    if (url.pathname === "/api/wireguard/revoke") {
      const answer = await runTool("revoke_wireguard_user", device, "DESTRUCTIVE", {
        user: text("user"),
      });
      return json({ ok: answer.includes("revoked"), message: answer });
    }
    if (url.pathname === "/api/wireguard/expire") {
      const answer = await runTool("expire_wireguard_users", device, "DESTRUCTIVE", {
        action: body.action === "remove" ? "remove" : "disable",
        apply: body.apply === true,
      });
      return json({ ok: !answer.includes("FAILED"), message: answer });
    }
    return json({ error: "Unsupported WireGuard route" }, 404);
  } catch (error) {
    if (error instanceof DashboardInputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        400,
      );
    if (error instanceof SyntaxError) return json({ error: "The request body is not JSON." }, 400);
    throw error;
  }
}
