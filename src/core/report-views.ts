/** Explicit presentation-only coverage. Never changes tool risk or executes a tool. */
export const REPORT_VIEW_TOOLS = {
  investigations: [
    "create_investigation",
    "get_investigation",
    "list_investigations",
    "inspect_flow_path",
    "list_client_flow_candidates",
  ],
  "round-trip": ["trace_round_trip"],
  "service-health": [
    "create_service_contract",
    "list_service_contracts",
    "list_service_probe_targets",
    "run_service_contract",
    "service_contract_history",
    "audit_service_contracts",
  ],
  fabric: ["map_l2_fabric", "locate_host_port"],
  operations: [
    "plan_changes",
    "apply_plan",
    "begin_transaction",
    "add_transaction_step",
    "verify_transaction",
    "commit_transaction",
    "abort_transaction",
    "plan_rollout",
    "rollout_status",
    "config_check_drift",
    "diff_config_snapshots",
    "get_access_scope",
    "safe_mode_status",
    "packet_capture_status",
  ],
  reports: [
    "diagnose_home_internet",
    "compare_home_paths",
    "get_home_internet",
    "refresh_home_devices",
    "name_home_device",
    "preview_home_policy",
    "apply_home_policy",
    "undo_home_policy",
    "diagnose",
    "trace_path",
    "correlate_events",
    "suggest_fix",
    "run_compliance_audit",
    "audit_fleet",
    "audit_known_vulnerabilities",
    "audit_certificate_expiry",
    "audit_firewall_hardening",
    "audit_firewall_default_deny",
    "audit_address_list_enforcement",
    "audit_kernel_ip_hardening",
    "audit_ipv6_firewall_baseline",
    "audit_ssh_hardening",
    "audit_ip_service_exposure",
    "audit_connection_tracking_helpers",
    "audit_management_plane_exposure",
    "audit_account_hygiene",
    "audit_certificate_hygiene",
    "audit_network_segmentation",
    "audit_dns_resolver_exposure",
    "run_security_hardening_audit",
    "run_capsman_audit",
    "audit_capsman_coverage",
    "report_weak_signal_clients",
    "audit_capsman_load",
    "audit_capsman_ft",
    "audit_capsman_ha",
    "simulate_packet",
    "simulate_change",
    "simulate_suite",
    "explain_rule_reachability",
    "run_policy_check",
    "check_policy_snapshot",
    "explain_policy_finding",
    "explain_device",
    "explain_section",
    "diff_explanations",
    "flow_top_talkers",
    "analyze_flows",
    "forecast_link_saturation",
  ],
} as const;

export type ReportViewKind = keyof typeof REPORT_VIEW_TOOLS;
export const REPORT_VIEW_META = "mikrotik/reportView";
export interface ReportView {
  __mikrotikView: "report";
  kind: ReportViewKind;
  tool: string;
  title: string;
  device: string;
  generatedAt: string;
  data: unknown;
  raw: string;
}
const byTool = new Map<string, ReportViewKind>(
  Object.entries(REPORT_VIEW_TOOLS).flatMap(([kind, names]) =>
    names.map((name) => [name, kind as ReportViewKind] as const),
  ),
);
export function reportViewForTool(name: string): ReportViewKind | undefined {
  return byTool.get(name);
}
export function buildReportView(
  kind: ReportViewKind,
  tool: string,
  title: string,
  device: string | undefined,
  raw: string,
  structured?: Record<string, unknown>,
): ReportView {
  let data: unknown = structured;
  if (data === undefined) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  return {
    __mikrotikView: "report",
    kind,
    tool,
    title,
    device: device ?? "default",
    raw,
    data,
    generatedAt: new Date().toISOString(),
  };
}
