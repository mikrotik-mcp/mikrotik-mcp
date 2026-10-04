import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Cmd, quoteValue, looksLikeError } from "./routeros";
import { executeMikrotikCommand } from "./connector";
import { resolveDeviceName } from "./runtime";
import { assertDeviceAccess } from "./scoped-access";
import type { ToolContext } from "./context";
import { getSafeModeManager } from "../ssh/safe-mode";
import { openVpnUptime } from "./openvpn-sessions-model";
import type { OpenVpnSession, OpenVpnSnapshot } from "./openvpn-sessions-model";

const SESSION_LIMIT = 1000;
const TICKET_TTL = 60_000;
const tickets = new Map<string, { device: string; at: number; session: OpenVpnSession }>();
const cache = new Map<string, { expires: number; promise: Promise<OpenVpnSnapshot> }>();
export class OpenVpnOperationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}
export const disconnectOpenVpnInput = z.object({
  token: z
    .string()
    .uuid()
    .describe(
      "Fresh disconnectToken from list_ovpn_sessions on this router; expires after 60 seconds and is single-use.",
    ),
  confirm: z
    .literal(true)
    .describe(
      "Explicit operator approval to terminate this one live connection. The client can reconnect.",
    ),
});

function access(ctx: ToolContext, write = false) {
  if (!ctx.device) throw new OpenVpnOperationError(400, "Select an explicit router first.");
  let device: string;
  try {
    device = resolveDeviceName(ctx.device);
  } catch {
    throw new OpenVpnOperationError(400, "Unknown router. Select an enabled router first.");
  }
  try {
    assertDeviceAccess(
      [device],
      write ? "disconnect_ovpn_session" : "list_ovpn_sessions",
      write ? "DESTRUCTIVE" : "READ",
    );
  } catch (e) {
    throw new OpenVpnOperationError(403, e instanceof Error ? e.message : "Device access denied.");
  }
  return device;
}

/** Bounded, one-shot read; stringify time/session-id before JSON to avoid epoch-time coercion. */
export function openVpnSessionsCommand(): string {
  const find = new Cmd("/ppp active find where").set("service", "ovpn").build();
  const read = new Cmd("/ppp active print")
    .raw("detail as-value")
    .raw("where")
    .set("service", "ovpn")
    .build();
  return `{ :if ([:len [${find}]] > ${SESSION_LIMIT}) do={ :error "OpenVPN session limit exceeded" }; :local rows [:toarray ""]; :foreach row in=[${read}] do={ :set ($row->"uptime") [:tostr ($row->"uptime")]; :set ($row->"session-id") [:tostr ($row->"session-id")]; :set ($rows->[:len $rows]) $row }; :put [:serialize to=json options=json.no-string-conversion value=$rows] }`;
}

export function parseOpenVpnSessions(output: string): OpenVpnSession[] {
  if (output.length > 1_000_000)
    throw new Error("OpenVPN session response is too large; no partial list is shown.");
  let rows: unknown;
  try {
    rows = JSON.parse(output.trim());
  } catch {
    throw new Error(
      "Could not read OpenVPN sessions. Check router connectivity and RouterOS JSON support.",
    );
  }
  if (!Array.isArray(rows) || rows.length > SESSION_LIMIT)
    throw new Error("Invalid OpenVPN session snapshot.");
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    const r = z
      .object({
        ".id": z.string().regex(/^\*[A-Fa-f0-9]+$/),
        name: z.string().min(1),
        service: z.literal("ovpn"),
        address: z.string().default(""),
        "caller-id": z.string().default(""),
        "session-id": z.string().default(""),
        uptime: z.string().default(""),
        encoding: z.string().default(""),
        radius: z.union([z.boolean(), z.string()]).optional(),
      })
      .parse(row);
    if (ids.has(r[".id"]))
      throw new Error("Duplicate OpenVPN session identifier; refresh required.");
    ids.add(r[".id"]);
    return {
      id: r[".id"],
      name: r.name,
      address: r.address,
      callerId: r["caller-id"],
      sessionId: r["session-id"],
      encoding: r.encoding,
      radius: r.radius === true || r.radius === "yes" || r.radius === "true",
      uptime: r.uptime,
      uptimeSeconds: openVpnUptime(r.uptime),
    };
  });
}

async function read(ctx: ToolContext) {
  const output = await executeMikrotikCommand(openVpnSessionsCommand(), ctx, { maxMs: 10_000 });
  return parseOpenVpnSessions(output);
}

