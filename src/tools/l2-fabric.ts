/**
 * Port-level Layer-2 fabric — which host is on which physical port.
 *
 * Collection only; the join and the port-role heuristic live in the pure
 * `src/core/l2-fabric.ts` so they are tested offline.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { buildFabricMap, findHost } from "../core/l2-fabric";
import type { ArpEntry, BridgeHost, DhcpLease, FabricInput, FabricMap } from "../core/l2-fabric";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { parseRecords } from "../core/routeros-parse";
import { isEmpty, looksLikeError } from "../core/routeros";

async function safe(cmd: string, ctx: ToolContext): Promise<string> {
  try {
    const out = await executeMikrotikCommand(cmd, ctx);
    return looksLikeError(out) || isEmpty(out) ? "" : out;
  } catch {
    return "";
  }
}

const isYes = (v: string | undefined): boolean => v === "yes" || v === "true";

/**
 * Read every table the fabric join needs, concurrently.
 *
 * `/interface bridge host` is the only required one — the rest add names. A
 * failure in any of them degrades the labels rather than the map, which is why
 * each goes through `safe`.
 */
export async function collectFabric(
  device: string | undefined,
  ctx: ToolContext,
): Promise<FabricInput> {
  const [hostsRaw, arpRaw, leaseRaw, neighborRaw] = await Promise.all([
    safe("/interface bridge host print detail", ctx),
    safe("/ip arp print detail", ctx),
    safe("/ip dhcp-server lease print detail", ctx),
    safe("/ip neighbor print detail", ctx),
  ]);

  const hosts: BridgeHost[] = parseRecords(hostsRaw).rows.map((r) => ({
    mac: r["mac-address"] ?? "",
    onInterface: r.interface ?? r["on-interface"] ?? "",
    bridge: r.bridge || undefined,
    local: isYes(r.local) || (r.flags ?? "").includes("L"),
    external: isYes(r.external),
    dynamic: isYes(r.dynamic) || (r.flags ?? "").includes("D"),
  }));

  const arp: ArpEntry[] = parseRecords(arpRaw).rows.map((r) => ({
    mac: r["mac-address"] ?? "",
    address: r.address ?? "",
    interface: r.interface || undefined,
    complete: isYes(r.complete) || (r.flags ?? "").includes("C"),
  }));

  const leases: DhcpLease[] = parseRecords(leaseRaw).rows.map((r) => ({
    mac: r["mac-address"] ?? "",
    address: r.address || undefined,
    hostname: r["host-name"] || undefined,
    comment: r.comment || undefined,
    status: r.status || undefined,
  }));

  const neighbors = parseRecords(neighborRaw).rows.map((r) => ({
    mac: r["mac-address"] || undefined,
    identity: r.identity || undefined,
    board: r.board || undefined,
    platform: r.platform || undefined,
    interface: r.interface || undefined,
  }));

  return { device: device ?? "default", hosts, arp, leases, neighbors };
}

const ROLE_MARK: Record<string, string> = {
  uplink: "⇅ uplink",
  access: "→ access",
  hybrid: "⇉ hybrid",
  empty: "· empty",
};

function renderMap(map: FabricMap, showHosts: boolean): string {
  const lines: string[] = [
    `L2 FABRIC — ${map.device}`,
    `${map.stats.ports} occupied port(s), ${map.stats.hosts} host(s): ` +
      `${map.stats.accessPorts} access, ${map.stats.uplinks} uplink, ` +
      `${map.stats.unidentified} unidentified`,
    "",
  ];
  for (const p of map.ports) {
    const peer = p.peerIdentity ? ` ↔ ${p.peerIdentity}` : "";
    lines.push(
      `${p.interface}${p.bridge ? ` (${p.bridge})` : ""} — ${ROLE_MARK[p.role] ?? p.role}, ` +
        `${p.hostCount} host(s)${peer}`,
    );
    if (showHosts) {
      for (const h of p.hosts) {
        const bits = [h.mac];
        if (h.ip) bits.push(h.ip);
        if (h.vendor) bits.push(h.vendor);
        if (h.isNetworkDevice) bits.push("network device");
        lines.push(`    • ${h.label}  [${bits.join(" · ")}]`);
      }
    }
  }
  if (map.ports.length === 0) {
    lines.push(
      "No bridge host entries. Either this device has no bridge, or hardware offload is " +
        "handling forwarding without populating the host table — check `/interface bridge host` " +
        "directly and whether the ports are switch-chip offloaded.",
    );
  }
  return lines.join("\n");
}

