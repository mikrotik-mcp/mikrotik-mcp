/**
 * Declarative spec that drives the interactive Config form. Each SECTION becomes
 * a card; its `fields` render as labelled controls in the section's edit sheet.
 * Hand-authored (not derived from the JSON schema) so labels, help text, grouping
 * and "advanced" collapsing read well for non-technical users — cross-checked
 * against `schemas/config.schema.json` (the Field Guide still documents the raw
 * schema). Mirrors `raycast/src/config-spec.ts`; keep the two in sync.
 */

export interface CfgField {
  /** Key on the section object. Dotted (`channels.slack.url`) for nested blocks. */
  key: string;
  label: string;
  /** `list` edits a `string[]` as a comma-separated text field. */
  type: "text" | "number" | "password" | "bool" | "select" | "list";
  options?: string[];
  placeholder?: string;
  help?: string;
  /** Hidden under an "Advanced" disclosure by default. */
  advanced?: boolean;
  /** Secret: prefilled with the «redacted» sentinel; blank = keep existing. */
  secret?: boolean;
}

export interface CfgSection {
  id: string;
  title: string;
  icon: string;
  kind: "object" | "deviceMap" | "modules";
  /** Top-level config key holding this section's object; omit for root-level fields. */
  path?: string;
  /** Active/deactivate control for the whole section. */
  enable?: {
    /** Boolean field toggled on the section object (e.g. `enabled`, `keepAlive`). */
    key?: string;
    /** True when the section is active by mere presence of the block (e.g. `s3`). */
    presence?: boolean;
    label?: string;
  };
  fields: CfgField[];
  /** One-line description shown under the card title. */
  blurb?: string;
}

export const DEVICE_FIELDS: CfgField[] = [
  {
    key: "host",
    label: "Host / IP",
    type: "text",
    placeholder: "192.168.88.1",
    help: "SSH host. Ignored when a MAC address is set (MAC-Telnet).",
  },
  { key: "port", label: "SSH port", type: "number", placeholder: "22" },
  { key: "username", label: "Username", type: "text", placeholder: "admin" },
  { key: "password", label: "Password", type: "password", secret: true },
  { key: "timeoutMs", label: "Timeout (ms)", type: "number", placeholder: "10000" },
  {
    key: "description",
    label: "Description",
    type: "text",
    placeholder: "Core router",
    help: "Free-text label.",
  },
  {
    key: "tags",
    label: "Tags",
    type: "list",
    placeholder: "branch, eu",
    help: "Labels for selecting groups of devices in staged fleet rollouts.",
  },
  {
    key: "keyFilename",
    label: "SSH key file",
    type: "text",
    advanced: true,
    help: "Path to a private-key file.",
  },
  { key: "privateKey", label: "Private key (PEM)", type: "password", secret: true, advanced: true },
  { key: "keyPassphrase", label: "Key passphrase", type: "password", secret: true, advanced: true },
  {
    key: "jumpVia",
    label: "Jump via device",
    type: "text",
    advanced: true,
    help: "Name of another device to use as an SSH bastion.",
  },
  {
    key: "jumpHost.host",
    label: "Jump host (bastion)",
    type: "text",
    advanced: true,
    help: "Inline bastion for hosts that are not themselves configured devices. Prefer “Jump via device” when it is one.",
  },
  {
    key: "jumpHost.port",
    label: "Jump host port",
    type: "number",
    advanced: true,
    placeholder: "22",
  },
  {
    key: "jumpHost.username",
    label: "Jump host user",
    type: "text",
    advanced: true,
    placeholder: "admin",
  },
  {
    key: "jumpHost.password",
    label: "Jump host password",
    type: "password",
    secret: true,
    advanced: true,
  },
  { key: "jumpHost.keyFilename", label: "Jump host key file", type: "text", advanced: true },
  {
    key: "mac",
    label: "MAC address",
    type: "text",
    advanced: true,
    help: "Set to reach the device over Layer-2 MAC-Telnet (no IP).",
  },
  { key: "sourceMac", label: "Source MAC", type: "text", advanced: true },
  { key: "macHost", label: "MAC-Telnet host iface", type: "text", advanced: true },
  {
    key: "macPort",
    label: "MAC-Telnet port",
    type: "number",
    advanced: true,
    placeholder: "20561",
  },
  {
    key: "api",
    label: "Use REST API",
    type: "bool",
    advanced: true,
    help: "RouterOS 7.9+. Runs mappable commands over HTTPS for structured JSON, falling back to SSH for /export, Safe Mode and interactive tools. Needs the www-ssl service enabled.",
  },
  {
    key: "apiPort",
    label: "REST port",
    type: "number",
    advanced: true,
    placeholder: "443",
  },
  {
    key: "apiInsecureTls",
    label: "Accept self-signed TLS",
    type: "bool",
    advanced: true,
    help: "RouterOS ships a self-signed certificate, so most devices need this — it disables certificate verification, so enable it deliberately.",
  },
];

