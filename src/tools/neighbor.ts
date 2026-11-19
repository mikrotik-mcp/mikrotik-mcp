/**
 * Neighbor discovery — `/ip neighbor` (MNDP / CDP / LLDP).
 *
 * RouterOS continuously discovers directly-attached devices via MikroTik
 * Neighbor Discovery Protocol (and CDP/LLDP) and caches them here. This is the
 * data the dashboard's live Layer-2 topology map is built from: each entry is a
 * device physically reachable on a local interface — often before it has any
 * routable IP, which is exactly when MAC-Telnet onboarding is useful.
 *
 * The neighbour cache itself is read-only (populated by the protocols); the
 * configurable part is the discovery *settings* (which interfaces participate
 * and which protocols are spoken).
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { READ, WRITE_IDEMPOTENT, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, isEmpty, looksLikeError, Cmd, quoted } from "../core/routeros";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { buildTopology, parseNeighbors } from "../observability/topology";

export const neighborTools: ToolModule = [
  defineTool({
    name: "list_neighbors",
    title: "List Discovered Neighbor Devices (MNDP/CDP/LLDP)",
    annotations: READ,
    description:
      "Lists directly-attached devices discovered via MNDP, CDP, and LLDP (`/ip neighbor`) — " +
      "each entry shows identity, MAC address, IP address, the local interface it was seen on, " +
      "platform, board name, and RouterOS version. Use this to build a Layer-2 topology view or " +
      "to locate devices (including those with no routable IP yet) before initiating MAC-Telnet " +
      "onboarding. Filterable by local interface, identity substring, IP address substring, or MAC " +
      "address substring. Returns all matching neighbor cache entries; the cache is read-only and " +
      "populated by the protocols — to control which interfaces and protocols participate use " +
      "get_neighbor_discovery_settings or set_neighbor_discovery_settings.",
    inputSchema: {
      interface_filter: z.string().optional().describe("Match the local discovery interface."),
      identity_filter: z
        .string()
        .optional()
        .describe("Match the neighbour's identity (substring)."),
      address_filter: z
        .string()
        .optional()
        .describe("Match the neighbour's IP address (substring)."),
      mac_filter: z.string().optional().describe("Match the neighbour's MAC address (substring)."),
    },
    async handler(a, ctx) {
      ctx.info("Listing discovered neighbours (/ip neighbor)");
      const filters: string[] = [];
      if (a.interface_filter) filters.push(`interface~${quoted(a.interface_filter)}`);
      if (a.identity_filter) filters.push(`identity~${quoted(a.identity_filter)}`);
      if (a.address_filter) filters.push(`address~${quoted(a.address_filter)}`);
      if (a.mac_filter) filters.push(`mac-address~${quoted(a.mac_filter)}`);

      const result = await executeMikrotikCommand(
        `/ip neighbor print detail${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No neighbours discovered matching the criteria."
        : `NEIGHBORS (MNDP/CDP/LLDP):\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_neighbor_discovery_settings",
    title: "Get Neighbor Discovery Settings",
    annotations: READ,
    description:
      "Reads the global neighbor-discovery configuration (`/ip neighbor discovery-settings print`) — " +
      "the interface-list that participates in discovery, the tx/rx mode, and which protocols " +
      "(MNDP, CDP, LLDP) are active. Use this to inspect discovery scope before changing it with " +
      "set_neighbor_discovery_settings. Returns a single settings block; for the actual cache of " +
      "discovered devices use list_neighbors.",
    inputSchema: {},
    async handler(_a, ctx) {
      ctx.info("Getting neighbor discovery settings");
      const result = await executeMikrotikCommand("/ip neighbor discovery-settings print", ctx);
      return isEmpty(result)
        ? "No discovery settings returned."
        : `NEIGHBOR DISCOVERY SETTINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_neighbor_discovery_settings",
    title: "Set Neighbor Discovery Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates the global neighbor-discovery configuration (`/ip neighbor discovery-settings set`) — " +
      "controls which interface-list participates (e.g. 'all', 'LAN', 'none'), the direction mode " +
      "(tx-only, rx-only, tx-and-rx), the active protocols (comma-separated: 'mndp,cdp,lldp'), and " +
      "the LLDP-MED network-policy VLAN. Use this to narrow or broaden which interfaces and protocols " +
      "contribute entries to the neighbor cache. To inspect the current settings first use " +
      "get_neighbor_discovery_settings; to view the resulting neighbor cache use list_neighbors. " +
      "Returns the updated settings block.",
    inputSchema: {
      discover_interface_list: z
        .string()
        .optional()
        .describe('Interface-list to run discovery on, e.g. "all", "LAN", "none".'),
      mode: z
        .enum(["tx-only", "rx-only", "tx-and-rx"])
        .optional()
        .describe("Whether the router transmits and/or receives discovery frames."),
      protocol: z.string().optional().describe('Comma-separated protocols, e.g. "mndp,cdp,lldp".'),
      lldp_med_net_policy_vlan: z
        .string()
        .optional()
        .describe('LLDP-MED network-policy VLAN, e.g. "auto" or a VLAN id.'),
      lldp_mac_phy_config: z
        .boolean()
        .optional()
        .describe("Include the IEEE 802.3 MAC/PHY Configuration/Status TLV in LLDP frames."),
      lldp_max_frame_size: z
        .boolean()
        .optional()
        .describe("Include the Maximum Frame Size TLV in LLDP frames."),
      lldp_vlan_info: z
        .boolean()
        .optional()
        .describe("Include the Port VLAN ID and VLAN Name TLVs in LLDP frames."),
    },
    async handler(a, ctx) {
      ctx.info("Updating neighbor discovery settings");
      const cmd = new Cmd("/ip neighbor discovery-settings set")
        .opt("discover-interface-list", a.discover_interface_list)
        .opt("mode", a.mode)
        .opt("protocol", a.protocol)
        .opt("lldp-med-net-policy-vlan", a.lldp_med_net_policy_vlan)
        .bool("lldp-mac-phy-config", a.lldp_mac_phy_config)
        .bool("lldp-max-frame-size", a.lldp_max_frame_size)
        .bool("lldp-vlan-info", a.lldp_vlan_info)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update discovery settings: ${result}`;
      const after = await executeMikrotikCommand("/ip neighbor discovery-settings print", ctx);
      return `Discovery settings updated.\n\n${after}`;
    },
  }),
  defineTool({
    name: "discover_unmanaged_devices",
    title: "Discover Devices That Are Not Managed Yet",
    annotations: READ,
    noDevice: true,
    description:
      "Finds MikroTik and other devices that are attached to your network but are NOT in this " +
      "server's device list. It reads the neighbour table (`/ip neighbor`, filled by MNDP, CDP and " +
      "LLDP) of every configured router, or of the routers you name, merges what they saw, and " +
      "removes every neighbour that is already a configured device (matched by MAC, IP or " +
      "identity). For each remaining device it returns the identity, board, RouterOS version, " +
      "MAC, IP, which router saw it on which interface, and a ready device-config entry. Use it " +
      "to answer 'which routers are not managed yet?' or before you add a device. It only reads; " +
      "it does NOT add a device or log in to one. A person adds a device with its credentials in " +
      "the dashboard (Topology page, or the configuration editor) or in the devices file. A " +
      "neighbour is seen only on a directly attached Layer-2 segment, so a router behind another " +
      "router does not appear.",
    inputSchema: {
      devices: z
        .array(z.string())
        .optional()
        .describe("Routers to ask. Omit to ask every configured router that is not disabled."),
    },
    async handler(a) {
      const config = getConfig();
      const asked = a.devices?.length
        ? a.devices.map((name: string) => resolveDeviceName(name))
        : Object.entries(config.devices)
            .filter(([, device]) => !device.disabled)
            .map(([name]) => name);
      if (asked.length === 0) return "No router is configured, so there is nothing to ask.";

      const neighborsByDevice: Record<string, ReturnType<typeof parseNeighbors>> = {};
      const failed: string[] = [];
      // One at a time: a fleet-wide read must not open every connection at once.
      for (const name of asked) {
        try {
          assertDeviceAccess([name], "discover_unmanaged_devices", "READ");
          const out = await executeMikrotikCommand(
            "/ip neighbor print detail",
            createContext(undefined, name),
          );
          if (looksLikeError(out)) failed.push(`${name}: ${out.trim().split("\n")[0]}`);
          else neighborsByDevice[name] = parseNeighbors(out);
        } catch (error) {
          failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const graph = buildTopology({
        // Every configured device takes part in the matching, also one that was not asked.
        devices: Object.entries(config.devices).map(([name, device]) => ({
          name,
          config: device,
          status: { reachable: null, checkedAt: null, latencyMs: null },
        })),
        neighborsByDevice,
      });
      const found = graph.nodes.filter((node) => node.onboardable);
      const lines = [
        `Asked ${asked.length - failed.length} of ${asked.length} router(s). ` +
          `${found.length} device(s) are attached and not managed.`,
      ];
      for (const node of found) {
        const seenBy = graph.edges
          .filter((edge) => edge.to === node.id)
          .map((edge) => `${edge.from}${edge.interface ? ` on ${edge.interface}` : ""}`);
        lines.push(
          "",
          `${node.label}`,
          `  board: ${node.board ?? "?"} · version: ${node.version ?? "?"} · platform: ${node.platform ?? "?"}`,
          `  MAC: ${node.mac ?? "?"} · IP: ${node.ip ?? "none (reach it by MAC-Telnet)"}`,
          `  seen by: ${seenBy.join(", ") || "?"}`,
          `  config entry: ${JSON.stringify({ [node.suggestedConfig?.name ?? node.label]: { ...node.suggestedConfig, name: undefined } })}`,
        );
      }
      if (failed.length > 0) lines.push("", "Could not ask:", ...failed.map((f) => `  ${f}`));
      if (found.length > 0)
        lines.push(
          "",
          "To manage one, a person adds it with its username and password or key: dashboard, " +
            "Topology page (Add device), or the devices file. This tool adds nothing.",
        );
      return lines.join("\n");
    },
  }),
];
