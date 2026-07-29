/**
 * Runtime configuration: one or more named MikroTik devices + MCP transport.
 *
 * For multi-device setups (e.g. building a tunnel between two routers) define a
 * `devices` map via a JSON config file (`--config` / `MIKROTIK_CONFIG_FILE`) or
 * the `MIKROTIK_DEVICES` env var. Each device gets a name the AI can target
 * per tool call.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Default observability DB location: `~/.mikrotik-mcp/events.db`. `homedir()`
 * resolves the per-user home on Windows, macOS and Linux, so the database lives
 * outside the project tree and survives reinstalls. Overridable via
 * `MIKROTIK_DASHBOARD__DB_PATH` / `--dashboard-db` / the config `dashboard` block.
 */
export const DEFAULT_DASHBOARD_DB = join(homedir(), ".mikrotik-mcp", "events.db");

/**
 * Default configuration-snapshot DB location: `~/.mikrotik-mcp/snapshots.db`.
 * Snapshots persist independently of the observability dashboard, so they get
 * their own database alongside `events.db` in the per-user state directory.
 */
export const DEFAULT_SNAPSHOT_DB = join(homedir(), ".mikrotik-mcp", "snapshots.db");

/** Default SQLite path for collected NetFlow/IPFIX records. */
export const DEFAULT_FLOWS_DB = join(homedir(), ".mikrotik-mcp", "flows.db");

/**
 * Default knowledge-graph memory DB: `~/.mikrotik-mcp/memory.db`. Persists
 * entities, relations and observations across sessions so the AI builds
 * long-term structured knowledge about the managed network.
 */
export const DEFAULT_MEMORY_DB = join(homedir(), ".mikrotik-mcp", "memory.db");

/**
 * Default local backup vault: `~/.mikrotik-mcp/backups/`. Holds `/export` `.rsc`
 * config backups on the MCP server's own filesystem (NOT on the device, NOT S3),
 * one file per backup. Override with `MIKROTIK_BACKUP_DIR`.
 */
export const DEFAULT_BACKUP_DIR = join(homedir(), ".mikrotik-mcp", "backups");

/**
 * Default config version-history store: `~/.mikrotik-mcp/config-history/`. Holds
 * point-in-time snapshots of the dashboard's own configuration (one JSON file
 * per version) so a change can be reviewed and rolled back from the Config page.
 */
export const DEFAULT_CONFIG_HISTORY_DIR = join(homedir(), ".mikrotik-mcp", "config-history");

/**
 * Where the dashboard's Config Studio writes when config did NOT come from a
 * `--config` file (e.g. it was assembled from env/flags). Sits beside the other
 * per-user state so a hand-started server can still be made file-editable.
 */
export const DEFAULT_CONFIG_FILE = join(homedir(), ".mikrotik-mcp", "config.json");

export const TransportSchema = z.enum(["stdio", "sse", "streamable-http"]);
export type Transport = z.infer<typeof TransportSchema>;

export const McpServerSettingsSchema = z.object({
  transport: TransportSchema.default("stdio"),
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(8000),
  /** Comma-separated Host header allowlist for DNS-rebinding protection. "*" disables it. */
  allowedHosts: z.string().default(""),
  /** Comma-separated Origin header allowlist for DNS-rebinding protection. */
  allowedOrigins: z.string().default(""),
  /**
   * Comma-separated CORS allow-list for the `/mcp` endpoint. Empty uses the
   * built-in MCP-host defaults (ChatGPT, Claude); "*" allows any origin.
   * Required for the ChatGPT Apps connector (its preflight needs CORS).
   */
  corsOrigins: z.string().default(""),
  /**
   * Page size for `tools/list`. `0` (default) sends every tool in one response —
   * the current behaviour. A positive value delivers the SAME full catalog in
   * cursor-paginated pages (MCP-standard) so clients that struggle with a very
   * large single response can still load EVERY tool. No tool is ever disabled.
   */
  toolPageSize: z.coerce.number().int().min(0).default(0),
  /**
   * Emit MCP App view metadata (`_meta.ui`) on tools. Default false. Set true
   * to enable interactive table/detail widgets on read tools. When enabled,
   * every `list_*`/`get_*` read tool carries the auto-records view which adds
   * `(renders an MCP App view)` to tool descriptions — this can bloat the LLM
   * context and some MCP hosts hide or deprioritise tools that carry App /
   * `openai/outputTemplate` metadata. Disabled by default to keep the tool
   * surface lean and broadly compatible.
   */
  appViews: z.boolean().default(false),
  /**
   * How to treat tools the target device cannot run (see `src/core/capability.ts`).
   *
   * - `off` — never annotate or filter; the probe still runs for the dashboard.
   * - `annotate` (default) — unsupported tools stay listed but their description
   *   is prefixed with the reason, which is what the model reads when choosing.
   * - `filter` — unsupported tools are omitted from `tools/list` entirely.
   *
   * `filter` is honoured only in single-device mode: with several devices the
   * tool list is global while capabilities are per-device, so a tool unusable on
   * one router may be essential on another. In multi-device mode it degrades to
   * `annotate` with a warning.
   *
   * Independently of this setting, a tool declaring `requires` is always guarded
   * at call time — listing behaviour is UX, the guard is the safety net.
   */
  capabilityGating: z.enum(["off", "annotate", "filter"]).default("annotate"),
});
export type McpServerSettings = z.infer<typeof McpServerSettingsSchema>;

