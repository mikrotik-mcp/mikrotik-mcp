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