export async function listOpenVpnSessions(ctx: ToolContext): Promise<OpenVpnSnapshot> {
  const device = access(ctx);
  // Enforce access on every request, even when returning a short-lived cached read.
  let canDisconnect = true;
  try {
    access(ctx, true);
  } catch {
    canDisconnect = false;
  }
  let entry = cache.get(device);
  if (!entry || entry.expires < Date.now()) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    const next = {
      expires: Infinity,
      promise: Promise.resolve(null as unknown as OpenVpnSnapshot),
    };
    next.promise = read(ctx)
      .then((sessions) => {
        const at = Date.now();
        for (const [token, ticket] of tickets)
          if (at - ticket.at >= TICKET_TTL) tickets.delete(token);
        for (const session of sessions) {
          if (!session.sessionId || session.uptimeSeconds === null) continue;
          if (tickets.size >= 10_000) tickets.delete(tickets.keys().next().value!);
          session.disconnectToken = randomUUID();
          tickets.set(session.disconnectToken, { device, at, session });
        }
        next.expires = at + 2000;
        return { device, observedAt: at, sessions, canDisconnect: true };
      })
      .catch((error) => {
        if (cache.get(device) === next) cache.delete(device);
        throw error;
      });
    cache.set(device, next);
    entry = next;
  }
  return { ...(await entry.promise), canDisconnect };
}

/** Single guarded RouterOS operation: never target all connections sharing a username. */
export function disconnectOpenVpnCommand(session: OpenVpnSession): string {
  // Expressions need actual string literals: bare IPs/hex IDs have RouterOS types.
  const literal = (value: string) => {
    const quoted = quoteValue(value);
    return quoted.startsWith('"') ? quoted : `"${quoted}"`;
  };
  const find = new Cmd("/ppp active find where")
    .raw(`.id=${quoteValue(session.id)}`)
    .set("service", "ovpn")
    .build();
  const checks = [
    ["name", session.name],
    ["address", session.address],
    ["caller-id", session.callerId],
    ["session-id", session.sessionId],
  ]
    .map(([field, value]) => `([:tostr [/ppp active get $id ${field}]] != ${literal(value)})`)
    .join(" || ");
  return `{ :local ids [${find}]; :if ([:len $ids] = 0) do={ :put "ovpn:gone" } else={ :if ([:len $ids] != 1) do={ :error "Ambiguous session" }; :local id [:pick $ids 0]; :if (${checks} || ([/ppp active get $id uptime] < [:totime ${literal(session.uptime)}])) do={ :put "ovpn:changed" } else={ ${new Cmd("/ppp active remove").raw("$id").build()}; :put "ovpn:sent" } } }`;
}

export async function disconnectOpenVpnSession(input: unknown, ctx: ToolContext) {
  const device = access(ctx, true);
  const { token } = disconnectOpenVpnInput.parse(input);
  const ticket = tickets.get(token);
  if (!ticket || ticket.device !== device || Date.now() - ticket.at >= TICKET_TTL)
    throw new OpenVpnOperationError(
      409,
      "This session selection expired or belongs to another router. Refresh and select it again.",
    );
  if (getSafeModeManager(device).isActive)
    throw new OpenVpnOperationError(
      409,
      "Finish the current Safe Mode session first. Disconnecting a live connection cannot be rolled back.",
    );
  tickets.delete(token); // Never replay a destructive operation after an uncertain response.
  cache.delete(device);
  const { session } = ticket;
  let output: string;
  try {
    output = (
      await executeMikrotikCommand(disconnectOpenVpnCommand(session), ctx, { maxMs: 10_000 })
    ).trim();
  } catch {
    return {
      status: "unverified",
      message:
        "The disconnect outcome is unknown. Refresh the sessions before any further action; do not retry this request.",
    };
  }
  if (output === "ovpn:gone")
    return {
      status: "already-ended",
      message: "This connection has already ended. No other connection was changed.",
    };
  if (output === "ovpn:changed")
    throw new OpenVpnOperationError(
      409,
      "The selected connection changed. Nothing was disconnected; refresh and select the current session.",
    );
  if (output !== "ovpn:sent" || looksLikeError(output))
    return {
      status: "unverified",
      message:
        "The router did not confirm disconnection. Refresh to reconcile; this request will not be replayed.",
    };
  try {
    const current = await read(ctx);
    if (current.some((s) => s.id === session.id && s.sessionId === session.sessionId))
      return {
        status: "unverified",
        message:
          "The disconnect was sent, but the selected session is still listed. Refresh before another action.",
      };
    const reconnected = current.some((s) => s.name === session.name);
    return {
      status: "disconnected",
      message: reconnected
        ? "Selected connection ended. Another connection for this user is active; it was not touched."
        : "Selected connection ended. The account is unchanged and can reconnect.",
    };
  } catch {
    return {
      status: "unverified",
      message:
        "Disconnect sent, but read-back failed. Refresh when the router is reachable; do not replay this request.",
    };
  }
}
