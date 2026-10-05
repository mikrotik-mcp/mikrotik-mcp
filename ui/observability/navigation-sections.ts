import type { ViewId } from "./navigation";

export interface NavigationSection {
  id: string;
  label: string;
  description: string;
  views: ViewId[];
}

/** Group by the operator's task, not by whether a page happens to contain a chart.
 * Route IDs stay stable: bookmarks, cross-page links and pinned-page preferences
 * do not need migration when the information architecture changes.
 */
export const NAVIGATION_SECTIONS: NavigationSection[] = [
  {
    id: "monitoring",
    label: "Monitoring",
    description: "Health, traffic, activity and scheduled alerts",
    views: [
      "overview",
      "home-internet",
      "service-contracts",
      "flows",
      "feed",
      "alerts",
      "schedules",
    ],
  },
  {
    id: "network",
    label: "Network",
    description: "Routers, interfaces, Wi-Fi and routing",
    views: ["devices", "interfaces", "topology", "fabric", "capsman", "service-routing"],
  },
  {
    id: "users-vpn",
    label: "Users & VPN",
    description: "LAN clients, VPN connections and user accounting",
    views: ["clients", "openvpn", "aaa"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Troubleshoot paths, inspect packets and collect evidence",
    views: [
      "investigations",
      "ip-intelligence",
      "client-checks",
      "round-trip",
      "simulator",
      "packets",
      "flight-recorder",
      "support-bundles",
    ],
  },
  {
    id: "security",
    label: "Security",
    description: "Attack detection, vulnerabilities and compliance",
    views: ["attacks", "vulns", "policies"],
  },
  {
    id: "configuration",
    label: "Router configuration",
    description: "Understand, plan and audit router changes",
    views: ["explain", "plan", "txn", "drift"],
  },
  {
    id: "recovery",
    label: "Backup & recovery",
    description: "Snapshots, backup vaults and replacement routers",
    views: ["snapshots", "backups", "s3", "router-migration", "recovery-lab"],
  },
  {
    id: "workspace",
    label: "MCP workspace",
    description: "AI context, tool permissions and server settings",
    views: ["prompts", "memory", "modules", "access", "config", "releases"],
  },
];

/** Common operator vocabulary for pages whose product names are less obvious. */
export const PAGE_SEARCH_TERMS: Partial<Record<ViewId, string>> = {
  "ip-intelligence":
    "ip lookup ipquery ipkit geo asn organization isp location vpn proxy tor reputation",
  capsman: "wifi wireless access points roaming",
  aaa: "radius user manager authentication accounting profiles",
  fabric: "bridge switch ports layer2",
  access: "mcp permissions allow deny scope",
  config: "mcp settings configuration server service probes targets",
  simulator: "simulate packet trace firewall routing",
  schedules: "scheduled audits cron automation",
  explain: "explain configuration architecture documentation",
  s3: "cloud backup storage bucket",
};
