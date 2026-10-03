/**
 * Partial IPv4 VLAN scaffolding, paired with device-independent design knowledge.
 * Never equate command completion with verified L2 or dual-stack isolation.
 */
import { z } from "zod";
import { interfaceName } from "../core/schema";
import { executeMikrotikCommand } from "../core/connector";
import { DANGEROUS, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError } from "../core/routeros";
import { getVlanSegmentationGuide, VLAN_GUIDE_TOPICS } from "../core/vlan-guidance";
import { parseCidr, parseIp } from "../sim/ip";

const COVERAGE =
  "PARTIAL IPv4 scaffold only: no bridge port PVID/admission, VLAN filtering activation, SSID mapping, " +
  "router INPUT policy, IPv6 policy, remote return routes or automatic rollback. " +
  "Review existing rules, DNS, overlaps, interface roles and management recovery before apply. " +
  "Command completion does NOT prove isolation or internet access; verify from real clients. " +
  "Read get_vlan_segmentation_guide for the full workflow.";

const portList = (text?: string): string[] => [
  ...new Set(
    (text ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ),
];

/** A sensible default DHCP range (.10–.254) for a /24-style subnet. */
function defaultRange(subnet: string): string {
  const o = subnet.split("/")[0].split(".");
  return `${o[0]}.${o[1]}.${o[2]}.10-${o[0]}.${o[1]}.${o[2]}.254`;
}

export const vlanDesignerTools: ToolModule = [
  defineTool({
    name: "get_vlan_segmentation_guide",
    title: "Read VLAN Segmentation Knowledge",
    annotations: READ,
    noDevice: true,
    description:
      "Read the RouterOS homelab VLAN design guide before VLAN, guest Wi-Fi, IoT or management-network work. " +
      "Covers bridge CPU/tagged/untagged/PVID, dual-stack IPv4/IPv6 isolation, SSIDs/CAPsMAN, VPN return routing, " +
      "Safe Mode/rollback, validation and clean Device/Group/Shared memory. Reference only; no router contact, " +
      "live audit, memory write or authorization. Select a topic for concise guidance, or all for the full checklist.",
    inputSchema: {
      topic: z.enum(["all", ...VLAN_GUIDE_TOPICS]).default("all"),
    },
    handler: (a) => getVlanSegmentationGuide(a.topic),
  }),
  defineTool({
    name: "design_network_segment",
    title: "Preview or Build Partial IPv4 VLAN Scaffolding",
    annotations: DANGEROUS,
    description:
      "Preview partial IPv4 VLAN interface/gateway/DHCP scaffolding (apply=false, no router I/O). " +
      "Read get_vlan_segmentation_guide first. Does NOT produce a complete isolated network. " +
      "Optional NAT requires explicit wan_interface; isolation drops require a reviewed isolation_before .id. " +
      "Bridge membership includes the CPU when ports are supplied, but port PVID/admission, filtering, Wi-Fi, " +
      "INPUT and IPv6 policies remain separate work. apply=true runs sequential non-idempotent writes only " +
      "after explicit approval, backup and a protected management/Safe Mode plan; failures may leave partial state. " +
      "Read back and test clients; never retry blindly or claim isolation from command success.",
    inputSchema: {
      vlan_id: z.number().int().min(1).max(4094),
      name: interfaceName("Name for the VLAN interface, e.g. 'guest'"),
      subnet: z.cidrv4().describe("Canonical IPv4 network CIDR, e.g. '192.168.30.0/24'"),
      gateway: z
        .ipv4()
        .describe("Usable router address inside the subnet, excluded from the DHCP pool"),
      bridge: z.string().default("bridge").describe("Bridge to put the VLAN on"),
      tagged_ports: z
        .string()
        .optional()
        .describe(
          "Comma-separated verified tagged ports; the bridge/CPU is included once automatically",
        ),
      untagged_ports: z.string().optional().describe("Comma-separated access/untagged ports"),
      dhcp: z.boolean().default(true).describe("Create a DHCP server + pool for the segment"),
      dhcp_range: z
        .string()
        .optional()
        .describe(
          "Single start-end IPv4 range excluding gateway/network/broadcast. Required outside /24; /24 defaults to .10–.254",
        ),
      internet: z
        .boolean()
        .default(true)
        .describe(
          "Add egress-scoped IPv4 masquerade (requires wan_interface); not a firewall allow. Set false to reuse existing NAT",
        ),
      wan_interface: z
        .string()
        .trim()
        .min(1)
        .refine(
          (value) => !value.startsWith("!"),
          "Choose one positive egress interface, not a negated matcher",
        )
        .optional()
        .describe(
          "Verified egress interface for new masquerade. Required when internet=true; never inferred",
        ),
      isolate_from: z
        .array(z.cidrv4())
        .optional()
        .describe("Subnets this segment must NOT reach, e.g. ['192.168.1.0/24']"),
      isolation_before: z
        .string()
        .regex(/^\*[0-9a-f]+$/i)
        .optional()
        .describe(
          "Current enabled forward rule .id from a fresh read; insert drops before this reviewed rule, not after broad accepts. Required with isolate_from",
        ),
      apply: z.boolean().default(false).describe("false = preview (default); true = build"),
    },
    async handler(a, ctx) {
      const subnet = parseCidr(a.subnet);
      const gateway = parseIp(a.gateway);
      if (!subnet || subnet.text !== a.subnet || subnet.prefix > 30 || gateway === null) {
        return "Error: use a canonical IPv4 network CIDR (/0–/30) and valid gateway.";
      }
      const broadcast = subnet.network + 2 ** (32 - subnet.prefix) - 1;
      if (gateway <= subnet.network || gateway >= broadcast) {
        return "Error: gateway must be a usable host inside the segment subnet.";
      }
      if (a.internet && !a.wan_interface) {
        return "Error: internet=true requires wan_interface; unscoped masquerade is not safe. Set internet=false to reuse existing NAT.";
      }
      const isolate = [...new Set<string>(a.isolate_from ?? [])];
      if (isolate.length && !a.isolation_before) {
        return "Error: isolate_from requires a reviewed isolation_before rule .id; blindly appending drops may not isolate anything.";
      }
      const tagged = portList(a.tagged_ports);
      const untagged = portList(a.untagged_ports);
      if (untagged.includes(a.bridge) || untagged.some((p) => tagged.includes(p))) {
        return "Error: this routed VLAN requires a tagged bridge/CPU and disjoint tagged/untagged ports.";
      }
      let range: string | undefined;
      if (a.dhcp) {
        if (!a.dhcp_range && subnet.prefix !== 24) {
          return "Error: non-/24 DHCP requires an explicit dhcp_range inside the subnet.";
        }
        const dhcpRange: string = a.dhcp_range ?? defaultRange(a.subnet);
        range = dhcpRange;
        const parts = dhcpRange.split("-");
        const lo = parseIp(parts[0] ?? "");
        const hi = parseIp(parts[1] ?? "");
        if (
          parts.length !== 2 ||
          lo === null ||
          hi === null ||
          lo > hi ||
          lo <= subnet.network ||
          hi >= broadcast ||
          (gateway >= lo && gateway <= hi)
        ) {
          return "Error: dhcp_range must be a single ordered start-end range inside the subnet, excluding network, broadcast and gateway.";
        }
      }
      const prefix = subnet.prefix;
      const vlanIf = a.name;
      const groups: { label: string; commands: string[] }[] = [];

      groups.push({
        label: "VLAN interface + gateway",
        commands: [
          new Cmd("/interface vlan add")
            .set("name", vlanIf)
            .set("vlan-id", a.vlan_id)
            .set("interface", a.bridge)
            .build(),
          new Cmd("/ip address add")
            .set("address", `${a.gateway}/${prefix}`)
            .set("interface", vlanIf)
            .build(),
        ],
      });

      if (tagged.length || untagged.length) {
        groups.push({
          label: "Bridge VLAN tagging",
          commands: [
            new Cmd("/interface bridge vlan add")
              .set("bridge", a.bridge)
              .set("vlan-ids", a.vlan_id)
              .set("tagged", [...new Set([a.bridge, ...tagged])].join(","))
              .opt("untagged", untagged.length ? untagged.join(",") : undefined)
              .build(),
          ],
        });
      }

      if (a.dhcp) {
        const pool = `${a.name}-pool`;
        groups.push({
          label: "DHCP server",
          commands: [
            new Cmd("/ip pool add").set("name", pool).set("ranges", range!).build(),
            new Cmd("/ip dhcp-server add")
              .set("name", `${a.name}-dhcp`)
              .set("interface", vlanIf)
              .set("address-pool", pool)
              .set("disabled", "no")
              .build(),
            new Cmd("/ip dhcp-server network add")
              .set("address", a.subnet)
              .set("gateway", a.gateway)
              .set("dns-server", a.gateway)
              .build(),
          ],
        });
      }

      if (a.internet) {
        groups.push({
          label: "Internet (srcnat masquerade)",
          commands: [
            new Cmd("/ip firewall nat add")
              .set("chain", "srcnat")
              .set("src-address", a.subnet)
              .set("out-interface", a.wan_interface!)
              .set("action", "masquerade")
              .set("comment", `vlan-${a.vlan_id} internet`)
              .build(),
          ],
        });
      }

      if (isolate.length) {
        groups.push({
          label: "Inter-VLAN isolation",
          commands: isolate.map((dst) =>
            new Cmd("/ip firewall filter add")
              .set("chain", "forward")
              .set("src-address", a.subnet)
              .set("dst-address", dst)
              .set("action", "drop")
              .set("place-before", a.isolation_before!)
              .set("comment", `vlan-${a.vlan_id} isolate from ${dst}`)
              .build(),
          ),
        });
      }

      const all = groups.flatMap((g) => g.commands);
      if (!a.apply) {
        const preview = groups
          .map((g) => `# ${g.label}\n${g.commands.map((c) => `  ${c}`).join("\n")}`)
          .join("\n\n");
        return `DRY RUN — VLAN ${a.vlan_id} '${a.name}' (${a.subnet}); ${all.length} command(s):\n\n${COVERAGE}\n\n${preview}\n\nApply only within the complete approved migration plan.`;
      }

      // Revalidate the placement target before any writes; a stale row number/id
      // must not produce half a segment before the firewall command fails.
      if (isolate.length) {
        const anchor = await executeMikrotikCommand(
          new Cmd("/ip firewall filter print count-only where")
            .set(".id", a.isolation_before!)
            .set("chain", "forward")
            .set("disabled", "no")
            .build(),
          ctx,
        );
        if (anchor.trim() !== "1")
          return "Error: isolation_before is not a unique enabled forward rule. No changes applied; read rules again.";
      }
      const done: string[] = [];
      for (const cmd of all) {
        let result: string;
        try {
          result = await executeMikrotikCommand(cmd, ctx);
        } catch (error) {
          return `Error: VLAN apply stopped after ${done.length}/${all.length} acknowledged commands: ${String(error)}. The last command may already have applied. Read back partial state; do not retry blindly.\n${COVERAGE}`;
        }
        if (looksLikeError(result)) {
          return `Built ${done.length}/${all.length} commands, then FAILED: ${result}\nReview partial segment (the VLAN may exist without DHCP/firewall). Do not retry blindly.\n${COVERAGE}`;
        }
        done.push(cmd);
      }
      return `IPv4 scaffold '${a.name}' (id ${a.vlan_id}, ${a.subnet}): ${done.length} command(s) completed. Isolation and connectivity are UNVERIFIED.\n${COVERAGE}`;
    },
  }),
];