export const CONFIG_SECTIONS: CfgSection[] = [
  {
    id: "devices",
    title: "Devices",
    icon: "🖧",
    kind: "deviceMap",
    blurb: "MikroTik routers this server manages. Toggle a device off to hide it from the tools.",
    fields: DEVICE_FIELDS,
  },
  {
    id: "mcp",
    title: "MCP Server",
    icon: "⚙️",
    kind: "object",
    path: "mcp",
    blurb: "How the MCP server is exposed to the AI client.",
    fields: [
      {
        key: "transport",
        label: "Transport",
        type: "select",
        options: ["stdio", "sse", "streamable-http"],
      },
      { key: "host", label: "Bind host", type: "text", placeholder: "0.0.0.0" },
      { key: "port", label: "Bind port", type: "number", placeholder: "8000" },
      {
        key: "appViews",
        label: "MCP App Views",
        type: "bool",
        help: "Expose rich App-view metadata to compatible clients.",
      },
      {
        key: "capabilityGating",
        label: "Capability gating",
        type: "select",
        options: ["off", "annotate", "filter"],
        help: "How tools a device cannot run are surfaced: annotate marks them, filter hides them (single-device only). The call-time guard applies either way.",
      },
      {
        key: "toolPageSize",
        label: "Tool page size",
        type: "number",
        advanced: true,
        help: "0 = no paging.",
      },
      {
        key: "allowedHosts",
        label: "Allowed hosts",
        type: "text",
        advanced: true,
        help: "Comma-separated.",
      },
      { key: "allowedOrigins", label: "Allowed origins", type: "text", advanced: true },
      { key: "corsOrigins", label: "CORS origins", type: "text", advanced: true },
    ],
  },
  {
    id: "dashboard",
    title: "Observability Dashboard",
    icon: "📊",
    kind: "object",
    path: "dashboard",
    enable: { key: "enabled", label: "Dashboard" },
    blurb: "This web dashboard — records every tool call and serves the live UI.",
    fields: [
      { key: "host", label: "Bind host", type: "text", placeholder: "0.0.0.0" },
      { key: "port", label: "Bind port", type: "number", placeholder: "9090" },
      {
        key: "token",
        label: "Access token",
        type: "password",
        secret: true,
        help: "Require this bearer token to view the dashboard.",
      },
      { key: "captureBody", label: "Capture tool input/output", type: "bool" },
      { key: "redactInput", label: "Redact input bodies", type: "bool" },
      { key: "dbPath", label: "Database path", type: "text", advanced: true },
      { key: "maxEvents", label: "Max events kept", type: "number", advanced: true },
      { key: "maxBodyBytes", label: "Max body bytes", type: "number", advanced: true },
    ],
  },
  {
    id: "ssh",
    title: "SSH Connection Pool",
    icon: "🔌",
    kind: "object",
    path: "ssh",
    enable: { key: "keepAlive", label: "Keep-alive pooling" },
    blurb: "Reuse SSH connections across tool calls for lower latency.",
    fields: [
      {
        key: "keepAliveInterval",
        label: "Keep-alive interval (ms)",
        type: "number",
        placeholder: "10000",
      },
      { key: "idleTimeout", label: "Idle timeout (ms)", type: "number", placeholder: "30000" },
    ],
  },
  {
    id: "s3",
    title: "S3 Backups",
    icon: "☁️",
    kind: "object",
    path: "s3",
    enable: { presence: true, label: "S3 backups" },
    blurb: "Ship config backups to an S3-compatible bucket.",
    fields: [
      { key: "bucket", label: "Bucket", type: "text" },
      { key: "region", label: "Region", type: "text" },
      { key: "endpoint", label: "Endpoint", type: "text", placeholder: "https://s3.example.com" },
      { key: "accessKeyId", label: "Access key ID", type: "password", secret: true },
      { key: "secretAccessKey", label: "Secret access key", type: "password", secret: true },
      { key: "prefix", label: "Key prefix", type: "text" },
      {
        key: "sessionToken",
        label: "Session token",
        type: "password",
        secret: true,
        advanced: true,
      },
      {
        key: "presignExpiresIn",
        label: "Presign expiry (s)",
        type: "number",
        advanced: true,
        placeholder: "3600",
      },
    ],
  },
  {
    id: "memory",
    title: "Knowledge Memory",
    icon: "🧠",
    kind: "object",
    path: "memory",
    enable: { key: "enabled", label: "Memory" },
    blurb: "Persistent knowledge graph the AI can read and write.",
    fields: [{ key: "dbPath", label: "Database path", type: "text" }],
  },
  {
    id: "alerts",
    title: "Alerts",
    icon: "🔔",
    kind: "object",
    path: "alerts",
    enable: { presence: true, label: "Alerting" },
    blurb: "Where alerts are delivered. Rules themselves are managed in the Alerts view.",
    fields: [
      {
        key: "enabled",
        label: "Deliver alerts",
        type: "bool",
        help: "Off keeps the rules but sends nothing.",
      },
      { key: "channels.slack.url", label: "Slack webhook URL", type: "text" },
      { key: "channels.discord.url", label: "Discord webhook URL", type: "text" },
      { key: "channels.ntfy.url", label: "ntfy topic URL", type: "text" },
      { key: "channels.ntfy.token", label: "ntfy token", type: "password", secret: true },
      { key: "channels.webhook.url", label: "Generic webhook URL", type: "text" },
      {
        key: "channels.webhook.method",
        label: "Webhook method",
        type: "text",
        advanced: true,
        placeholder: "POST",
      },
      {
        key: "maxHistory",
        label: "History kept (records)",
        type: "number",
        advanced: true,
        placeholder: "5000",
      },
    ],
  },
  {
    id: "attacks",
    title: "Attack Detection",
    icon: "🛡️",
    kind: "object",
    path: "attacks",
    enable: { key: "enabled", label: "Attack detection" },
    blurb: "Sweep the fleet for attacks. Detect-only until you switch the mode.",
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: ["detect", "respond"],
        help: "detect records and alerts only; respond also applies timed blocks.",
      },
      {
        key: "minConfidence",
        label: "Min confidence to respond",
        type: "select",
        options: ["medium", "high", "confirmed"],
      },
      { key: "pollSeconds", label: "Sweep interval (s)", type: "number", placeholder: "120" },
      {
        key: "windowMinutes",
        label: "Look-back window (min)",
        type: "number",
        placeholder: "10",
        help: "Must exceed the sweep interval so consecutive windows overlap.",
      },
      {
        key: "blockTimeout",
        label: "Block duration",
        type: "text",
        placeholder: "1h",
        help: "A wrong block must expire on its own.",
      },
      { key: "maxBlocksPerHour", label: "Max blocks / hour", type: "number", placeholder: "6" },
      {
        key: "neverBlock",
        label: "Never block",
        type: "list",
        placeholder: "10.0.0.0/8, 192.168.88.10",
        help: "Addresses and CIDRs that may never be blocked, whatever the evidence.",
      },
      {
        key: "autoRespondTo",
        label: "Auto-respond to",
        type: "list",
        placeholder: "brute-force, credential-spray",
        help: "Detectors permitted to trigger an automatic response.",
      },
      { key: "concurrency", label: "Devices swept at once", type: "number", advanced: true },
      {
        key: "learningDays",
        label: "Baseline learning (days)",
        type: "number",
        advanced: true,
        help: "Days of successful logins before “a new admin source” means anything.",
      },
      {
        key: "readScanList",
        label: "Read on-device scan list",
        type: "bool",
        advanced: true,
      },
      { key: "retainDays", label: "Incident retention (days)", type: "number", advanced: true },
    ],
  },
  {
    id: "schedules",
    title: "Scheduled Audits",
    icon: "⏱️",
    kind: "object",
    path: "schedules",
    enable: { key: "enabled", label: "Scheduled audits" },
    blurb:
      "Recurring read-only audits, diffed run over run. Jobs are managed in the Schedules view.",
    fields: [
      { key: "concurrency", label: "Jobs at once", type: "number", placeholder: "4" },
      {
        key: "timeoutMs",
        label: "Job timeout (ms)",
        type: "number",
        placeholder: "600000",
        help: "Stops one wedged device from holding a job open into the next occurrence.",
      },
      { key: "tickSeconds", label: "Scheduler tick (s)", type: "number", advanced: true },
      {
        key: "jitterMs",
        label: "Start jitter (ms)",
        type: "number",
        advanced: true,
        help: "Spreads jobs that share an occurrence.",
      },
      { key: "retainDays", label: "Run history (days)", type: "number", advanced: true },
    ],
  },
  {
    id: "flows",
    title: "Traffic Flows",
    icon: "🌊",
    kind: "object",
    path: "flows",
    enable: { key: "enabled", label: "Flow collector" },
    blurb: "NetFlow/IPFIX collector. Binds a UDP port only while enabled.",
    fields: [
      {
        key: "port",
        label: "Collector UDP port",
        type: "number",
        placeholder: "2055",
        help: "The port devices export to (RouterOS defaults to 2055).",
      },
      {
        key: "db",
        label: "Database path",
        type: "text",
        help: "`:memory:` for an ephemeral store.",
      },
      { key: "retentionHours", label: "Raw retention (hours)", type: "number", placeholder: "24" },
      {
        key: "rollupDays",
        label: "Rollup retention (days)",
        type: "number",
        advanced: true,
        placeholder: "30",
      },
      {
        key: "maxRows",
        label: "Max raw rows",
        type: "number",
        advanced: true,
        help: "Hard cap; the oldest rows are evicted first (and logged).",
      },
    ],
  },
  {
    id: "policy",
    title: "Policy as Code",
    icon: "📜",
    kind: "object",
    path: "policy",
    blurb: "Where compliance rule files are loaded from.",
    fields: [
      {
        key: "paths",
        label: "Rule file paths",
        type: "list",
        placeholder: "./mikrotik-policies/*.yaml",
        help: "A bare directory loads every .yaml/.yml/.json in it.",
      },
      { key: "includeStarterPack", label: "Include starter pack", type: "bool" },
    ],
  },
  {
    id: "modules",
    title: "Tool Modules",
    icon: "🧩",
    kind: "modules",
    blurb: "Curate which tool modules are exposed to the AI client.",
    fields: [],
  },
  {
    id: "general",
    title: "General",
    icon: "🎛️",
    kind: "object",
    // Root-level fields (no `path`).
    blurb: "Server-wide options.",
    fields: [
      {
        key: "readOnly",
        label: "Read-only mode",
        type: "bool",
        help: "Block all write/destructive tools.",
      },
      { key: "disableUpdateCheck", label: "Disable update check", type: "bool" },
      { key: "backupDir", label: "Backup directory", type: "text", advanced: true },
    ],
  },
];