/** Connection details for a single MikroTik device. */
/**
 * Inline SSH jump host (bastion) — the same SSH connection fields a device has.
 * Used by a device's `jumpHost` when the bastion is NOT itself a configured
 * device; prefer a device's `jumpVia` to reuse an existing entry's credentials.
 */
export const JumpHostSchema = z.object({
  host: z.string(),
  port: z.coerce.number().int().positive().default(22),
  username: z.string().default("admin"),
  password: z.string().optional(),
  keyFilename: z.string().optional(),
  privateKey: z.string().optional(),
  keyPassphrase: z.string().optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
});
export type JumpHostConfig = z.infer<typeof JumpHostSchema>;

export const DeviceConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  username: z.string().default("admin"),
  password: z.string().default(""),
  port: z.coerce.number().int().positive().default(22),
  keyFilename: z.string().optional(),
  /** Optional inline private key (PEM). Takes precedence over keyFilename. */
  privateKey: z.string().optional(),
  /** Passphrase for an encrypted private key (keyFilename or privateKey). */
  keyPassphrase: z.string().optional(),
  /** SSH connect timeout in milliseconds. */
  timeoutMs: z.coerce.number().int().positive().default(10_000),
  /**
   * SSH jump host: reach this device THROUGH another configured device used as a
   * bastion (SSH ProxyJump). Set to the NAME of another device in this config —
   * the MCP opens an SSH session to that router and tunnels onward to this
   * device's `host:port`, so this device needs no port exposed to the network.
   * The bastion must be an SSH device (not MAC-Telnet) and may itself set
   * `jumpVia` for a multi-hop chain. SSH-only; ignored for a MAC-Telnet device.
   * Requires SSH TCP forwarding on the bastion (`/ip ssh set
   * forwarding-enabled=local`). Use `jumpHost` instead for a non-device bastion.
   */
  jumpVia: z.string().optional(),
  /**
   * Inline SSH jump host (bastion) for when it isn't a configured device — same
   * SSH connection fields as a device. Prefer `jumpVia` to reuse an existing
   * device entry. Ignored when `jumpVia` is also set.
   */
  jumpHost: JumpHostSchema.optional(),
  /**
   * Target MAC address (e.g. `48:A9:8A:C6:42:F7`). When set, this device is
   * reached over **MAC-Telnet** (Layer-2, UDP 20561) instead of SSH — no IP is
   * needed, so it works for a freshly-unboxed or misconfigured router. The
   * `host`/`port`/key fields above are ignored for a MAC device; auth uses
   * `username`/`password` (MTWEI, falling back to MD5 on legacy gear).
   */
  mac: z.string().optional(),
  /**
   * Optional explicit in-packet source MAC for MAC-Telnet. Usually omitted —
   * the resolver uses the real MAC of the egress interface, which is what
   * RouterOS's mac-server requires to answer.
   */
  sourceMac: z.string().optional(),
  /**
   * Optional UDP delivery host for MAC-Telnet (e.g. a subnet broadcast like
   * `10.0.0.255`). Omit to auto-discover the route by spraying every
   * interface's directed broadcast.
   */
  macHost: z.string().optional(),
  /** Optional UDP port the device's mac-server listens on (default 20561). */
  macPort: z.coerce.number().int().positive().optional(),
  /**
   * Use the RouterOS **REST API** (`/rest`, RouterOS 7.9+) where the command
   * maps cleanly, falling back to SSH for everything it cannot express —
   * `/export`, Safe Mode, the interactive `/tool` commands, `[find]` selectors.
   *
   * REST returns structured JSON and real HTTP status codes instead of scraped
   * console text, and skips the per-command SSH channel setup. Opt-in per
   * device: it changes the shape of some tool output (list results render in
   * the `print detail` form), and it requires the `www-ssl` service enabled.
   */
  api: z.boolean().optional(),
  /** HTTPS port for the REST API (`/ip service www-ssl`). Default 443. */
  apiPort: z.coerce.number().int().positive().optional(),
  /**
   * Accept a self-signed TLS certificate for the REST API. RouterOS ships one
   * by default, so most deployments need this — but it disables certificate
   * verification, so it stays a deliberate opt-in rather than the default.
   */
  apiInsecureTls: z.boolean().optional(),
  /** Free-text label shown to the AI (e.g. "HQ edge router"). */
  description: z.string().optional(),
  /**
   * Free-form labels for selecting groups of devices — e.g. `["branch", "eu"]`.
   * Used by staged fleet rollouts (`targets: { tags: ["branch"] }`) so a change
   * can name a class of routers rather than enumerating them, which is both
   * shorter and less likely to silently miss a device someone added later.
   */
  tags: z.array(z.string()).default([]),
  /** When true, this device is excluded from the MCP tool surface — the AI cannot target it. */
  disabled: z.boolean().optional(),
});
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;

