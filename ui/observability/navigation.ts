export type ViewId =
  | "home-internet"
  | "overview"
  | "devices"
  | "interfaces"
  | "clients"
  | "investigations"
  | "service-contracts"
  | "round-trip"
  | "aaa"
  | "topology"
  | "fabric"
  | "vulns"
  | "access"
  | "packets"
  | "flows"
  | "snapshots"
  | "drift"
  | "policies"
  | "simulator"
  | "schedules"
  | "explain"
  | "attacks"
  | "txn"
  | "plan"
  | "s3"
  | "backups"
  | "modules"
  | "config"
  | "memory"
  | "alerts"
  | "releases"
  | "capsman"
  | "feed";
export const VIEWS: { id: ViewId; label: string; sub: string }[] = [
  {
    id: "home-internet",
    label: "Home Internet",
    sub: "Understand slowdowns, manage your household & compare paths",
  },
  { id: "overview", label: "Overview", sub: "Calls, latency & risk at a glance" },
  { id: "devices", label: "Devices", sub: "Connectivity radar & system health" },
  { id: "interfaces", label: "Interfaces", sub: "Every port and tunnel — live traffic & counters" },
  { id: "clients", label: "Clients", sub: "Connected LAN devices — usage, block/allow, pin IP" },
  {
    id: "investigations",
    label: "Investigations",
    sub: "Client and service evidence across routers",
  },
  {
    id: "service-contracts",
    label: "Service Health",
    sub: "Approved endpoint checks, contracts and evidence",
  },
  { id: "aaa", label: "RADIUS & UM", sub: "RADIUS client & User Manager RADIUS server" },
  { id: "topology", label: "Topology", sub: "Layer-2 neighbours via MNDP / CDP / LLDP" },
  { id: "round-trip", label: "Round-trip Lab", sub: "Forward and return paths across snapshots" },
  { id: "fabric", label: "L2 Fabric", sub: "Which host sits on which physical bridge port" },
  {
    id: "vulns",
    label: "Vulnerabilities",
    sub: "Published CVEs matched to this version, ranked by real exposure",
  },
  { id: "access", label: "Access Scope", sub: "What this session may call — and what it blocked" },
  { id: "packets", label: "Packets", sub: "Live TZSP capture & decode" },
  { id: "flows", label: "Flows", sub: "NetFlow/IPFIX top talkers, conversations & anomalies" },
  { id: "snapshots", label: "Snapshots", sub: "Config history & time-travel diff" },
  { id: "drift", label: "Drift Guard", sub: "Golden config baselines & live drift detection" },
  {
    id: "attacks",
    label: "Attacks",
    sub: "Live attack incidents, evidence and guarded blocking",
  },
  {
    id: "policies",
    label: "Policies",
    sub: "Your own compliance rules, linted against config",
  },
  {
    id: "explain",
    label: "Explain",
    sub: "Config → architecture document, diagram and consequence diffs",
  },
  {
    id: "simulator",
    label: "Simulator",
    sub: "Trace a hypothetical packet — no device touched",
  },
  {
    id: "schedules",
    label: "Schedules",
    sub: "Auditors on a cron — alerting only on what changed",
  },
  {
    id: "txn",
    label: "Transactions",
    sub: "Cross-device two-phase commit — prepare, verify, commit everywhere",
  },
  { id: "plan", label: "Change Plan", sub: "Dry-run intended RouterOS commands" },
  { id: "s3", label: "S3 Backups", sub: "List, download & delete S3 backup objects" },
  { id: "backups", label: "Backups", sub: "Local config vault — create, restore, manage" },
  { id: "modules", label: "Modules", sub: "Enable/disable tool modules — curate the surface" },
  { id: "config", label: "Config", sub: "Effective configuration & safe editor" },
  { id: "memory", label: "Memory", sub: "Knowledge graph — entities, relations & observations" },
  {
    id: "alerts",
    label: "Alerts",
    sub: "Rules that reach out — Slack, Discord, ntfy, webhook, MCP",
  },
  { id: "releases", label: "Releases", sub: "Update, downgrade & read every version's notes" },
  { id: "capsman", label: "CAPsMAN", sub: "Wi-Fi fabric: coverage, weak signal, load, FT & HA" },
  { id: "feed", label: "Live Feed", sub: "Every tool call, in real time" },
];

export const NAV_GROUPS: { id: string; label: string; views: ViewId[] }[] = [
  {
    id: "observe",
    label: "Observe",
    views: ["overview", "home-internet", "devices", "interfaces", "clients", "feed"],
  },
  {
    id: "investigate",
    label: "Investigate",
    views: [
      "investigations",
      "service-contracts",
      "round-trip",
      "topology",
      "fabric",
      "flows",
      "packets",
    ],
  },
  {
    id: "protect",
    label: "Protect",
    views: ["attacks", "vulns", "policies", "access", "aaa", "capsman"],
  },
  {
    id: "operate",
    label: "Operate",
    views: [
      "plan",
      "simulator",
      "txn",
      "snapshots",
      "drift",
      "backups",
      "s3",
      "schedules",
      "explain",
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    views: ["modules", "config", "memory", "alerts", "releases"],
  },
];

export function viewGroup(view: ViewId) {
  return NAV_GROUPS.find((group) => group.views.includes(view)) ?? NAV_GROUPS[0];
}

/** Accept only known page hashes; never interpret arbitrary text as a route. */
export function parseViewHash(hash: string): ViewId | null {
  const id = hash.replace(/^#\/?/, "");
  return VIEWS.find((view) => view.id === id)?.id ?? null;
}

/** Navigation search stays local; it never searches router data or invokes tools. */
export function navigationGroups(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.views
      .map((id) => VIEWS.find((view) => view.id === id)!)
      .filter((view) =>
        words.every((word) =>
          `${view.label} ${view.sub} ${group.label}`.toLowerCase().includes(word),
        ),
      ),
  })).filter((group) => group.items.length > 0);
}
