import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { Cmd, looksLikeError, quoteValue } from "../core/routeros";
import type { Row } from "./model";

const paths = new Set([
  "/ip dns static",
  "/routing table",
  "/routing rule",
  "/ip route",
  "/ipv6 route",
  "/ip vrf",
  "/ip firewall mangle",
  "/ipv6 firewall mangle",
  "/ip firewall filter",
  "/ipv6 firewall filter",
  "/ip firewall address-list",
  "/ipv6 firewall address-list",
]);
export const ROUTING_ROW_LIMIT = 2000;

/** Structured output preserves bare FIB booleans and unnumbered dynamic routes. */
export function routingReadCommand(path: string, lists?: string[]): string {
  if (!paths.has(path)) throw new Error("Unsupported routing inventory section.");
  const where = lists?.length
    ? `where ${lists.map((list) => `list=${quoteValue(list)}`).join(" or ")}`
    : "";
  const find = new Cmd(`${path} find`).raw(where).build();
  const print = new Cmd(`${path} print`).raw("detail as-value").raw(where).build();
  return `:if ([:len [${find}]] > ${ROUTING_ROW_LIMIT}) do={:put "MCP_ROUTING_ROW_LIMIT"} else={:put [:serialize to=json value=[${print}]]}`;
}

export function parseRoutingRows(raw: string, fields?: string): Row[] {
  if (raw.length > 1_048_576) throw new Error("Routing section exceeds the 1 MiB read limit.");
  if (raw.trim() === "MCP_ROUTING_ROW_LIMIT")
    throw new Error(
      `More than ${ROUTING_ROW_LIMIT} entries: this section was not loaded to protect the router. Use a filtered RouterOS read; the other routing sections are independent.`,
    );
  if (looksLikeError(raw))
    throw new Error(
      "Router rejected this read; check connectivity, permissions and RouterOS v7 support.",
    );
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    throw new Error("Router did not return valid structured routing data; no rows were accepted.");
  }
  if (
    !Array.isArray(data) ||
    data.length > ROUTING_ROW_LIMIT ||
    data.some((r) => !r || typeof r !== "object" || Array.isArray(r))
  )
    throw new Error("Router returned an incomplete or invalid routing section.");
  const keys = fields ? new Set(["#", ".id", "flags", ...fields.split(",")]) : undefined;
  return data.map((record, index) => {
    const row: Row = { "#": String(index) };
    for (const [key, value] of Object.entries(record)) {
      if (keys && !keys.has(key)) continue;
      if (typeof value === "boolean") row[key] = value ? "yes" : "no";
      else if (typeof value === "string" || typeof value === "number") row[key] = String(value);
      else if (Array.isArray(value) && value.every((v) => ["string", "number"].includes(typeof v)))
        row[key] = value.join(",");
    }
    return row;
  });
}

export async function readRoutingRows(
  path: string,
  fields: string | undefined,
  ctx: ToolContext,
  lists?: string[],
): Promise<Row[]> {
  const raw = await executeMikrotikCommand(routingReadCommand(path, lists), ctx, { maxMs: 6000 });
  return parseRoutingRows(raw, fields);
}

export interface RoutingAddressPage {
  rows: Row[];
  total: number;
  nextOffset?: number;
}
/** Address lists can contain whole country ranges: fetch at most 200 members per request. */
export async function readRoutingAddressPage(
  path: string,
  ctx: ToolContext,
  offset = 0,
): Promise<RoutingAddressPage> {
  if (
    !["/ip firewall address-list", "/ipv6 firewall address-list"].includes(path) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000
  )
    throw new Error("Invalid address-list page.");
  const find = new Cmd(`${path} find`).build();
  const get = new Cmd(`${path} get`).raw("$srId").build();
  const command = `{ :local srIds [${find}]; :local srItems [:toarray ""]; :foreach srId in=[:pick $srIds ${offset} ${offset + 200}] do={ :local srRow [${get}]; :set ($srRow->".id") $srId; :set ($srItems->[:len $srItems]) $srRow; }; :put [:serialize to=json value={"rows"=$srItems;"total"=[:len $srIds]}]; }`;
  const raw = await executeMikrotikCommand(command, ctx, { maxMs: 6000 });
  return parseRoutingAddressPage(raw, offset);
}

export function parseRoutingAddressPage(raw: string, offset = 0): RoutingAddressPage {
  if (looksLikeError(raw) || raw.length > 1_048_576)
    throw new Error("Address-list page could not be read safely.");
  let data: { rows: unknown; total: number };
  try {
    data = JSON.parse(raw.trim());
  } catch {
    throw new Error("Invalid structured address-list page.");
  }
  if (!data || !Array.isArray(data.rows) || !Number.isSafeInteger(data.total) || data.total < 0)
    throw new Error("Invalid address-list total.");
  const rows: Row[] = parseRoutingRows(JSON.stringify(data.rows)).map((r, i) => ({
    ...r,
    "#": String(offset + i),
  }));
  if (
    rows.length !== Math.min(200, Math.max(0, data.total - offset)) ||
    rows.some((r) => !r[".id"])
  )
    throw new Error(
      "Incomplete address-list page. Refresh if the router list changed while reading.",
    );
  return {
    rows,
    total: data.total,
    nextOffset: offset + rows.length < data.total ? offset + rows.length : undefined,
  };
}
