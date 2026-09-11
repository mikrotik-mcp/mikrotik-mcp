/** Bounded read-only collection. Only allowlisted properties enter persisted cases. */
import { randomUUID } from "node:crypto";
import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { assertDeviceAccess as assertCaseAccess } from "../core/scoped-access";
import { resolveDeviceName } from "../core/runtime";
import { Cmd, isEmpty, looksLikeError } from "../core/routeros";
import { parseKeyValues, parseRecords } from "../core/routeros-parse";
import { parsePingSummary } from "../tools/dr-drill";
import { investigationInput, nextTests } from "./model";
import type { CaseEvidence, Investigation } from "./model";
export { assertDeviceAccess as assertCaseAccess } from "../core/scoped-access";

type Reader = (command: string, ctx: ToolContext, opts: { maxMs: number }) => Promise<string>;
const sources = [
  [
    "dhcp",
    "/ip dhcp-server lease",
    "address,mac-address,server,status,active-address,active-mac-address",
  ],
  ["arp", "/ip arp", "address,mac-address,interface,complete"],
  ["bridge-host", "/interface bridge host", "mac-address,on-interface,bridge,vid"],
  [
    "vlan",
    "/interface bridge vlan",
    "bridge,vlan-ids,tagged,untagged,current-tagged,current-untagged",
  ],
  ["interfaces", "/interface", "name,type,running,disabled,mtu"],
  ["routes", "/ip route", "dst-address,gateway,routing-table,distance,active,disabled"],
  [
    "filter",
    "/ip firewall filter",
    "chain,action,src-address,dst-address,in-interface,out-interface,in-interface-list,out-interface-list,protocol,dst-port,disabled",
  ],
  [
    "nat",
    "/ip firewall nat",
    "chain,action,src-address,dst-address,in-interface,out-interface,protocol,dst-port,to-addresses,to-ports,disabled",
  ],
] as const;
const busy = new Set<string>();

/** Gather a point-in-time case without changing router configuration or launching packet captures. */
export async function collectInvestigation(
  input: unknown,
  ctx: ToolContext,
  read: Reader = executeMikrotikCommand,
): Promise<Investigation> {
  const args = investigationInput.parse(input);
  const device = resolveDeviceName(ctx.device);
  const devices = [...new Set([device, ...args.vantage_devices.map((d) => resolveDeviceName(d))])];
  assertCaseAccess(devices, "create_investigation", "WRITE");
  if (devices.some((d) => busy.has(d)))
    throw new Error(
      "An investigation is already collecting on one of these devices. Wait for it to finish.",
    );
  for (const d of devices) busy.add(d);
  const createdAt = Date.now();
  const evidence: CaseEvidence[] = [];
  try {
    for (const d of devices) {
      const deviceCtx = { ...ctx, device: d };
      const macs = new Set(args.client.includes(":") ? [args.client.toUpperCase()] : []);
      const ips = new Set(args.client.includes(":") ? [] : [args.client]);
      const capture = async (
        source: string,
        command: string,
        parse: (raw: string) => Record<string, string>[],
      ): Promise<void> => {
        const startedAt = Date.now();
        const e: CaseEvidence = {
          id: randomUUID(),
          device: d,
          source,
          startedAt,
          finishedAt: startedAt,
          state: "unknown",
          summary: "Not collected",
          rows: [],
          truncated: false,
        };
        try {
          if (startedAt - createdAt > 90_000) throw new Error("Collection budget exceeded");
          assertCaseAccess([d], "create_investigation", "WRITE");
          const raw = await read(command, deviceCtx, { maxMs: 8000 });
          if (looksLikeError(raw)) throw new Error("Device rejected evidence query");
          const rows = parse(raw);
          if (!rows.length && !isEmpty(raw) && !["dhcp", "arp", "bridge-host"].includes(source))
            throw new Error("Unrecognised evidence response");
          e.rows = rows.slice(0, 150);
          e.truncated = rows.length > 150;
          e.state = "observed";
          e.summary = `${e.rows.length} selected record(s) observed${e.truncated ? "; limited to 150" : ""}. Context is not proof of packet traversal.`;
        } catch {
          e.summary =
            "Evidence unavailable: query failed, timed out, was denied, or returned an unsupported response. No health conclusion was made.";
        }
        e.finishedAt = Date.now();
        evidence.push(e);
      };
      // Serial queries avoid exhausting device SSH channels.
      for (const [source, path, fields] of sources) {
        await capture(
          source,
          new Cmd(`${path} print`).raw("detail without-paging").build(),
          (raw) => {
            const parsed = parseRecords(raw).rows;
            if (!parsed.length && !isEmpty(raw)) throw new Error("Unrecognised table");
            let rows = parsed;
            if (["dhcp", "arp", "bridge-host"].includes(source)) {
              rows = rows.filter(
                (r) =>
                  ips.has(r.address) ||
                  ips.has(r["active-address"]) ||
                  macs.has((r["mac-address"] ?? "").toUpperCase()) ||
                  macs.has((r["active-mac-address"] ?? "").toUpperCase()),
              );
              for (const r of rows) {
                for (const key of ["address", "active-address"]) if (r[key]) ips.add(r[key]);
                for (const key of ["mac-address", "active-mac-address"])
                  if (r[key]) macs.add(r[key].toUpperCase());
              }
            }
            const allowed = fields.split(",");
            return rows.map((r) =>
              Object.fromEntries(
                allowed
                  .filter((key) => r[key] !== undefined)
                  .map((key) => [key, r[key].slice(0, 512)]),
              ),
            );
          },
        );
      }
      await capture("dns", "/ip dns print", (raw) => {
        const r = parseKeyValues(raw);
        const keys = ["servers", "dynamic-servers", "allow-remote-requests"];
        if (!keys.some((key) => key in r)) throw new Error("No DNS evidence");
        return [
          Object.fromEntries(
            keys.filter((key) => key in r).map((key) => [key, r[key].slice(0, 512)]),
          ),
        ];
      });
      await capture(
        "router-ping",
        new Cmd("/ping").set("address", args.target).set("count", 3).build(),
        (raw) => {
          const ping = parsePingSummary(raw);
          if (!ping || ping.sent === 0) throw new Error("No ping evidence");
          return [
            {
              sent: String(ping.sent),
              received: String(ping.received),
              lossPercent: String(ping.lossPct),
              perspective: "router ICMP only; application health unverified",
            },
          ];
        },
      );
    }
    assertCaseAccess(devices, "create_investigation", "WRITE");
    return {
      id: randomUUID(),
      createdAt,
      finishedAt: Date.now(),
      device,
      devices,
      client: args.client,
      target: args.target,
      service: args.service,
      clientOutcome: "unverified",
      evidence,
      nextTests: nextTests(evidence, args.client, args.target),
    };
  } finally {
    for (const d of devices) busy.delete(d);
  }
}
