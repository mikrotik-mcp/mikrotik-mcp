// ── API types (mirror src/observability) ────────────────────────────────────
export type Risk = "READ" | "WRITE" | "WRITE_IDEMPOTENT" | "DESTRUCTIVE" | "DANGEROUS";
export interface ToolEvent {
  id: string;
  ts: number;
  tool: string;
  title: string;
  risk: Risk;
  device?: string;
  /** MCP transport the call arrived on (`stdio`/`http`) — not the device link. */
  transport?: string;
  /** Which transport actually carried the device command. */
  deviceTransport?: "ssh" | "rest" | "mac-telnet";
  /** Why REST fell back to SSH, when a REST-enabled device did not use it. */
  restFallback?: string;
  durationMs: number;
  isError: boolean;
  error?: string;
  input: string;
  output: string;
  outputBytes: number;
  hasStructured: boolean;
  truncated: boolean;
  reason?: string;
}
export interface Bucket {
  t: number;
  ok: number;
  error: number;
}
export interface Stats {
  total: number;
  errors: number;
  errorRate: number;
  callsPerMin: number;
  outputBytes: number;
  latency: { avg: number; p50: number; p95: number; p99: number; max: number };
  byTool: {
    tool: string;
    count: number;
    errors: number;
    avgMs: number;
    p95Ms: number;
  }[];
  byRisk: Record<Risk, number>;
  byDevice: { device: string; count: number }[];
  byStatus: { ok: number; error: number };
  series: Bucket[];
  recentErrors: { id: string; ts: number; tool: string; error: string }[];
  distinctTools: number;
  distinctDevices: number;
  windowMs: number;
}
export interface Meta {
  version: string;
  tools: string[];
  devices: string[];
  risks: Risk[];
  total: number;
  liveClients: number;
  transport: string;
}
export interface DeviceStatus {
  reachable: boolean | null;
  checkedAt: number | null;
  latencyMs: number | null;
  identity?: string;
  version?: string;
  error?: string;
  boardName?: string;
  architecture?: string;
  cpuCount?: number;
  cpuLoad?: number;
  freeMemory?: number;
  totalMemory?: number;
  memUsedPct?: number;
  freeHdd?: number;
  totalHdd?: number;
  hddUsedPct?: number;
  disks?: RouterDisk[];
  uptime?: string;
}
export interface RouterDisk {
  slot: string;
  model?: string;
  fs?: string;
  size?: number;
  free?: number;
  mountPoint?: string;
  usedPct?: number;
}
export interface MetricSample {
  ts: number;
  cpuLoad: number | null;
  memUsedPct: number | null;
  hddUsedPct: number | null;
  latencyMs: number | null;
}
export interface DevicePoolStatus {
  device: string;
  /** True when there is a live pooled SSH connection for this device. */
  pooled: boolean;
  inflight: number;
  idle: boolean;
  dead: boolean;
}
export interface SSHPoolPayload {
  enabled: boolean;
  config: { keepAlive: boolean; keepAliveInterval: number; idleTimeout: number };
  aggregate: {
    totalConnections: number;
    totalInflight: number;
    totalIdle: number;
    totalBusy: number;
  };
  devices: Array<{ device: string; inflight: number; idle: boolean; dead: boolean }>;
}
/** What a capability probe learned about one device (`GET /api/capabilities`). */
export interface CapabilitiesJson {
  version: string | null;
  channel: "stable" | "long-term" | "testing" | "development" | "unknown";
  board: string;
  arch: string;
  isRouterBoard: boolean;
  packages: string[];
  wirelessStack: "wifi" | "wireless" | "capsman-legacy" | "none";
  deviceMode: { container: boolean; scheduler: boolean; fetch: boolean };
  probedAt: number;
}

/** `GET /api/capabilities` — `capabilities` is null until a probe has resolved. */
export interface CapabilitiesPayload {
  devices: { device: string; capabilities: CapabilitiesJson | null }[];
}

