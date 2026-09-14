/**
 * Assembles the MCP server: a fresh `McpServer` with every tool and prompt
 * registered. Transports (stdio / streamable-http) wrap the result.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { SendLog } from "./core/context";
import { registerTools } from "./core/registry";
import { registerUiResources } from "./core/ui-resources";
import { loadFileCacheSync, updateSummaryLine } from "./core/update-check";
import { listDevices, deviceDirectory, deviceLabels, getConfig } from "./core/runtime";
import { registerPrompts } from "./prompts";
import { selectToolModules } from "./tools";
import { TRANSACTION_TOOL_NAMES, TRANSACTION_WORKFLOW } from "./txn/guidance";
import {
  VERSION,
  SERVER_NAME,
  SERVER_DESCRIPTION,
  SERVER_TITLE,
  WEBSITE_URL,
  LOGO_URL,
} from "./version";

const INSTRUCTIONS = `MikroTik RouterOS management over SSH.

This server exposes RouterOS configuration as MCP tools grouped by subsystem:
interfaces, IP addressing, DHCP, DNS, firewall (filter + NAT), routing, VLANs,
wireless, WireGuard, queues/QoS, users, logs, backups, PoE, system, network
tools, bridges, address-lists, scheduler/scripts and certificates.

Tool discovery — MANDATORY workflow:
  This server has several hundred dedicated tools, but the host only surfaces a
  small subset at a time. You MUST follow this order:
    1. ALWAYS call \`find_tools\` FIRST — describe what you want to do and it
       searches the full catalog for the best-matching dedicated tool.
    2. (Optional) Call \`describe_tool\` to get the exact parameter schema.
    3. Call the tool directly if it is listed, or via \`invoke_tool\` if not.
    4. ONLY if \`find_tools\` returned ZERO results, fall back to
       \`run_routeros_command\` as a last resort.
  Dedicated tools have schema validation, structured output, and correct risk
  annotations — \`run_routeros_command\` has none of these. Always prefer the
  dedicated tool path.

Safety model — tools are annotated by risk:
  • readOnlyHint     → inspection only, no changes
  • destructiveHint  → removes or replaces configuration
Before a single-device batch of risky changes, consider enable_safe_mode: RouterOS then holds
every change in memory and auto-reverts if the session drops, so a mistake that
locks you out is undone automatically. commit_safe_mode persists; rollback
discards. Prefer specific filters on list_* tools to keep output small.

Change workflow — ALWAYS take a restore point before a plan. Before calling
plan_changes or apply_plan (or any batch of write/destructive tools), first call
capture_config_snapshot to record the current configuration. These snapshots are
captured with \`/export\` (a read-only print — it does NOT create a file on the
router) and persisted to the MCP host's local database (~/.mikrotik-mcp/
snapshots.db), so they add ZERO load to the MikroTik device's disk and leave
nothing to clean up on the device. They survive device reboots/resets. After a
change, use diff_config_snapshots (from=latest, to=live) to confirm exactly what
changed, and if something is wrong, get_config_snapshot returns the prior
\`/export\` text to restore from. Do NOT use create_backup/create_export for this
pre-change restore point — those write files to the device's flash; prefer the
local snapshot to keep the device's disk clean.

Local backup before high-risk edits — before CREATING A VPN TUNNEL, or before you
start CHANGING ANY MANGLE OR FIREWALL FILTER RULE, ASK the user whether to create a
restorable local backup first ("Create a local backup before this change?"). On
yes, call create_local_backup for each device you will change (a host-side .rsc in
the MCP vault — NOT on the device's flash — that you can restore_local_backup if the
change cuts you off). These edits (tunnel interfaces/peers/routes, routing marks,
filter rules) are the ones most likely to lock you out, which is why the restorable
copy is worth it on top of the diff snapshot above. Skip the backup ONLY when the
mangle/filter edit is minor and non-critical and the user declines — do not silently
skip it, and never skip it for tunnel creation.`;

const MULTI_DEVICE_INSTRUCTIONS = `

Multiple devices are configured: {{names}} (default: {{default}}). Every tool
accepts an optional "device" argument to choose which router it runs on; omit it
to use the default. Use list_mikrotik_devices to see them. Resolve every named
participant explicitly; never substitute the default for an unknown device.
For related multi-router writes, choose the coordinated execution workflow before
changing the first router. Read-only checks still target each device separately.`;

// Persistent knowledge-graph memory usage protocol. Injected into the server
// instructions ONLY when memory is enabled. Without this the model never learns
// the graph exists — the memory_* tools would sit unused and "history is lost"
// between sessions even though everything persists in SQLite. This is the one
// channel (the MCP `instructions` field) the host feeds to the model at connect,
// so the recall/record loop must live here, not buried in a tool description.
const MEMORY_INSTRUCTIONS = `

Persistent memory — you have a knowledge graph that survives across sessions
(entities, observations, relations in a local SQLite database). USE IT on every
task so context is never lost between conversations:
  1. AT THE START of a task, recall what you already know before touching the
     device: call \`memory_search_nodes\` for the device/subject at hand (or
     \`memory_read_graph\` for the whole picture on a fresh device). Apply what you
     find — do not re-discover facts you already recorded.
  2. WHILE WORKING, when you learn a durable fact about the network, a device, a
     user, or a config pattern (RouterOS version, port layout, VLAN scheme, WAN
     uplink, owner, recurring fix), record it: \`memory_create_entities\` for new
     subjects, \`memory_add_observations\` for facts about existing ones, and
     \`memory_create_relations\` to link them (e.g. router --provides_dhcp_for-->
     subnet). Every device you touch is auto-added as an entity, so attach
     observations to it by name.
  3. Prefer specific, reusable facts over transient state. Skip one-off command
     output; record what will still be true next session.`;

export interface CreatedServer {
  server: McpServer;
  toolCount: number;
  promptCount: number;
  /** Number of MCP App `ui://` views registered as resources. */
  uiViewCount: number;
  /** True when only read-only tools were registered. */
  readOnly: boolean;
}

