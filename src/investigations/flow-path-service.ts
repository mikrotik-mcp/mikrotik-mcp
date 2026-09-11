/** Passive NetFlow/IPFIX inspection. No sniffer, probes, firewall or export changes. */
import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { getConfig, getDevice, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { Cmd, looksLikeError } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { getSafeModeManager } from "../ssh/safe-mode";
import { getFlowCollector } from "../flows/collector";
import type { CollectorStats } from "../flows/collector";
import type { FlowStore } from "../flows/store";
import { flowStore } from "../tools/traffic-flow";
import { flowBranches, flowPathInput, interfaceIndexFromOid } from "./flow-path";
import type { FlowInterface, FlowPathResult } from "./flow-path";

type Reader = (command: string, ctx: ToolContext, options: { maxMs: number }) => Promise<string>;
interface Dependencies {
  read: Reader;
  store: () => Promise<FlowStore>;
  stats: () => CollectorStats;
  drain: () => void;
}
const busy = new Set<string>();

export class FlowPathError extends Error {}

/** Strict host binding: never mingle two routers behind one exporter/NAT address. */
export function flowExporter(device: string): string {
  const host = getDevice(device).host;
  if (!host || !flowPathInput.shape.client.safeParse(host).success)
    throw new FlowPathError(
      "Exporter binding needs a unique configured IPv4 router host. DNS, MAC and alternate export source addresses are not guessed.",
    );
  if (Object.values(getConfig().devices).filter((d) => d.host === host).length !== 1)
    throw new FlowPathError(
      "Several devices share this host. Exporter ownership is ambiguous; no flow evidence was returned.",
    );
  return host;
}

/** One named query per candidate, batched through the connector with explicit end markers. */
async function mapInterfaces(
  names: string[],
  ctx: ToolContext,
  read: Reader,
): Promise<FlowInterface[]> {
  if (!names.length) return [];
  if (getSafeModeManager(ctx.device!).isActive || getDevice(ctx.device).mac)
    throw new FlowPathError("Interface lookup is unavailable during Safe Mode or over MAC-Telnet.");
  const parts = names.flatMap((name, i) => [
    `:put "MCP_FLOW_DETAIL_${i}"`,
    new Cmd("/interface print").raw("detail without-paging where").set("name", name).build(),
    `:put "MCP_FLOW_OID_${i}"`,
    new Cmd("/interface print").raw("oid without-paging where").set("name", name).build(),
  ]);
  const command = new Cmd("").raw([...parts, ':put "MCP_FLOW_END"'].join("; ")).build();
  const raw = (await read(command, ctx, { maxMs: 8000 })).replace(/\r\n/g, "\n");
  if (looksLikeError(raw) || !raw.trimEnd().endsWith("MCP_FLOW_END"))
    throw new FlowPathError(
      "Interface lookup was incomplete or unsupported. Numeric indexes remain unresolved.",
    );
  return names.flatMap((name, i) => {
    const detail = raw.split(`MCP_FLOW_DETAIL_${i}\n`)[1]?.split(`MCP_FLOW_OID_${i}\n`)[0];
    const oid = raw.split(`MCP_FLOW_OID_${i}\n`)[1]?.split("MCP_FLOW_")[0];
    if (!detail || !oid) return [];
    const rows = parseRecords(detail).rows;
    const index = interfaceIndexFromOid(oid);
    if (rows.length !== 1 || rows[0].name !== name || !index || !rows[0].type) return [];
    return [{ index, name, type: rows[0].type, mappedAt: Date.now() }];
  });
}

/** Recent source-side tuples to spare operators guessing ephemeral client ports. */
export async function clientFlowCandidates(
  client: string,
  ctx: ToolContext,
): Promise<{
  candidates: {
    destination: string;
    source_port: number;
    destination_port: number;
    protocol: "tcp" | "udp";
    last: number;
  }[];
  limited: boolean;
  collectorRunning: boolean;
}> {
  flowPathInput.shape.client.parse(client);
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], "list_client_flow_candidates", "READ");
  const exporter = flowExporter(device);
  const collector = getFlowCollector();
  collector.drain();
  const now = Date.now();
  const records = (await flowStore()).query({
    exporter,
    address: client,
    from: now - 300_000,
    to: now,
    limit: 501,
  });
  const candidates = new Map<
    string,
    {
      destination: string;
      source_port: number;
      destination_port: number;
      protocol: "tcp" | "udp";
      last: number;
    }
  >();
  for (const r of records.slice(0, 500)) {
    if (
      r.src !== client ||
      r.exporter !== exporter ||
      ![6, 17].includes(r.protocol) ||
      r.end > now ||
      r.end < now - 300_000 ||
      r.packets <= 0
    )
      continue;
    const value = {
      destination: r.dst,
      source_port: r.srcPort,
      destination_port: r.dstPort,
      protocol: (r.protocol === 6 ? "tcp" : "udp") as "tcp" | "udp",
      last: r.end,
    };
    if (!flowPathInput.safeParse({ client, ...value }).success) continue;
    const key = `${r.dst}:${r.srcPort}:${r.dstPort}:${r.protocol}`;
    if (!candidates.has(key) || candidates.get(key)!.last < r.end) candidates.set(key, value);
  }
  assertDeviceAccess([device], "list_client_flow_candidates", "READ");
  if (flowExporter(device) !== exporter)
    throw new FlowPathError(
      "Exporter binding changed during inspection. Retry with the current device.",
    );
  return {
    candidates: [...candidates.values()].sort((a, b) => b.last - a.last).slice(0, 50),
    limited: records.length > 500 || candidates.size > 50,
    collectorRunning: collector.running,
  };
}