export interface DeviceInfo {
  name: string;
  host: string;
  port: number;
  /** Set when the device is reached over Layer-2 MAC-Telnet instead of SSH. */
  mac?: string;
  transport?: string;
  /** REST HTTPS port, when the device is configured for the REST API. */
  restPort?: number;
  /** Display address: the MAC for a mac-telnet device, else `host:port`. */
  address?: string;
  username: string;
  authMode: string;
  isDefault: boolean;
  description?: string;
  /** Name of another configured device used as an SSH jump host (bastion). */
  jumpVia?: string;
  /** Inline SSH bastion (host/port only; no secrets) when not a named device. */
  jumpHost?: { host: string; port: number };
  status: DeviceStatus;
  /** Country geolocated from the device's public IP; null when private/MAC/unresolved. */
  geo?: { countryCode: string; country: string; city?: string } | null;
  history?: MetricSample[];
  activity: { calls: number; errors: number; lastSeen: number; avgMs: number };
  /** Whether this device is excluded from the MCP tool surface. */
  disabled?: boolean;
  /** SSH connection pool status; null for MAC-Telnet devices or when pool is off. */
  pool: DevicePoolStatus | null;
}
export interface DevicesPayload {
  server: string;
  defaultDevice: string;
  devices: DeviceInfo[];
}
export interface TopoNode {
  id: string;
  kind: "device" | "neighbor";
  label: string;
  configured: boolean;
  onboardable: boolean;
  identity?: string;
  ip?: string;
  mac?: string;
  platform?: string;
  board?: string;
  version?: string;
  reachable?: boolean | null;
  cpuLoad?: number;
  memUsedPct?: number;
  uptime?: string;
  suggestedConfig?: { name: string; host?: string; mac?: string; port: number; username: string };
}
export interface TopoEdge {
  from: string;
  to: string;
  interface?: string;
}
export interface TopologyPayload {
  server: string;
  defaultDevice: string;
  generatedAt: number;
  nodes: TopoNode[];
  edges: TopoEdge[];
  stats: { devices: number; neighbors: number; onboardable: number };
}
export interface PacketSummary {
  ts: number;
  len: number;
  ethType: string;
  src?: string;
  dst?: string;
  protocol?: string;
  info: string;
}
export interface CaptureStats {
  running: boolean;
  port: number;
  startedAt: number | null;
  packets: number;
  bytes: number;
  protocols: Record<string, number>;
  topTalkers: { addr: string; count: number }[];
  pcapFrames: number;
}
export interface CapturePayload {
  packets: PacketSummary[];
  stats: CaptureStats;
}
export type Filter = {
  tool: string;
  risk: string;
  device: string;
  status: string;
  q: string;
};
export type LiveMode = "ws" | "sse" | "off";

// ── Knowledge Graph Memory ──────────────────────────────────────────────────
export interface MemoryEntity {
  name: string;
  entityType: string;
  observations: string[];
  createdAt: number;
  updatedAt: number;
}
export interface MemoryRelation {
  from: string;
  to: string;
  relationType: string;
  createdAt: number;
}
export interface MemoryGraph {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
}
export interface MemoryStats {
  entities: number;
  relations: number;
  observations: number;
  entityTypes: { type: string; count: number }[];
  relationTypes: { type: string; count: number }[];
  recentActivity: MemoryActivityEntry[];
}
export interface MemoryActivityEntry {
  id: number;
  ts: number;
  action: string;
  subject: string;
  detail?: string;
}
export interface MemoryConfig {
  enabled: boolean;
  dbPath: string;
  stats: MemoryStats | null;
}

// ── Config Drift Guardian ──────────────────────────────────────────────────
export interface DriftBaseline {
  device: string;
  snapshotId: string;
  setAt: number;
  setBy: string;
  label?: string;
  notes?: string;
  snapshot?: { lines: number; bytes: number; sha: string; rosVersion?: string } | null;
}
export interface DriftDeviceStatus {
  device: string;
  status: "in-sync" | "drifted" | "unknown" | "no-baseline";
  baseline: DriftBaseline | null;
  latestSnapshotId?: string;
  latestSnapshotTs?: number;
  error?: string;
}
export interface DriftSection {
  path: string;
  added: number;
  removed: number;
  hunks: string;
}
export interface DriftAttribution {
  section: string;
  timestamp?: string;
  user?: string;
  action?: string;
  logLine: string;
}
export interface DriftReport {
  device: string;
  baselineId: string;
  baselineTs: number;
  capturedAt: number;
  identical: boolean;
  score: number;
  summary: { added: number; removed: number; unchanged: number };
  sections: DriftSection[];
  attributions: DriftAttribution[];
  unified: string;
}

// ── Cross-device transactions ───────────────────────────────────────────────
export type TxnStage =
  | "pending"
  | "prepared"
  | "committed"
  | "rolled-back"
  | "restored"
  | "failed"
  | "rollback-failed";