/**
 * Optional S3-compatible object storage for shipping backup/export files off
 * the device. When omitted, the S3 backup tools are inert. Credentials follow
 * Bun's native S3 conventions (`S3_*`, then `AWS_*` env fallbacks) and may be
 * overridden here or via a JSON config `s3` block.
 */
export const S3ConfigSchema = z.object({
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().optional(),
  region: z.string().optional(),
  /** Custom endpoint for R2/MinIO/Spaces/etc. Omit for AWS S3. */
  endpoint: z.string().optional(),
  bucket: z.string().optional(),
  /** Key prefix prepended to backup object keys, e.g. "mikrotik/". */
  prefix: z.string().default(""),
  /** Presigned-URL lifetime (seconds) used for device `/tool fetch` transfers. */
  presignExpiresIn: z.coerce.number().int().positive().default(3600),
});
export type S3Config = z.infer<typeof S3ConfigSchema>;

/**
 * Optional real-time observability dashboard. When enabled, every MCP tool call
 * the LLM makes is intercepted at the registry, persisted to a Bun-native SQLite
 * database and streamed to a web dashboard (live feed + analytics) served on its
 * own host/port, independently of the MCP transport. Disabled by default.
 */
/**
 * Alert delivery channels. Every `url` here is a **credential** — for Slack,
 * Discord and ntfy the secret is the path, so anyone holding the URL can post
 * as you. They are masked (`maskUrl`) before any logging, storage or API
 * response. No SSRF validation is performed: these endpoints are configured
 * deliberately by the operator.
 */
export const AlertChannelsSchema = z.object({
  slack: z.object({ url: z.string().url() }).optional(),
  discord: z.object({ url: z.string().url() }).optional(),
  ntfy: z.object({ url: z.string().url(), token: z.string().optional() }).optional(),
  webhook: z
    .object({
      url: z.string().url(),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** Push `notifications/message` to the connected MCP client. No config needed. */
  mcp: z.object({}).optional(),
});

/**
 * Alerting configuration. Rules are validated by `src/alerts/model.ts`; this
 * schema keeps them loose (`unknown[]`) so a malformed rule surfaces as a clear
 * alerting error at load rather than failing the entire server config.
 */
export const AlertsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  rules: z.array(z.unknown()).default([]),
  channels: AlertChannelsSchema.default(() => ({})),
  /** Alert history retention, in records. */
  maxHistory: z.coerce.number().int().positive().default(5000),
});
export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;

/**
 * Traffic Flow collection. Opt-in: nothing binds a UDP port unless `enabled` is
 * set (or `start_flow_collector` is called), and the store is only opened then.
 *
 * Flow volume on a busy link is unbounded, so retention is capped in two tiers —
 * raw records for hours, 1-minute rollups for weeks — plus a hard row cap whose
 * evictions are logged. Silent loss on a monitoring feature reads as "no
 * traffic", which is worse than no feature at all.
 */
export const FlowsConfigSchema = z.object({
  /** Start the collector with the server. Off by default. */
  enabled: z.boolean().default(false),
  /** UDP port the device exports to (RouterOS default for NetFlow is 2055). */
  port: z.coerce.number().int().positive().default(2055),
  /** SQLite path (`:memory:` for an ephemeral store). */
  db: z.string().default(DEFAULT_FLOWS_DB),
  /** How long raw flow records are kept. */
  retentionHours: z.coerce.number().int().positive().default(24),
  /** How long 1-minute rollups are kept. */
  rollupDays: z.coerce.number().int().positive().default(30),
  /** Hard cap on raw rows; the oldest are evicted first (and logged). */
  maxRows: z.coerce.number().int().positive().default(2_000_000),
});
export type FlowsConfig = z.infer<typeof FlowsConfigSchema>;