export async function inspectFlowPath(
  input: unknown,
  ctx: ToolContext,
  deps?: Dependencies,
): Promise<FlowPathResult> {
  const tuple = flowPathInput.parse(input);
  const device = resolveDeviceName(ctx.device);
  const deviceConfig = getDevice(device);
  const guard = (): void => {
    assertDeviceAccess([device], "inspect_flow_path", "READ");
    if (getDevice(device) !== deviceConfig)
      throw new FlowPathError(
        "Device configuration changed during inspection. Retry with the current device.",
      );
  };
  guard();
  const exporter = flowExporter(device);
  if (busy.has(device))
    throw new FlowPathError(
      "A flow inspection is already running for this router. Wait for it to finish.",
    );
  const collector = getFlowCollector();
  const d = deps ?? {
    read: executeMikrotikCommand,
    store: flowStore,
    stats: () => collector.stats(),
    drain: () => collector.drain(),
  };
  busy.add(device);
  try {
    d.drain();
    const stats = d.stats();
    const checkedAt = Date.now(),
      from = checkedAt - 300_000;
    const store = await d.store();
    const protocol = tuple.protocol === "tcp" ? 6 : 17;
    const forward = store.query({
      exporter,
      from,
      to: checkedAt,
      limit: 501,
      tuple: {
        src: tuple.client,
        dst: tuple.destination,
        srcPort: tuple.source_port,
        dstPort: tuple.destination_port,
        protocol,
      },
    });
    const reverse = store.query({
      exporter,
      from,
      to: checkedAt,
      limit: 501,
      tuple: {
        src: tuple.destination,
        dst: tuple.client,
        srcPort: tuple.destination_port,
        dstPort: tuple.source_port,
        protocol,
      },
    });
    const warnings: string[] = [];
    let interfaces: FlowInterface[] = [];
    // Do not contact a router just to decorate an empty result.
    if (forward.length || reverse.length) {
      guard();
      try {
        interfaces = await mapInterfaces(
          [...new Set(tuple.interface_names)],
          { ...ctx, device },
          d.read,
        );
      } catch {
        warnings.push(
          "Current interface names could not be resolved. Raw export indexes are retained; no name was guessed.",
        );
      }
    }
    guard();
    const f = flowBranches(forward.slice(0, 500), tuple, exporter, from, checkedAt, interfaces);
    const r = flowBranches(
      reverse.slice(0, 500),
      tuple,
      exporter,
      from,
      checkedAt,
      interfaces,
      true,
    );
    if (!stats.running)
      warnings.push(
        "Collector is stopped. Results, if present, are recent stored exports, not a live stream.",
      );
    if (!stats.exporters[exporter])
      warnings.push(
        "No datagrams from this router host in the current collector session. Alternate exporter addresses require an explicit ownership configuration; none is inferred.",
      );
    if (!f.branches.length)
      warnings.push(
        "No matching forward export in the last five minutes. This does not mean blocked traffic. Check the exact client source port and destination IP; exports may be delayed, sampled, FastTrack/offloaded or translated by NAT.",
      );
    if (f.branches.some((b) => !b.egress))
      warnings.push(
        "Some exit indexes are unresolved. Select their interface names for lookup. Historical records saved before this upgrade have no interface indexes.",
      );
    if (
      stats.decodeErrors ||
      stats.templatesPending ||
      stats.templatesDropped ||
      store.stats().evicted
    )
      warnings.push(
        "Collector/store reports incomplete telemetry (decoding, templates or retention). Missing records cannot establish packet loss.",
      );
    warnings.push(
      "UDP exports are exporter-reported evidence, not authenticated packet capture. Interface names are a current lookup, not historical identity proof. NAT aliases, IPsec policies, application delivery and exact blocking hops are not inferred.",
    );
    return {
      device,
      exporter,
      checkedAt,
      from,
      tuple,
      collectorRunning: stats.running,
      exporterSeen: Boolean(stats.exporters[exporter]),
      limited: forward.length > 500 || reverse.length > 500,
      forward: f.branches,
      reverse: r.branches,
      rejected: f.rejected + r.rejected,
      warnings,
      evidence: [...f.matched.slice(0, 20), ...r.matched.slice(0, 20)],
    };
  } finally {
    busy.delete(device);
  }
}