export type TxnTerminalState = "COMMITTED" | "ABORTED" | "PARTIAL";
export interface TxnParticipant {
  device: string;
  stage: TxnStage;
  snapshotId?: string;
  error?: string;
  sessionLost?: boolean;
}
export interface TxnAssertionResult {
  assertion: {
    kind: string;
    device?: string;
    from?: string;
    to?: string;
    peer?: string;
    dst?: string;
  };
  ok: boolean;
  detail: string;
}
export interface TxnRecord {
  id: string;
  ts: number;
  updated: number;
  devices: string[];
  commitOrder: string[];
  phase: string;
  state?: TxnTerminalState;
  participants: TxnParticipant[];
  results: TxnAssertionResult[];
  warnings: string[];
  label?: string;
}
export interface TxnEvent {
  txnId: string;
  seq: number;
  ts: number;
  kind: string;
  device?: string;
  ok: boolean;
  detail?: string;
}
export interface TxnUpdate {
  txnId: string;
  ts: number;
  phase: string;
  state?: TxnTerminalState;
  action: string;
  device?: string;
  ok: boolean;
  detail?: string;
  participants: TxnParticipant[];
}

// ── Traffic Flow (`/api/flows`) ─────────────────────────────────────────────
export interface FlowTopEntry {
  key: string;
  bytes: number;
  packets: number;
  flows: number;
  share: number;
}
export interface FlowConversation {
  src: string;
  dst: string;
  bytes: number;
  packets: number;
  flows: number;
  applications: string[];
}
export interface FlowTotals {
  flows: number;
  bytes: number;
  packets: number;
  sources: number;
  destinations: number;
}
export interface FlowTopPayload {
  window: { from: number; to: number };
  totals: FlowTotals;
  top: FlowTopEntry[];
  protocols: { protocol: string; bytes: number; share: number }[];
  applications: FlowTopEntry[];
  error?: string;
}
export interface FlowTimelinePayload {
  window: { from: number; to: number };
  bucketMs: number;
  keys: string[];
  buckets: { ts: number; series: Record<string, number> }[];
  error?: string;
}
export interface FlowHealth {
  collector: {
    running: boolean;
    port: number;
    startedAt: number | null;
    packets: number;
    flows: number;
    decodeErrors: number;
    lastError?: string;
    templates: number;
    templatesPending: number;
    templatesDropped: number;
    exporters: Record<string, number>;
    queued: number;
  };
  store: {
    rawRows: number;
    rollupRows: number;
    oldestRaw: number | null;
    newestRaw: number | null;
    evicted: number;
  } | null;
}

// ── Staged fleet rollout (`/api/rollout`) ───────────────────────────────────
export type RolloutStage =
  | "pending"
  | "applied"
  | "failed"
  | "reverted"
  | "revert-failed"
  | "skipped";
export type RolloutOutcome =
  | "completed"
  | "completed-with-failures"
  | "halted"
  | "reverted"
  | "needs-attention"
  | "aborted";
export interface RolloutDevice {
  device: string;
  wave: number;
  stage: RolloutStage;
  snapshotId?: string;
  error?: string;
}
export interface RolloutWave {
  index: number;
  devices: string[];
  isCanary: boolean;
}
export interface RolloutGate {
  wave: number;
  ok: boolean;
  failures: { device: string; reason: string }[];
  results: { device: string; reachable: boolean; detail?: string }[];
  collateral?: boolean;
}
export interface RolloutRecord {
  id: string;
  ts: number;
  updated: number;
  label?: string;
  commands: string[];
  waves: RolloutWave[];
  devices: RolloutDevice[];
  gates: RolloutGate[];
  phase: string;
  outcome?: RolloutOutcome;
  notes: string[];
}
export interface RolloutEvent {
  rolloutId: string;
  seq: number;
  ts: number;
  kind: string;
  device?: string;
  ok: boolean;
  detail?: string;
}
export interface RolloutUpdate {
  rolloutId: string;
  ts: number;
  phase: string;
  currentWave: number;
  action: string;
  device?: string;
  ok: boolean;
  outcome?: RolloutOutcome;
  devices: RolloutDevice[];
  gates: RolloutGate[];
}