export function createServer(opts: { sendLog?: SendLog } = {}): CreatedServer {
  process.title = `Mikrotik MCP Server v${VERSION}`;

  const { names, default: defaultDevice } = listDevices();
  const readOnly = getConfig().readOnly;
  const toolModules = selectToolModules(getConfig().tools);
  const availableTools = new Set(toolModules.flatMap((mod) => mod.map((tool) => tool.name)));
  let instructions =
    names.length > 1
      ? INSTRUCTIONS +
        MULTI_DEVICE_INSTRUCTIONS.replace("{{names}}", names.join(", ")).replace(
          "{{default}}",
          defaultDevice,
        )
      : INSTRUCTIONS;

  // Promote only a usable workflow; do not direct a read-only or curated session
  // toward write tools it does not expose. This performs no device I/O.
  const sshParticipants = names.filter((name) => !getConfig().devices[name]?.mac);
  if (
    !readOnly &&
    sshParticipants.length > 1 &&
    TRANSACTION_TOOL_NAMES.every((name) => availableTools.has(name))
  ) {
    instructions += `\n\n${TRANSACTION_WORKFLOW}`;
  }

  // Teach the model the recall/record loop only when the knowledge graph is live;
  // otherwise the memory_* tools are inert and the instruction would be a lie.
  if (getConfig().memory.enabled) instructions += MEMORY_INSTRUCTIONS;

  // If a previous run cached an update check showing a newer version, seed
  // the LLM's instructions so it naturally knows about the update. This is
  // a synchronous file read — fast and non-blocking.
  if (!getConfig().disableUpdateCheck) {
    const cached = loadFileCacheSync();
    if (cached) {
      const note = updateSummaryLine(cached);
      if (note) instructions += `\n\n${note}`;
    }
  }

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: VERSION,
      websiteUrl: WEBSITE_URL,
      title: SERVER_TITLE,
      description: SERVER_DESCRIPTION,
      icons: [
        {
          src: LOGO_URL,
          mimeType: "image/svg+xml",
          sizes: ["any"],
          theme: "light",
        },
      ],
    },
    {
      capabilities: {},
      instructions,
    },
  );

  // Make the advertised `logging` capability real: forward tool-handler
  // diagnostics (ctx.info / ctx.error) to the connected client as MCP log
  // notifications. Best-effort and fire-and-forget — the SDK no-ops when the
  // client has filtered the level out, and any failure is swallowed so logging
  // can never break a tool call. A caller may inject its own `sendLog` (e.g.
  // per-session HTTP transports or tests).
  const sendLog: SendLog =
    opts.sendLog ??
    ((level, message) => {
      try {
        void server.server.sendLoggingMessage({ level, data: message }).catch(() => {});
      } catch {
        /* logging is best-effort; never propagate into the tool call */
      }
    });

  // Curate the tool surface to the configured scopes (default: the full catalog)
  // so the client's tool-discovery search reliably surfaces every matching tool
  // on a several-hundred-tool server.
  const toolCount = registerTools(server, toolModules, {
    sendLog,
    deviceNames: names,
    // Friendly labels (descriptions) are accepted as device aliases too, so the
    // AI can target e.g. "Ali Home" as well as the config key "home".
    deviceAliases: deviceLabels(),
    // A key → label → target directory so the `device` selector can list each
    // router unambiguously and the model won't confuse e.g. "Ali Home" with "home".
    deviceDirectory: deviceDirectory(),
    // When false, no tool carries `_meta.ui` — read tools stay plain so hosts that
    // hide App-metadata tools still surface them (the recurring "reads don't load").
    appViews: getConfig().mcp.appViews,
    readOnly,
  });
  const promptCount = registerPrompts(server, {
    deviceNames: names,
    deviceAliases: deviceLabels(),
    deviceDirectory: deviceDirectory(),
  });
  // MCP App views (`ui://…`) — interactive dashboards rendered inline by hosts
  // that support the Apps extension (Claude, ChatGPT). Plain clients ignore them.
  const uiViewCount = registerUiResources(server);
  // Optionally paginate `tools/list` so a very large catalog (several hundred
  // tools) ships in client-friendly pages WITHOUT disabling any tool.
  installToolPagination(server, getConfig().mcp.toolPageSize);
  return { server, toolCount, promptCount, uiViewCount, readOnly };
}

