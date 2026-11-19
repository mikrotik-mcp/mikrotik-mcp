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
import { READ, WRITE, WRITE_IDEMPOTENT, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, isEmpty, looksLikeError, Cmd, quoted } from "../core/routeros";
import { listenMndp } from "../core/mndp-listen";
import type { HeardNeighbor } from "../core/mndp-listen";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { SECRET_REF } from "../core/secret-ref";
import { DeviceConfigSchema } from "../config";
import { getConfigAdmin } from "../observability/config-admin";
import { probeDevice } from "../observability/health";
import { buildTopology, parseNeighbors } from "../observability/topology";

/** The pseudo source for what the MCP host itself heard. */
const HOST = "MCP host";

/** The hosts of a `/tool ip-scan` table: every row that has an IPv4 address. */
export function parseIpScan(output: string): { ip: string; mac?: string; identity?: string }[] {
  const hosts = new Map<string, { ip: string; mac?: string; identity?: string }>();
  for (const line of output.split(/\r?\n/)) {
    const ip = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
    if (!ip) continue;
    const mac = line.match(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/)?.[0]?.toUpperCase();
    // What is left after the address, the MAC and the response time is a name (DNS or NetBIOS).
    const name = line
      .replace(ip, " ")
      .replace(mac ?? "\0", " ")
      .replace(/\b\d+(?:\.\d+)?m?s\b/g, " ")
      .trim()
      .split(/\s+/)
      .find((word) => /^[A-Za-z][\w.-]{1,60}$/.test(word));
    hosts.set(ip, { ip, mac, identity: name });
  }
  return Array.from(hosts.values());
}

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
      listen_seconds: z
        .number()
        .int()
        .min(0)
        .max(30)
        .default(0)
        .describe(
          "Also listen for MikroTik discovery (MNDP, UDP 5678) on the MCP host itself for this many seconds. Finds devices on the host's own network segment, also with no managed router.",
        ),
      scan: z
        .object({
          device: z.string().describe("The router that runs the scan"),
          interface: z.string().optional().describe("Scan the subnet on this interface"),
          address_range: z.string().optional().describe("Range or CIDR, e.g. '192.168.88.0/24'"),
          seconds: z.number().int().min(1).max(60).default(8),
        })
        .optional()
        .describe(
          "Also scan a subnet from one router (`/tool ip-scan`). Finds hosts that announce nothing, by address and MAC. It sends probes on that network.",
        ),
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

      const notes: string[] = [];
      /** What the host heard and what a scan found: sources that are not a router's neighbour table. */
      const extra: (HeardNeighbor & { source: string })[] = [];
      if (a.listen_seconds > 0)
        try {
          const heard = await listenMndp(a.listen_seconds * 1000);
          extra.push(...heard.map((n) => ({ ...n, source: HOST })));
          notes.push(
            `The MCP host heard ${heard.length} device(s) by MNDP in ${a.listen_seconds} s.`,
          );
        } catch (error) {
          failed.push(
            `${HOST}: could not listen on UDP 5678 (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      if (a.scan) {
        const scan = a.scan as {
          device: string;
          interface?: string;
          address_range?: string;
          seconds: number;
        };
        if (!scan.interface && !scan.address_range)
          failed.push("scan: give an interface or an address_range");
        else
          try {
            const scanner = resolveDeviceName(scan.device);
            assertDeviceAccess([scanner], "discover_unmanaged_devices", "READ");
            const out = await executeMikrotikCommand(
              new Cmd("/tool ip-scan")
                .opt("address-range", scan.address_range)
                .opt("interface", scan.interface)
                .set("duration", `${scan.seconds}s`)
                .build(),
              createContext(undefined, scanner),
            );
            if (looksLikeError(out))
              failed.push(`scan on ${scanner}: ${out.trim().split("\n")[0]}`);
            else {
              const hosts = parseIpScan(out);
              extra.push(...hosts.map((n) => ({ ...n, source: `scan on ${scanner}` })));
              notes.push(`The scan on ${scanner} found ${hosts.length} host(s).`);
            }
          } catch (error) {
            failed.push(`scan: ${error instanceof Error ? error.message : String(error)}`);
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
      // Leave out what is configured, and what a router's neighbour table already gave.
      const norm = (mac?: string): string => (mac ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
      const knownMacs = new Set(
        [...Object.values(config.devices).map((d) => d.mac), ...found.map((n) => n.mac)]
          .map(norm)
          .filter(Boolean),
      );
      const knownIps = new Set(
        [
          ...Object.values(config.devices).flatMap((d) => [d.host, ...(d.fallbackHosts ?? [])]),
          ...found.map((n) => n.ip),
        ].filter(Boolean),
      );
      const others = new Map<string, HeardNeighbor & { source: string }>();
      for (const item of extra) {
        if ((item.mac && knownMacs.has(norm(item.mac))) || (item.ip && knownIps.has(item.ip)))
          continue;
        const key = norm(item.mac) || item.ip || item.identity || "";
        const before = others.get(key);
        others.set(
          key,
          before ? { ...item, ...before, source: `${before.source}, ${item.source}` } : item,
        );
      }
      const lines = [
        `Asked ${Object.keys(neighborsByDevice).filter((key) => asked.includes(key)).length} of ${asked.length} router(s). ` +
          `${found.length + others.size} device(s) are attached and not managed.`,
        ...notes,
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
      for (const item of others.values())
        lines.push(
          "",
          `${item.identity ?? item.ip ?? item.mac ?? "unknown"}`,
          `  board: ${item.board ?? "?"} · version: ${item.version ?? "?"} · platform: ${item.platform ?? "?"}`,
          `  MAC: ${item.mac ?? "?"} · IP: ${item.ip ?? "none (reach it by MAC-Telnet)"}`,
          `  seen by: ${item.source}`,
        );
      if (failed.length > 0) lines.push("", "Could not ask:", ...failed.map((f) => `  ${f}`));
      if (found.length + others.size > 0)
        lines.push(
          "",
          "To manage one, a person adds it with its username and password or key: dashboard, " +
            "Topology page (Add device), the devices file, or enrol_device. This tool adds nothing.",
        );
      return lines.join("\n");
    },
  }),
  defineTool({
    name: "enrol_device",
    title: "Add a Device to This Server",
    annotations: WRITE,
    noDevice: true,
    description:
      "Adds a router to this server's device list, so the other tools can manage it. It is the " +
      "step after discover_unmanaged_devices. The sign-in secret NEVER passes through this " +
      "call: give `password_from` (a reference: `env:NAME`, `file:/path` or " +
      "`keyring:service/account`), `ssh_agent=true`, or `key_filename`. A literal password is not " +
      "accepted, so a person puts the secret in place first and you pass only where it is. The " +
      "tool first connects to the device with those settings; a device that cannot be reached or " +
      "signed in to is NOT added. DEFAULTS TO A CHECK ONLY (`apply=false`) that reports whether " +
      "the connection works. With `apply=true` the device is written to the configuration file " +
      "(a backup is kept) and is usable at once, with no restart. Give `host` for SSH, or `mac` " +
      "for a device with no IP (MAC-Telnet; that needs a password reference). It changes nothing " +
      "on the device itself. A name that already exists is refused.",
    inputSchema: {
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/)
        .describe("Name for the device in this server"),
      host: z.string().optional().describe("IP address or host name (SSH)"),
      mac: z.string().optional().describe("MAC address, for a device with no IP (MAC-Telnet)"),
      port: z.number().int().min(1).max(65535).default(22),
      username: z.string().min(1).default("admin"),
      password_from: z
        .string()
        .regex(SECRET_REF)
        .optional()
        .describe("Where the password is: env:NAME, file:/path or keyring:service/account"),
      ssh_agent: z.boolean().default(false).describe("Sign in with the SSH agent of the host"),
      key_filename: z.string().optional().describe("Path of a private key file on the host"),
      host_key_sha256: z.string().optional().describe("Pin the SSH host key (SHA256:…)"),
      apply: z.boolean().default(false).describe("false = test the connection; true = add"),
    },
    async handler(a) {
      const config = getConfig();
      if (config.devices[a.name]) return `A device named '${a.name}' already exists.`;
      if (!a.host && !a.mac) return "Give a host (SSH) or a mac (MAC-Telnet).";
      if (!a.password_from && !a.ssh_agent && !a.key_filename)
        return "Give password_from, ssh_agent=true or key_filename. A literal password is not accepted: put the secret in an environment variable, a file or the keyring, and pass the reference.";
      const parsed = DeviceConfigSchema.safeParse({
        ...(a.host ? { host: a.host } : {}),
        ...(a.mac ? { mac: a.mac } : {}),
        port: a.port,
        username: a.username,
        passwordFrom: a.password_from,
        sshAgent: a.ssh_agent || undefined,
        keyFilename: a.key_filename,
        hostKeySha256: a.host_key_sha256,
      });
      if (!parsed.success)
        return {
          text: `Not a valid device: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          isError: true,
        };
      const status = await probeDevice(`enrol:${a.name}`, parsed.data, config.devices);
      if (!status.reachable)
        return {
          text: `Not added: the connection failed. ${status.error ?? "The device did not answer."}`,
          isError: true,
        };
      const facts = [
        status.identity,
        status.boardName,
        status.version && `RouterOS ${status.version}`,
      ]
        .filter(Boolean)
        .join(", ");
      if (!a.apply)
        return `The connection works (${facts || "signed in"}). Nothing was added. Set apply=true to add '${a.name}'.`;
      try {
        getConfigAdmin().applyConfig(
          { ...config, devices: { ...config.devices, [a.name]: parsed.data } },
          0,
        );
      } catch (error) {
        return {
          text: `Not added: the configuration could not be saved. ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
      return `Added '${a.name}' (${facts || "signed in"}). It is usable now. An MCP client that listed the tools before may need to reconnect to see it as a device choice.`;
    },
  }),
];
