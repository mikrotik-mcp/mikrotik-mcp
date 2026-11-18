/**
 * WireGuard Mesh Weaver — stand up a WireGuard VPN across the whole fleet from a
 * single intent.
 *
 * In one call it: ensures a WireGuard interface on every named device, reads each
 * device's public key, assigns each a mesh address, and then wires the peers
 * between routers (full-mesh = every pair; hub-spoke = hub ↔ each spoke),
 * distributing the public keys automatically. Because public keys can only be
 * read from the live devices, it defaults to a DRY RUN that shows the plan; set
 * `apply=true` to build it.
 *
 * This is the one tool that orchestrates across MULTIPLE devices in a single
 * call — each device is reached through its own context via the same
 * `executeMikrotikCommand` choke point.
 */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { DANGEROUS, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getConfig } from "../core/runtime";
import { Cmd, looksLikeError, quoted } from "../core/routeros";

/** Mesh address for the device at `index`: the prefix with its last octet replaced. */
function meshAddress(prefix: string, index: number): { ip: string; len: string } {
  const [net, len = "24"] = prefix.split("/");
  const octets = net.split(".");
  octets[3] = String(index + 1);
  return { ip: octets.join("."), len };
}

function parsePublicKey(detail: string): string | undefined {
  return detail.match(/public-key="?([A-Za-z0-9+/]{42,44}=)"?/)?.[1];
}