export const DashboardConfigSchema = z.object({
  /** Master switch. When false, zero overhead and no SQLite is loaded. */
  enabled: z.boolean().default(false),
  /**
   * Bind host for the dashboard HTTP/WebSocket server. Defaults to `0.0.0.0` so
   * the dashboard is reachable from other devices on the LAN (e.g. a phone or
   * laptop) — set a `token` to require auth, or bind `127.0.0.1` for local-only.
   */
  host: z.string().default("0.0.0.0"),
  /** Bind port for the dashboard server. */
  port: z.coerce.number().int().positive().default(9090),
  /** SQLite database path (`:memory:` for an ephemeral, in-process store). */
  dbPath: z.string().default(DEFAULT_DASHBOARD_DB),
  /** Retention cap — older events are pruned beyond this many rows. */
  maxEvents: z.coerce.number().int().positive().default(100_000),
  /** Record tool input/output bodies. Off keeps only metadata. */
  captureBody: z.boolean().default(true),
  /**
   * Mask secret-looking input fields (password / key / psk / token / …) before
   * storing. Off stores inputs verbatim in the dashboard and SQLite — handy for
   * debugging, but secrets then land on disk. Defaults off per local-debug use.
   */
  redactInput: z.boolean().default(false),
  /** Per-body truncation budget in characters. */
  maxBodyBytes: z.coerce.number().int().nonnegative().default(16_384),
  /** Optional bearer token; when set, the dashboard page and API require it. */
  token: z.string().optional(),
  /**
   * How many rows the Live Feed table renders. A display cap only — the in-memory
   * event buffer is separate and larger. Kept here (not in the browser) so it
   * shows in the effective config, is editable in the config editor, and is the
   * same for every viewer.
   */
  feedLimit: z.coerce.number().int().positive().max(10_000).default(200),
});
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;

/**
 * Persistent knowledge-graph memory. Entities, relations and observations are
 * stored in a SQLite database so the AI can accumulate structured knowledge
 * across sessions. Enabled by default; the DB is opened lazily on first use.
 */