// ── Policy engine (`/api/policies`) ─────────────────────────────────────────
export type PolicySeverity = "critical" | "high" | "medium" | "low" | "info";
export type PolicyStatus = "pass" | "fail" | "not-applicable";
export interface PolicyRule {
  id: string;
  severity: PolicySeverity;
  description?: string;
  remediation?: string;
  match: { section: string; where?: Record<string, string | number | boolean>; settings?: boolean };
  assert: unknown;
  on_empty: string;
  tags: string[];
}
export interface PolicyFileInfo {
  path: string;
  name?: string;
  ok: boolean;
  issues: { path: string; message: string }[];
  policies: PolicyRule[];
}
export interface PolicyCatalog {
  files: PolicyFileInfo[];
  ruleCount: number;
  duplicateIds: string[];
  emptyPatterns: string[];
  paths: string[];
}
export interface PolicyFinding {
  ruleId: string;
  severity: PolicySeverity;
  status: PolicyStatus;
  description?: string;
  remediation?: string;
  tags: string[];
  device?: string;
  section: string;
  line?: number;
  evidence?: string;
  reason: string;
}
export interface PolicySummary {
  total: number;
  passed: number;
  failed: number;
  notApplicable: number;
  bySeverity: Record<PolicySeverity, number>;
  score: number;
}
export interface PolicyRunReport {
  device: string;
  summary?: PolicySummary;
  findings?: PolicyFinding[];
  markdown?: string;
  error?: string;
}
export interface PolicyResultRow {
  id: number;
  device: string;
  ts: number;
  score: number;
  passed: number;
  failed: number;
  notApplicable: number;
  bySeverity: Record<PolicySeverity, number>;
  findings: PolicyFinding[];
}

// ── Simulator (`/api/sim`) ──────────────────────────────────────────────────
export type SimVerdict = "accept" | "drop" | "reject" | "unknown";
export interface SimStep {
  chain: string;
  index: number;
  action: string;
  line: number;
  raw: string;
  note: string;
}
export interface SimUnmodelled {
  section: string;
  what: string;
  line: number;
  detail?: string;
}
export interface SimTrace {
  verdict: SimVerdict;
  path: string;
  steps: SimStep[];
  nat: { stage: string; rule: number; line: number; note: string }[];
  unmodelled: SimUnmodelled[];
  confidence: "high" | "medium" | "low";
  summary: string;
  routing?: { outcome: string; reason: string; outInterface?: string; gateway?: string };
}
export interface SimPacketPayload {
  source: string;
  result: SimTrace;
  coverage: {
    unmodelled: SimUnmodelled[];
    unparsedLines: number;
    dynamicRouteSources: string[];
  };
  error?: string;
}
export interface SimChangePayload {
  source: string;
  before: SimTrace;
  after: SimTrace;
  diff: { changed: boolean; divergedAt?: number; summary: string };
  error?: string;
}
export interface SimReachabilityRule {
  chain: string;
  index: number;
  action: string;
  line: number;
  raw: string;
  disabled: boolean;
  unreachable: boolean;
  shadowedBy?: number;
  why?: string;
}
export interface SimSuiteEntry {
  name: string;
  expect: "accept" | "drop" | "reject";
  packet: Record<string, unknown>;
}
export interface SimSuite {
  id: string;
  name: string;
  packets: SimSuiteEntry[];
  updated: number;
}
export interface SimSuiteRun {
  suite: { id: string; name: string };
  results: { name: string; expect: string; verdict: SimVerdict; ok: boolean; summary: string }[];
  passed: number;
  total: number;
}

// ── Scheduled audits ────────────────────────────────────────────────────────
export type ScheduleOutcome = "ok" | "failed" | "skipped" | "timeout";
export interface ScheduleFinding {
  id: string;
  severity: string;
  title: string;
  device?: string;
  detail?: string;
}
export interface ScheduleJobRow {
  id: string;
  cron: string;
  cronText: string;
  tool: string;
  devices: string[] | "all";
  notifyOn: string[];
  enabled: boolean;
  retainDays: number;
  createdAt: number;
  nextRun: number | null;
  lastRun: {
    startedAt: number;
    finishedAt: number;
    outcome: ScheduleOutcome;
    device?: string;
    error?: string;
  } | null;
  posture: {
    total: number;
    worst: string | null;
    bySeverity: Record<string, number>;
    devices: number;
  };
  runCount: number;
}
export interface SchedulePoint {
  at: number;
  jobId: string;
  device?: string;
  outcome: ScheduleOutcome;
  total: number;
  bySeverity: Record<string, number>;
  added: number;
  worsened: number;
  resolved: number;
  durationMs: number;
}
export interface ScheduleRegression {
  jobId: string;
  device: string;
  at: number;
  summary: string;
  added: ScheduleFinding[];
  worsened: { finding: ScheduleFinding; from: string; to: string }[];
  resolved: ScheduleFinding[];
}