/**
 * Deliver the full tool catalog in cursor-paginated pages. A no-op when
 * `pageSize <= 0` (the entire catalog ships in one `tools/list` response — the
 * default, unchanged behaviour). When set, EVERY tool is still served — just
 * split across pages so clients that choke on one huge response can load them
 * all. The SDK's own handler computes the normalised list once (the tool set is
 * fixed after startup); we cache it and slice per cursor.
 */
function installToolPagination(server: McpServer, pageSize: number): void {
  if (pageSize <= 0) return;
  const low = server.server as unknown as {
    _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<ListToolsResult>>;
  };
  const sdkHandler = low._requestHandlers?.get("tools/list");
  if (typeof sdkHandler !== "function") return;

  let cache: ListToolsResult["tools"] | null = null;
  server.server.setRequestHandler(
    ListToolsRequestSchema,
    async (request, extra): Promise<ListToolsResult> => {
      // The full, schema-normalised catalog is fixed after startup — compute it
      // once via the SDK's own handler, then serve cursor-delimited slices.
      if (!cache) cache = (await sdkHandler(request, extra)).tools ?? [];
      const total = cache.length;
      const cursor = request.params?.cursor;
      let start = 0;
      if (typeof cursor === "string") {
        const n = Number.parseInt(cursor, 10);
        start = Number.isFinite(n) && n > 0 ? Math.min(n, total) : 0;
      }
      const tools = cache.slice(start, start + pageSize);
      const end = start + tools.length;
      return end < total ? { tools, nextCursor: String(end) } : { tools };
    },
  );
}