export const MemoryConfigSchema = z.object({
  /** Master switch — when false the memory tools are inert (no DB opened). */
  enabled: z.boolean().default(true),
  /** SQLite database path for the knowledge graph (`:memory:` for ephemeral). */
  dbPath: z.string().default(DEFAULT_MEMORY_DB),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * Tool-surface curation. This server exposes several hundred tools across ~110
 * modules; MCP clients discover tools by relevance search and only feed a capped
 * candidate set to the model, so a query can crowd out simple read tools (e.g.
 * `list_wireguard_*` losing to `build_wireguard_mesh`). Narrowing the surface to
 * the scopes a deployment actually uses makes every matching tool surface
 * reliably. Filtering is by module `slug` or `group` (see `moduleCatalog`).
 *
 * Semantics: when any allow-list (`enabledModules`/`enabledGroups`) is non-empty,
 * ONLY modules matching it register; everything else is dropped. The deny-lists
 * (`disabledModules`/`disabledGroups`) are then subtracted and take precedence —
 * a module named in both an allow- and a deny-list is excluded. All matching is
 * case-insensitive. Empty everywhere = the full surface (the default).
 */
/**
 * SSH connection pooling. When enabled (the default), the server keeps one
 * persistent SSH connection per device and opens a fresh exec channel for each
 * command — eliminating the ~200-500 ms handshake overhead per tool call.
 * Especially valuable through jump hosts, where the handshake cost doubles.
 */
export const SSHConfigSchema = z.object({
  /** Reuse SSH connections across tool calls (connection pooling). Default: true. */
  keepAlive: z.boolean().default(true),
  /** Interval (ms) for SSH keepalive packets on persistent connections. Default: 10 000. */
  keepAliveInterval: z.coerce.number().int().nonnegative().default(10_000),
  /** Close idle persistent connections after this duration (ms). Default: 30 000. */
  idleTimeout: z.coerce.number().int().positive().default(30_000),
});
export type SSHConfig = z.infer<typeof SSHConfigSchema>;

export const ToolFilterSchema = z.object({
  /** Module slugs to expose (allow-list). Empty = all modules. */
  enabledModules: z.array(z.string()).default([]),
  /** Module slugs to hide (deny-list, wins over enable). */
  disabledModules: z.array(z.string()).default([]),
  /** Module groups to expose (allow-list). Empty = all groups. */
  enabledGroups: z.array(z.string()).default([]),
  /** Module groups to hide (deny-list, wins over enable). */
  disabledGroups: z.array(z.string()).default([]),
});
export type ToolFilter = z.infer<typeof ToolFilterSchema>;

export const MikrotikConfigSchema = z.object({
  /** Named devices the server can reach. Always has at least one entry. */
  devices: z
    .record(z.string(), DeviceConfigSchema)
    .default(() => ({ default: DeviceConfigSchema.parse({}) })),
  /** Device used when a tool call doesn't specify one. */
  defaultDevice: z.string().default("default"),
  mcp: McpServerSettingsSchema.default(() => McpServerSettingsSchema.parse({})),
  /** Optional S3 storage; absent unless configured (feature is opt-in). */
  s3: S3ConfigSchema.optional(),
  /** Real-time observability dashboard (opt-in; off by default). */
  dashboard: DashboardConfigSchema.default(() => DashboardConfigSchema.parse({})),
  /** Alerting: rules + delivery channels. Absent unless configured (opt-in). */
  alerts: AlertsConfigSchema.optional(),
  /** NetFlow/IPFIX collection (opt-in; binds a UDP port only when enabled). */
  flows: FlowsConfigSchema.default(() => FlowsConfigSchema.parse({})),
  /**
   * SSH connection pooling — keeps one persistent connection per device and
   * reuses it across tool calls, saving the handshake cost. Enabled by default.
   */
  ssh: SSHConfigSchema.default(() => SSHConfigSchema.parse({})),
  /**
   * Read-only mode: register only `readOnlyHint` tools (inspection, no changes).
   * Recommended whenever the server is exposed publicly (e.g. a ChatGPT Apps
   * connector) before authentication is in place — it withholds every write /
   * destructive tool from the surface entirely.
   */
  readOnly: z.boolean().default(false),
  /**
   * Tool-surface curation — expose only the scopes a deployment needs so the
   * client's tool search reliably surfaces every matching tool (see
   * {@link ToolFilterSchema}). Off by default (the full surface registers).
   */
  tools: ToolFilterSchema.default(() => ToolFilterSchema.parse({})),
  /** Persistent knowledge-graph memory (entities, relations, observations). */
  memory: MemoryConfigSchema.default(() => MemoryConfigSchema.parse({})),
  /**
   * Directory for the local backup vault (`/export` `.rsc` files on the MCP host).
   * Editable from the dashboard's Backups page and persisted here. Falls back to
   * `~/.mikrotik-mcp/backups/` (the `MIKROTIK_BACKUP_DIR` env var overrides both).
   */
  backupDir: z.string().optional(),
  /**
   * Suppress background update checks (startup whisper + cache seeding). The
   * `check_server_pulse` tool still works on-demand. Useful for air-gapped or
   * privacy-conscious deployments. Env: `MIKROTIK_DISABLE_UPDATE_CHECK`.
   */
  disableUpdateCheck: z.boolean().default(false),
});
export type MikrotikConfig = z.infer<typeof MikrotikConfigSchema>;

/** Reads a value from a list of candidate env var names (first non-empty wins). */
function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Parse `--flag value` / `--flag=value` style arguments into a flat map.
 * Booleans without a value default to "true".
 */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

/** Parse a multi-device source (JSON file or inline JSON) into a devices map. */
function parseDevicesSource(
  raw: string,
  fromFile: boolean,
): {
  devices: Record<string, unknown>;
  defaultDevice?: string;
  s3?: Record<string, unknown>;
  dashboard?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  ssh?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  readOnly?: boolean;
  disableUpdateCheck?: boolean;
  backupDir?: string;
} {
  let json: unknown;
  try {
    json = JSON.parse(fromFile ? readFileSync(raw, "utf8") : raw);
  } catch (e) {
    throw new Error(
      `Failed to load MikroTik devices from ${fromFile ? `file ${raw}` : "MIKROTIK_DEVICES"}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const obj = json as Record<string, unknown>;
  // Accept either { devices: {...}, defaultDevice } or a bare { name: {...} } map.
  const structured = obj.devices !== undefined;
  const devices = (obj.devices ?? obj) as Record<string, unknown>;
  const defaultDevice = typeof obj.defaultDevice === "string" ? obj.defaultDevice : undefined;
  // Only read `s3` / `dashboard` blocks from the structured form, so a device
  // literally named "s3"/"dashboard" in a bare map isn't mistaken for config.
  const s3 =
    structured && obj.s3 && typeof obj.s3 === "object"
      ? (obj.s3 as Record<string, unknown>)
      : undefined;
  const dashboard =
    structured && obj.dashboard && typeof obj.dashboard === "object"
      ? (obj.dashboard as Record<string, unknown>)
      : undefined;
  const tools =
    structured && obj.tools && typeof obj.tools === "object"
      ? (obj.tools as Record<string, unknown>)
      : undefined;
  const mcp =
    structured && obj.mcp && typeof obj.mcp === "object"
      ? (obj.mcp as Record<string, unknown>)
      : undefined;
  const ssh =
    structured && obj.ssh && typeof obj.ssh === "object"
      ? (obj.ssh as Record<string, unknown>)
      : undefined;
  const memory =
    structured && obj.memory && typeof obj.memory === "object"
      ? (obj.memory as Record<string, unknown>)
      : undefined;
  // Top-level scalar toggles (also structured-form only, for the same reason).
  const readOnly = structured && typeof obj.readOnly === "boolean" ? obj.readOnly : undefined;
  const disableUpdateCheck =
    structured && typeof obj.disableUpdateCheck === "boolean" ? obj.disableUpdateCheck : undefined;
  const backupDir = structured && typeof obj.backupDir === "string" ? obj.backupDir : undefined;
  return {
    devices,
    defaultDevice,
    s3,
    dashboard,
    tools,
    mcp,
    ssh,
    memory,
    readOnly,
    disableUpdateCheck,
    backupDir,
  };
}

/**
 * Build the effective configuration from the environment and CLI flags.
 * `argv` defaults to the process arguments (after `bun run <file>`).
 */
/** Where the active config was loaded from (set by {@link loadConfig}). */
export interface ConfigSource {
  /** Absolute path of the config file (the real source, or the default target). */
  path: string;
  /** True when config actually came from this file; false when env/flag-assembled. */
  fromFile: boolean;
}

let configSource: ConfigSource = { path: DEFAULT_CONFIG_FILE, fromFile: false };

/** The resolved config source — which file the dashboard should read/write. */
export function getConfigSource(): ConfigSource {
  return configSource;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): MikrotikConfig {
  const flags = parseFlags(argv);
  const pick = (flag: string, ...envNames: string[]) => flags[flag] ?? env(...envNames);

  // Precedence for a settings block: schema default → config-file block →
  // explicit env/flag. An explicit CLI flag or env var overrides the matching
  // config-file value; a value left undefined (flag/env not set) NEVER clobbers a
  // file value. This is the conventional "flags win over config file" behaviour —
  // e.g. `--dashboard-port 9091` overrides a `dashboard.port` saved in the file.
  const overlay = (
    file: Record<string, unknown> | undefined,
    over: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...file };
    for (const [k, v] of Object.entries(over)) if (v !== undefined) out[k] = v;
    return out;
  };

  // Optional inline SSH jump host for the single-device path. Built only when a
  // jump host is named; the schema fills the rest (port 22, user admin).
  const jumpHostName = pick("jump-host", "MIKROTIK_JUMP_HOST");
  const jumpHost = jumpHostName
    ? {
        host: jumpHostName,
        port: pick("jump-port", "MIKROTIK_JUMP_PORT"),
        username: pick("jump-username", "MIKROTIK_JUMP_USERNAME"),
        password: pick("jump-password", "MIKROTIK_JUMP_PASSWORD"),
        keyFilename: pick("jump-key-filename", "MIKROTIK_JUMP_KEY_FILENAME"),
        keyPassphrase: pick("jump-key-passphrase", "MIKROTIK_JUMP_KEY_PASSPHRASE"),
      }
    : undefined;

  // A bare `--api` parses to "true"; anything explicitly falsy turns it off.
  // Returns undefined when unset so the schema/config-file value survives.
  const flagBool = (v: string | undefined): boolean | undefined =>
    v === undefined ? undefined : !/^(0|false|no|off)$/i.test(v);

  // 1) Single-device fields (legacy MIKROTIK_* / flags) → the "default" device.
  const single = {
    host: pick("host", "MIKROTIK_HOST"),
    username: pick("username", "MIKROTIK_USERNAME"),
    password: pick("password", "MIKROTIK_PASSWORD"),
    port: pick("port", "MIKROTIK_PORT"),
    keyFilename: pick("key-filename", "MIKROTIK_KEY_FILENAME"),
    privateKey: pick("private-key", "MIKROTIK_PRIVATE_KEY"),
    keyPassphrase: pick("key-passphrase", "MIKROTIK_KEY_PASSPHRASE"),
    timeoutMs: pick("timeout-ms", "MIKROTIK_TIMEOUT_MS"),
    // SSH jump host (bastion / ProxyJump): reach the device through this hop.
    jumpHost,
    // MAC-Telnet (Layer-2, no IP): when `mac` is set the device is reached over
    // UDP 20561 instead of SSH. See DeviceConfigSchema.mac.
    mac: pick("mac", "MIKROTIK_MAC"),
    sourceMac: pick("source-mac", "MIKROTIK_SOURCE_MAC"),
    macHost: pick("mac-host", "MIKROTIK_MAC_HOST"),
    macPort: pick("mac-port", "MIKROTIK_MAC_PORT"),
    // RouterOS REST API (7.9+). Tri-state: absent leaves the field unset so a
    // config-file value survives; an explicit flag/env wins. `z.boolean()` does
    // not coerce strings, so these are parsed here rather than by the schema.
    api: flagBool(pick("api", "MIKROTIK_API")),
    apiPort: pick("api-port", "MIKROTIK_API_PORT"),
    apiInsecureTls: flagBool(pick("api-insecure-tls", "MIKROTIK_API_INSECURE_TLS")),
  };
  const hasSingle = Object.values(single).some((v) => v !== undefined);

  const devices: Record<string, unknown> = {};
  let defaultDevice: string | undefined;
  if (hasSingle) {
    devices.default = single;
    defaultDevice = "default";
  }

  // 2) Multi-device source (file wins over the inline env var).
  const configFile = pick("config", "MIKROTIK_CONFIG_FILE");
  // Remember where this config came from so the dashboard's Config Studio knows
  // which file to write back to (and whether one even existed).
  configSource = configFile
    ? { path: resolve(configFile), fromFile: true }
    : { path: DEFAULT_CONFIG_FILE, fromFile: false };
  const devicesInline = flags.devices ?? env("MIKROTIK_DEVICES");
  let fileS3: Record<string, unknown> | undefined = {};
  let fileDashboard: Record<string, unknown> | undefined = {};
  let fileTools: Record<string, unknown> | undefined;
  let fileMcp: Record<string, unknown> | undefined;
  let fileSsh: Record<string, unknown> | undefined;
  let fileMemory: Record<string, unknown> | undefined;
  let fileReadOnly: boolean | undefined;
  let fileDisableUpdateCheck: boolean | undefined;
  let fileBackupDir: string | undefined;
  if (configFile || devicesInline) {
    const src = configFile
      ? parseDevicesSource(configFile, true)
      : parseDevicesSource(devicesInline!, false);
    for (const [name, dc] of Object.entries(src.devices)) devices[name] = dc;
    if (src.defaultDevice) defaultDevice = src.defaultDevice;
    else if (!defaultDevice) defaultDevice = Object.keys(src.devices)[0];
    fileS3 = src.s3;
    fileDashboard = src.dashboard;
    fileTools = src.tools;
    fileMcp = src.mcp;
    fileSsh = src.ssh;
    fileMemory = src.memory;
    fileReadOnly = src.readOnly;
    fileDisableUpdateCheck = src.disableUpdateCheck;
    fileBackupDir = src.backupDir;
  }

  // 3) Optional S3 storage. Credentials follow Bun's native S3 lookup order
  // (S3_* then AWS_*); the config-file `s3` block is the baseline, and an explicit
  // env/flag overrides it.
  const s3 = overlay(fileS3, {
    accessKeyId: pick("s3-access-key-id", "S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
    secretAccessKey: pick("s3-secret-access-key", "S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
    sessionToken: pick("s3-session-token", "S3_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
    region: pick("s3-region", "S3_REGION", "AWS_REGION"),
    endpoint: pick("s3-endpoint", "S3_ENDPOINT", "AWS_ENDPOINT"),
    bucket: pick("s3-bucket", "S3_BUCKET", "AWS_BUCKET"),
    prefix: pick("s3-prefix", "MIKROTIK_S3_PREFIX"),
    presignExpiresIn: pick("s3-presign-expires-in", "MIKROTIK_S3_PRESIGN_EXPIRES_IN"),
  });

  // App-view metadata toggle: env/flag is a tri-state — absent leaves the schema
  // default (true), an explicit falsy value disables it. The config-file
  // `mcp.appViews` (merged below) overrides this.
  const appViewsRaw = pick("app-views", "MIKROTIK_MCP__APP_VIEWS");
  const appViewsEnv =
    appViewsRaw === undefined ? undefined : !/^(0|false|no|off)$/i.test(appViewsRaw);

  const mcp = overlay(fileMcp, {
    transport: pick("transport", "MIKROTIK_MCP__TRANSPORT", "MCP_TRANSPORT"),
    host: pick("mcp-host", "MIKROTIK_MCP__HOST"),
    port: pick("mcp-port", "MIKROTIK_MCP__PORT"),
    allowedHosts: pick("mcp-allowed-hosts", "MIKROTIK_MCP__ALLOWED_HOSTS"),
    allowedOrigins: pick("mcp-allowed-origins", "MIKROTIK_MCP__ALLOWED_ORIGINS"),
    corsOrigins: pick("mcp-cors-origins", "MIKROTIK_MCP__CORS_ORIGINS"),
    toolPageSize: pick("tool-page-size", "MIKROTIK_MCP__TOOL_PAGE_SIZE"),
    // `--app-views=false` / MIKROTIK_MCP__APP_VIEWS=false disables App-view metadata.
    appViews: appViewsEnv,
    capabilityGating: pick("capability-gating", "MIKROTIK_MCP__CAPABILITY_GATING"),
  });

  // Read-only mode (boolean flag/env). A bare `--read-only` parses to "true".
  const isTruthy = (v?: string): boolean => /^(1|true|yes|on)$/i.test(v ?? "");
  // Tri-state: an explicit flag/env wins; otherwise fall back to the config-file
  // value; otherwise leave undefined so zod applies the schema default. This lets a
  // `readOnly`/`disableUpdateCheck` saved by the dashboard config editor round-trip.
  const boolFileFlag = (
    flagVal: string | undefined,
    fileVal: boolean | undefined,
  ): boolean | undefined => (flagVal !== undefined ? isTruthy(flagVal) : fileVal);
  const readOnly = boolFileFlag(pick("read-only", "MIKROTIK_READ_ONLY"), fileReadOnly);
  const disableUpdateCheck = boolFileFlag(
    pick("disable-update-check", "MIKROTIK_DISABLE_UPDATE_CHECK"),
    fileDisableUpdateCheck,
  );
  // Backup vault directory: `--backup-dir`/`MIKROTIK_BACKUP_DIR` wins over the
  // config-file value; both fall back to `DEFAULT_BACKUP_DIR` at read time (vault.ts).
  const backupDir = pick("backup-dir", "MIKROTIK_BACKUP_DIR") ?? fileBackupDir;

  // Tool-surface curation. Env/flags carry comma-separated lists; the config-file
  // `tools` block (arrays) overrides them. A list left undefined stays undefined
  // so an empty file array isn't clobbered by an absent env var.
  const csv = (v?: string): string[] | undefined =>
    v === undefined
      ? undefined
      : v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const tools = overlay(fileTools, {
    enabledModules: csv(pick("tools-enabled-modules", "MIKROTIK_TOOLS__ENABLED_MODULES")),
    disabledModules: csv(pick("tools-disabled-modules", "MIKROTIK_TOOLS__DISABLED_MODULES")),
    enabledGroups: csv(pick("tools-enabled-groups", "MIKROTIK_TOOLS__ENABLED_GROUPS")),
    disabledGroups: csv(pick("tools-disabled-groups", "MIKROTIK_TOOLS__DISABLED_GROUPS")),
  });

  // Coerce a string flag/env to a boolean only when present; undefined lets zod
  // apply its schema default (so e.g. captureBody stays true unless overridden).
  const boolOpt = (v?: string): boolean | undefined => (v === undefined ? undefined : isTruthy(v));

  // 4) Optional observability dashboard. A bare `--dashboard` enables it. The
  // config-file `dashboard` block is the baseline; explicit env/flags (e.g.
  // `--dashboard-port`) override it.
  const dashboard = overlay(fileDashboard, {
    enabled: boolOpt(pick("dashboard", "MIKROTIK_DASHBOARD__ENABLED", "MIKROTIK_DASHBOARD")),
    host: pick("dashboard-host", "MIKROTIK_DASHBOARD__HOST"),
    port: pick("dashboard-port", "MIKROTIK_DASHBOARD__PORT"),
    dbPath: pick("dashboard-db", "MIKROTIK_DASHBOARD__DB_PATH"),
    maxEvents: pick("dashboard-max-events", "MIKROTIK_DASHBOARD__MAX_EVENTS"),
    captureBody: boolOpt(pick("dashboard-capture-body", "MIKROTIK_DASHBOARD__CAPTURE_BODY")),
    redactInput: boolOpt(pick("dashboard-redact-input", "MIKROTIK_DASHBOARD__REDACT_INPUT")),
    maxBodyBytes: pick("dashboard-max-body-bytes", "MIKROTIK_DASHBOARD__MAX_BODY_BYTES"),
    token: pick("dashboard-token", "MIKROTIK_DASHBOARD__TOKEN"),
    feedLimit: pick("dashboard-feed-limit", "MIKROTIK_DASHBOARD__FEED_LIMIT"),
  });

  // 5) SSH connection pooling. Config-file block is the baseline; env/flags override.
  const ssh = overlay(fileSsh, {
    keepAlive: boolOpt(pick("ssh-keep-alive", "MIKROTIK_SSH__KEEP_ALIVE")),
    keepAliveInterval: pick("ssh-keepalive-interval", "MIKROTIK_SSH__KEEPALIVE_INTERVAL"),
    idleTimeout: pick("ssh-idle-timeout", "MIKROTIK_SSH__IDLE_TIMEOUT"),
  });

  // 6) Persistent knowledge-graph memory. Config-file block is the baseline; env/flags override.
  const memory = overlay(fileMemory, {
    enabled: boolOpt(pick("memory-enabled", "MIKROTIK_MEMORY__ENABLED")),
    dbPath: pick("memory-db", "MIKROTIK_MEMORY__DB_PATH"),
  });

  // S3 is opt-in: only attach the block when something meaningful is set, so an
  // unconfigured deployment leaves `config.s3` undefined and the tools inert.
  const hasS3 = !!(s3.accessKeyId || s3.bucket || s3.endpoint);

  const raw = {
    devices: Object.keys(devices).length ? devices : { default: {} },
    defaultDevice: defaultDevice ?? "default",
    mcp,
    dashboard,
    readOnly,
    disableUpdateCheck,
    backupDir,
    tools,
    ssh,
    memory,
    ...(hasS3 ? { s3 } : {}),
  };

  // Drop undefined keys so zod applies its defaults instead of failing on them.
  const pruned = JSON.parse(JSON.stringify(raw));
  const parsed = MikrotikConfigSchema.parse(pruned);

  // Guarantee the default device actually exists.
  if (!parsed.devices[parsed.defaultDevice]) {
    parsed.defaultDevice = Object.keys(parsed.devices)[0] ?? "default";
  }
  return parsed;
}