export const wireguardMeshTools: ToolModule = [
  defineTool({
    name: "build_wireguard_mesh",
    title: "Build WireGuard Mesh / Hub-Spoke VPN",
    annotations: DANGEROUS,
    description:
      "Stands up a WireGuard VPN across several configured devices in ONE call: ensures a WireGuard " +
      "interface on each, reads each device's public key, assigns every device a mesh address from " +
      "`address_prefix`, then wires the peers between routers — `topology=full-mesh` connects every " +
      "pair, `hub-spoke` connects the `hub` to each spoke — distributing public keys automatically. " +
      "Endpoints default to each device's configured host (override per device via `endpoints`); add " +
      "each site's LAN subnet via `allowed_lans` to route it through the tunnel. DEFAULTS TO A DRY RUN " +
      "(`apply=false`) that shows the full plan; set `apply=true` to build it. Operates across " +
      "MULTIPLE devices, so it is not affected by the single `device` selector. SSH devices only " +
      "(needs to read public keys). Returns the plan, or a per-device build report.",
    inputSchema: {
      devices: z
        .array(z.string())
        .min(2)
        .describe("Configured device names to include in the mesh (2+)"),
      address_prefix: z
        .string()
        .default("10.20.0.0/24")
        .describe("Mesh subnet; each device gets <prefix>.<index+1> on its WireGuard interface"),
      interface: interfaceName()
        .default("wg-mesh")
        .describe("WireGuard interface name to create/use (no spaces)"),
      listen_port: z.number().int().default(13231),
      topology: z.enum(["full-mesh", "hub-spoke"]).default("full-mesh"),
      hub: z.string().optional().describe("Hub device name (required when topology=hub-spoke)"),
      endpoints: z
        .record(z.string(), z.string())
        .optional()
        .describe('Per-device public endpoint host override, e.g. {"site-a":"a.example.com"}'),
      allowed_lans: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Per-device LAN subnet to route through the tunnel, e.g. {"site-a":"192.168.10.0/24"}',
        ),
      persistent_keepalive: z.string().default("25s"),
      apply: z
        .boolean()
        .default(false)
        .describe("false = preview the plan (default); true = build"),
    },
    async handler(a, ctx) {
      const devices = a.devices as string[];
      const iface = a.interface as string;
      const port = a.listen_port as number;
      const endpoints = (a.endpoints ?? {}) as Record<string, string>;
      const lans = (a.allowed_lans ?? {}) as Record<string, string>;
      const cfg = getConfig();

      // Validate device names and the hub up front.
      const unknown = devices.filter((d) => !(d in cfg.devices));
      if (unknown.length) return `Unknown device(s): ${unknown.join(", ")}. Check your config.`;
      if (a.topology === "hub-spoke" && (!a.hub || !devices.includes(a.hub))) {
        return "topology=hub-spoke requires `hub` to be one of `devices`.";
      }

      // Plan: each node's mesh address + endpoint host.
      const nodes = devices.map((name, i) => ({
        name,
        ...meshAddress(a.address_prefix, i),
        endpoint: endpoints[name] ?? cfg.devices[name].host ?? name,
        lan: lans[name],
      }));
      const linkPairs: [number, number][] = [];
      if (a.topology === "full-mesh") {
        for (let i = 0; i < nodes.length; i++)
          for (let j = 0; j < nodes.length; j++) if (i !== j) linkPairs.push([i, j]);
      } else {
        const h = devices.indexOf(a.hub as string);
        for (let i = 0; i < nodes.length; i++) if (i !== h) linkPairs.push([h, i], [i, h]);
      }

      if (!a.apply) {
        const lines = [
          `DRY RUN — WireGuard ${a.topology} across ${nodes.length} devices on '${iface}' (port ${port}).`,
          "",
          "Devices & mesh addresses:",
          ...nodes.map(
            (n) =>
              `  • ${n.name} → ${n.ip}/${n.len}  endpoint ${n.endpoint}:${port}${n.lan ? `  lan ${n.lan}` : ""}`,
          ),
          "",
          `Peer links (${linkPairs.length}, each adds a peer on the first toward the second):`,
          ...linkPairs.map(([x, y]) => `  • ${nodes[x].name} ⇒ ${nodes[y].name}`),
          "",
          "On apply: create/keep each interface, read its public key, assign its address, then add the peers above. Set apply=true to build.",
        ];
        return lines.join("\n");
      }

      // Phase 1 — ensure interface, read public key, assign address per device.
      const pub: Record<string, string> = {};
      for (const n of nodes) {
        const dctx = createContext(undefined, n.name);
        const have = await executeMikrotikCommand(
          `/interface wireguard print count-only where name=${quoted(iface)}`,
          dctx,
        );
        if (have.trim() === "0") {
          const add = await executeMikrotikCommand(
            new Cmd("/interface wireguard add").set("name", iface).set("listen-port", port).build(),
            dctx,
          );
          if (looksLikeError(add)) return `Failed to create interface on ${n.name}: ${add}`;
        }
        const detail = await executeMikrotikCommand(
          `/interface wireguard print detail where name=${quoted(iface)}`,
          dctx,
        );
        const key = parsePublicKey(detail);
        if (!key) return `Could not read WireGuard public key on ${n.name}. Aborting.`;
        pub[n.name] = key;
        const addrHave = await executeMikrotikCommand(
          `/ip address print count-only where interface=${quoted(iface)}`,
          dctx,
        );
        if (addrHave.trim() === "0") {
          await executeMikrotikCommand(
            new Cmd("/ip address add")
              .set("address", `${n.ip}/${n.len}`)
              .set("interface", iface)
              .build(),
            dctx,
          );
        }
      }

      // Phase 2 — wire the peers.
      let peers = 0;
      for (const [x, y] of linkPairs) {
        const a2 = nodes[x];
        const b = nodes[y];
        const allowed = b.lan ? `${b.ip}/32,${b.lan}` : `${b.ip}/32`;
        const cmd = new Cmd("/interface wireguard peers add")
          .set("interface", iface)
          .set("public-key", pub[b.name])
          .set("endpoint-address", b.endpoint)
          .set("endpoint-port", port)
          .set("allowed-address", allowed)
          .set("persistent-keepalive", a.persistent_keepalive)
          .build();
        const r = await executeMikrotikCommand(cmd, createContext(undefined, a2.name));
        if (looksLikeError(r)) {
          return `Built interfaces, but FAILED adding peer ${a2.name}⇒${b.name} (${peers} peers added): ${r}`;
        }
        peers++;
      }

      const summary = nodes.map((n) => `  • ${n.name}: ${n.ip}/${n.len}`).join("\n");
      return `WireGuard ${a.topology} built: ${nodes.length} interfaces, ${peers} peers on '${iface}'.\n${summary}\n\nCheck handshakes per device with get_wireguard_peers / list_wireguard_peers.`;
    },
  }),
];