export const l2FabricTools: ToolModule = [
  defineTool({
    name: "map_l2_fabric",
    title: "Map Hosts to Physical Switch Ports",
    annotations: READ,
    description:
      "Builds a PORT-LEVEL Layer-2 map: which hosts are behind each bridge port, joined from the " +
      "bridge host table (`/interface bridge host`), ARP, DHCP leases and the neighbour cache so " +
      "every MAC gets a real name — hostname, RouterOS identity, IP or hardware vendor. Also " +
      "classifies each port as access (one host), uplink (many hosts, or a discovered network " +
      "device behind it) or hybrid. Use this to answer 'what is plugged into ether5', to find " +
      "unexpected devices on the fabric, or to spot an unmanaged switch someone added. This is " +
      "different from list_neighbors, which only sees MNDP/CDP/LLDP speakers — the bridge host " +
      "table sees EVERY host that has passed a frame, including printers, IoT and laptops. " +
      "Read-only.",
    inputSchema: {
      interface_filter: z
        .string()
        .optional()
        .describe("Only show ports whose name contains this substring."),
      role: z
        .enum(["access", "uplink", "hybrid"])
        .optional()
        .describe("Only show ports classified with this role."),
      summary_only: z
        .boolean()
        .optional()
        .describe("Show per-port counts without listing individual hosts."),
    },
    async handler(a, ctx) {
      ctx.info("Building port-level L2 fabric map");
      const input = await collectFabric(ctx.device, ctx);
      const map = buildFabricMap(input);

      let ports = map.ports;
      if (a.interface_filter) {
        const q = a.interface_filter.toLowerCase();
        ports = ports.filter((p) => p.interface.toLowerCase().includes(q));
      }
      if (a.role) ports = ports.filter((p) => p.role === a.role);

      const filtered: FabricMap = { ...map, ports };
      const text = renderMap(filtered, !a.summary_only);
      return {
        text,
        structuredContent: filtered as unknown as Record<string, unknown>,
      };
    },
  }),

  defineTool({
    name: "locate_host_port",
    title: "Find Which Port a Host Is Plugged Into",
    annotations: READ,
    description:
      "Locates a specific host on the Layer-2 fabric and reports the exact bridge port it is " +
      "reachable through. Accepts a MAC address (any separator style), an IP address, or a " +
      "hostname/identity substring. This is the 'my printer is 192.168.1.40, which switch port " +
      "is it on?' lookup — it resolves the IP to a MAC via ARP/DHCP and then to a port via the " +
      "bridge host table. Returns every match, since a MAC can legitimately appear behind an " +
      "uplink as well as on its access port. Read-only.",
    inputSchema: {
      query: z
        .string()
        .describe("MAC address, IP address, or hostname/identity substring to locate."),
    },
    async handler(a, ctx) {
      ctx.info(`Locating host '${a.query}' on the L2 fabric`);
      const map = buildFabricMap(await collectFabric(ctx.device, ctx));
      const hits = findHost(map, a.query);
      if (hits.length === 0) {
        return (
          `No host matching '${a.query}' is present in the bridge host table.\n\n` +
          "The host may be silent (the bridge only learns a MAC once it forwards a frame from " +
          "it), on a routed segment rather than a bridged one, or behind a switch-chip offloaded " +
          "port that does not populate the host table."
        );
      }
      const lines = hits.map(({ port, host }) => {
        const bits = [host.mac];
        if (host.ip) bits.push(host.ip);
        if (host.vendor) bits.push(host.vendor);
        const downstream =
          port.role === "uplink"
            ? " — the host is somewhere DOWNSTREAM of this port, not directly on it"
            : "";
        return (
          `${host.label} → ${port.interface}${port.bridge ? ` (bridge ${port.bridge})` : ""}` +
          `  [${bits.join(" · ")}]\n` +
          `    that port is ${port.role}, carrying ${port.hostCount} host(s)${downstream}`
        );
      });
      return `LOCATED ${hits.length} match(es) for '${a.query}':\n\n${lines.join("\n\n")}`;
    },
  }),
];