// ── Config narrative (Explain) ──────────────────────────────────────────────
export interface NarrativeRole {
  role: string;
  label: string;
  score: number;
  signals: { signal: string; role: string; weight: number; section: string }[];
}
export interface NarrativeInterfaceRow {
  name: string;
  kind: string;
  parent?: string;
  vlanId?: number;
  lists: string[];
  addresses: string[];
  comment?: string;
  disabled: boolean;
  purpose?: string;
}
export interface NarrativeSubnetRow {
  cidr: string;
  interface: string;
  routerAddress: string;
  vlanId?: number;
  dhcp?: { server: string; pool?: string; ranges: string[]; gateway?: string; dns?: string };
  reservations: { address: string; macAddress?: string; comment?: string }[];
}
export interface NarrativeExposureRow {
  what: string;
  kind: string;
  detail: string;
  from: string;
  severity: "critical" | "high" | "medium" | "low";
  line: number;
}
export interface DeviceNarrativePayload {
  device?: string;
  generatedAt?: number;
  identity: {
    name?: string;
    version?: string;
    model?: string;
    exportedAt?: string;
    roles: { primary: NarrativeRole | null; secondary: NarrativeRole[] };
  };
  interfaces: NarrativeInterfaceRow[];
  subnets: NarrativeSubnetRow[];
  wans: {
    interface: string;
    addressing: string;
    gateway?: string;
    distance?: number;
    nat: string;
  }[];
  chains: { chain: string; table: string; ruleCount: number; defaultAction: string }[];
  exposure: NarrativeExposureRow[];
  tunnels: { name: string; kind: string; peers: string[]; subnets: string[]; disabled: boolean }[];
  services: { name: string; enabled: boolean; port?: string; availableFrom?: string }[];
  unknowns: { section: string; what: string; line: number; detail?: string }[];
  stats: { recordCount: number; unparsedLines: number; sections: number };
}
export interface ExplainPayload {
  narrative: DeviceNarrativePayload;
  markdown: string;
  mermaid: string;
  source: string;
}
export interface NarrativeDiffPayload {
  diff: {
    identical: boolean;
    changes: { summary: string; impact: string; severity: string; detail?: string }[];
  };
  markdown: string;
  before: string;
  after: string;
}
export interface SnapshotRow {
  id: string;
  device: string;
  ts: number;
  label?: string;
}

// ── Attack detection ────────────────────────────────────────────────────────
export type AttackStage = "recon" | "attempt" | "breach" | "persistence";
export type AttackConfidence = "low" | "medium" | "high" | "confirmed";

export interface AttackEvidence {
  ts: number | null;
  device: string;
  message: string;
  detector: string;
}

export interface AttackIncident {
  id: string;
  source: string;
  devices: string[];
  stage: AttackStage;
  confidence: AttackConfidence;
  severity: string;
  firstTs: number;
  lastTs: number;
  detectors: string[];
  narrative: string;
  recommendations: string[];
  evidence: AttackEvidence[];
  spoofableOnly: boolean;
  signalCount: number;
  blocked?: boolean;
}

export interface AttackResponse {
  id: number;
  incidentId: string;
  action: string;
  source: string;
  devices: string[];
  timeout: string;
  list: string;
  reason: string;
  ts: number;
  expiresAt?: number;
  ok: boolean;
  error?: string;
  revokedAt?: number;
}

export interface AttackPosture {
  enabled: boolean;
  mode: "detect" | "respond";
  autoRespondTo: string[];
  minConfidence: string;
}

export interface AttacksPayload {
  incidents: AttackIncident[];
  responses: AttackResponse[];
  posture: AttackPosture;
  error?: string;
}

export interface AttackSource {
  source: string;
  devices: string[];
  detectors: string[];
  firstTs: number;
  lastTs: number;
  incidents: number;
  worst: string;
  blocked: boolean;
  geo: { countryCode: string; country: string; city?: string } | null;
}

export interface AttackUnavailable {
  detector: string;
  reason: string;
  fix?: string;
}
