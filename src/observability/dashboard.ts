/**
 * Real-time observability dashboard server.
 *
 * Runs on its own `Bun.serve` instance (independent of the MCP transport) and
 * exposes:
 *   • `GET /`                 the single-page dashboard (built UI, inlined)
 *   • `GET /api/events`       filtered, paginated event list
 *   • `DELETE /api/events`    delete selected events (`{ids:[...]}`) or all (`{all:true}`)
 *   • `GET /api/event/:id`    one event with full (redacted) bodies
 *   • `GET /api/stats`        computed analytics over a time window
 *   • `GET /api/topology`     live Layer-2 map (devices + discovered neighbours)
 *   • `*   /api/capture/*`    live packet capture: status, packets, pcap, start/stop
 *   • `GET /api/meta`         facets (tools/devices) + counts for filters
 *   • `POST /api/reload`      reload config live (`{}`) or restart the process (`{hard:true}`)
 *   • `GET /api/catalog`      every module (+ tools + risk) and prompt (+ args)
 *   • `GET /api/releases`     every published release + relation to running version
 *   • `POST /api/upgrade`     install a version (`{version}`) globally + self-restart
 *   • `GET /api/stream`       WebSocket: live push of every new event
 *   • `GET /health`           liveness probe
 *
 * It reads from the same SQLite store the recorder writes to, and subscribes to
 * the recorder for the live WebSocket feed. An optional bearer token gates every
 * route (page, API and WebSocket via `?token=`).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "bun";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import {
  DEFAULT_SNAPSHOT_DB,
  DeviceConfigSchema,
  MikrotikConfigSchema,
  ToolFilterSchema,
  getConfigSource,
  loadConfig,
} from "../config";
import type { DashboardConfig, MikrotikConfig } from "../config";
import { moduleCatalog } from "../tools";
import { applyModuleToggle, moduleSurface } from "./modules";
import { atomicWrite, mergeSecrets, serializeConfig } from "../config-write";
import { buildChangePlan, renderPlan, splitCommands } from "../core/change-plan";
import { diffLines } from "../core/diff";
import { getS3Client, isS3Configured, presignExpiresIn, s3Target } from "../core/s3";
import { createLocalBackup } from "../backups/create";
import { restoreLocalBackup } from "../backups/restore";
import {
  backupDir,
  deleteBackup,
  listBackups,
  readBackup,
  renameBackup,
  writeBackup,
} from "../backups/vault";
import { createContext } from "../core/context";
import {
  allowDevice,
  blockDevice,
  devicesView,
  fetchDevices,
  makeDeviceStatic,
  removeDeviceLease,
  sampleAllTraffic,
  sampleDeviceTraffic,
  setDeviceIp,
  setDeviceLabel,
  setDeviceLimits,
} from "../tools/connected-devices";
import {
  AAA_ENTITIES,
  addAaaEntity,
  getRadiusIncoming,
  getUmSettings,
  listAaaEntity,
  removeAaaEntity,
  resetRadiusCounters,
  setRadiusIncoming,
  setUmSettings,
  toggleAaaEntity,
  updateAaaEntity,
} from "../tools/aaa-data";
import { normalizeExport } from "../snapshots/format";
import { openSnapshotStore } from "../snapshots/store";
import type { SnapshotStore } from "../snapshots/store";
import { getConfig, resolveDeviceName, setConfig } from "../core/runtime";
import { fetchAllReleases, fetchLatestRelease } from "../core/update-check";
import { logger } from "../logger";
import { UI_DIST_DIR } from "../paths";
import { createConfigAdmin, validateConfig } from "./config-admin";
import type { ConfigAdmin } from "./config-admin";
import {
  AUTO_RETENTION,
  deleteVersion,
  historyBytes,
  isEmpty as historyIsEmpty,
  listVersions,
  readVersion,
  recordVersion,
} from "./config-history";
import { redact, riskOf } from "./event";
import type { Risk, ToolEvent } from "./event";
import { listPrompts } from "../prompts";
import {
  buildChannelPlanCommands,
  buildFtCommands,
  buildHaCommands,
  buildLoadBalanceCommands,
  buildSteerCommands,
  capsmanOverview,
  haGuidance,
  loadBalancePlan,
  reportWeakClients,
  runCapsmanAudit,
  steerAlreadyPresent,
} from "../core/capsman";
import { captureSnapshot } from "../snapshots/capture";
import { applyWritesSafely } from "../utils/safe-mode-apply";
import { fetchCapsmanState } from "../utils/wifi-query";
import {
  getDeviceHistory,
  getDeviceNeighbors,
  getDeviceStatus,
  probeDevice,
  startHealthChecks,
  stopHealthChecks,
} from "./health";
import { getDeviceGeo, startGeoLookups, stopGeoLookups } from "./geo";
import { flagSvg } from "./flags";
import { configureRecorder, getEventStore, subscribe, subscriberCount } from "./recorder";
import { subscribeTraffic } from "./traffic-hub";
import { openSqliteStore } from "./store";
import type { EventFilter, EventStore } from "./store";
import { openCapsmanStore } from "./capsman-store";
import type { CapsmanStore } from "./capsman-store";
import { startCapsmanSampler, stopCapsmanSampler } from "./capsman-sampler";
import { openUsageStore } from "./usage-store";
import type { UsageStore } from "./usage-store";
import {
  getUsageSamplerInterval,
  setUsageSamplerInterval,
  startUsageSampler,
  stopUsageSampler,
} from "./usage-sampler";
import { computeStats } from "./stats";
import { buildTopology } from "./topology";
import { capture, DEFAULT_TZSP_PORT } from "./capture";
import { closeDevice, isPoolEnabled, poolStatus } from "../core/connection-pool";
import { serializeCapabilities } from "../core/capability";
import {
  getCapabilities,
  invalidateCapabilities,
  peekCapabilities,
} from "../core/capability-cache";
import { isMacTelnetDevice } from "../core/transport";
import { VERSION } from "../version";
import { driftRoutes } from "./drift-routes";
import { txnRoutes } from "./txn-routes";
import { flowRoutes } from "./flow-routes";
import { subscribeTxn } from "./txn-hub";
import { alertRoutes } from "./alert-routes";
import { clientError, logError } from "./http-error";
import { closeMemoryStore, memoryRoutes } from "./memory-routes";

const SERVER_TAG = "mikrotik-mcp";

// ── GitHub release check (shared via ../core/update-check) ───────────────────

interface SocketData {
  unsub?: () => void;
  /** Set when this socket is a traffic stream (`?traffic=<device>`), else a tool feed. */
  traffic?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Restart the whole server WITHOUT needing an external supervisor: spawn a
 * DETACHED copy of the exact command that started us — with a startup delay so
 * the fresh process binds our ports only after we've exited — then exit. Returns
 * whether the relaunch spawned. (This is process management, not device I/O, so
 * the "device I/O is SSH-only" rule doesn't apply.) Caveat: under an MCP host that
 * owns our stdio, a true restart is up to the host; this targets HTTP/manual runs.
 */
function restartProcess(): boolean {
  let ok = false;
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, MIKROTIK_RESTART_DELAY_MS: "1500" },
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    ok = true;
    logger.warn(
      "Dashboard requested a restart — relaunched a fresh server process; this one is exiting.",
    );
  } catch (e) {
    logger.error(`Restart relaunch failed: ${logError(e)}. Exiting anyway.`);
  }
  // Flush the HTTP response first, then exit so the child (after its startup
  // delay) can bind the same ports.
  setTimeout(() => process.exit(0), 500);
  return ok;
}

/**
 * Install a package spec globally with Bun (`bun i -g <spec>`) and return the
 * combined output. Spawned with an args array (no shell), so the caller-validated
 * version can't inject anything. Bounded at 180s. Process management, not device
 * I/O — the SSH-only rule doesn't apply.
 */
function runUpgrade(spec: string): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(process.execPath, ["i", "-g", spec], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, log: `${out}\n(timed out after 180s)` });
    }, 180_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, log: `${out}\nspawn error: ${String(e)}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, log: out.trim() || `(exit ${code})` });
    });
  });
}

/** The built dashboard HTML, or a helpful placeholder if it isn't built yet. */
function dashboardHtml(): string {
  try {
    return readFileSync(join(UI_DIST_DIR, "observability.html"), "utf8");
  } catch {
    return `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:24px;background:#0b0d10;color:#e8eaed">
<h2>MikroTik MCP — Observability Dashboard</h2>
<p style="color:#9aa3af">The dashboard UI hasn't been built yet. Run <code style="color:#7c9cff">bun run build:ui</code> and restart.</p>
<p style="color:#9aa3af">The API is live: try <a style="color:#7c9cff" href="/api/stats">/api/stats</a> or <a style="color:#7c9cff" href="/api/events">/api/events</a>.</p>`;
  }
}

/** Parse the event filter from the query string. */
function filterFromQuery(url: URL): EventFilter {
  const q = url.searchParams;
  const num = (k: string): number | undefined => {
    const v = q.get(k);
    return v == null || v === "" ? undefined : Number(v);
  };
  const status = q.get("status");
  return {
    limit: num("limit"),
    offset: num("offset"),
    tool: q.get("tool") || undefined,
    risk: (q.get("risk") as Risk) || undefined,
    device: q.get("device") || undefined,
    status: status === "ok" || status === "error" ? status : undefined,
    q: q.get("q") || undefined,
    since: num("since"),
    until: num("until"),
  };
}

/** Derive filter facets (tool/device lists) from a bounded recent window. */
function facets(store: EventStore): { tools: string[]; devices: string[] } {
  const recent = store.query({ limit: 5000 });
  const tools = new Set<string>();
  const devices = new Set<string>();
  for (const e of recent) {
    tools.add(e.tool);
    if (e.device) devices.add(e.device);
  }
  return {
    tools: [...tools].sort(),
    devices: [...devices].sort(),
  };
}

/** Per-device activity rolled up from recent events. */
function deviceActivity(
  store: EventStore,
): Map<string, { calls: number; errors: number; lastSeen: number; avgMs: number }> {
  const recent = store.query({ limit: 5000 });
  const map = new Map<string, { calls: number; errors: number; lastSeen: number; sumMs: number }>();
  for (const e of recent) {
    if (!e.device) continue;
    const a = map.get(e.device) ?? {
      calls: 0,
      errors: 0,
      lastSeen: 0,
      sumMs: 0,
    };
    a.calls++;
    if (e.isError) a.errors++;
    a.lastSeen = Math.max(a.lastSeen, e.ts);
    a.sumMs += e.durationMs;
    map.set(e.device, a);
  }
  const out = new Map<string, { calls: number; errors: number; lastSeen: number; avgMs: number }>();
  for (const [k, a] of map) {
    out.set(k, {
      calls: a.calls,
      errors: a.errors,
      lastSeen: a.lastSeen,
      avgMs: a.sumMs / a.calls,
    });
  }
  return out;
}

/** Configured devices + connectivity status + recent activity (no secrets). */
function devicesPayload(store: EventStore): unknown {
  const cfg = getConfig();
  const activity = deviceActivity(store);
  const poolEnabled = isPoolEnabled();
  const poolMap = new Map(poolStatus().map((p) => [p.device, p]));
  const devices = Object.entries(cfg.devices).map(([name, dc]) => {
    const isMac = isMacTelnetDevice(dc);
    const ps = poolMap.get(name);
    return {
      name,
      host: dc.host,
      port: dc.port,
      // A `mac` device is reached over Layer-2 MAC-Telnet, not SSH — surface that
      // so the dashboard shows the MAC instead of the unused default host:port.
      mac: dc.mac,
      // The CONFIGURED transport. A REST device still falls back to SSH per
      // command, so this is what it will attempt, not a guarantee — the Live
      // Feed's per-call `deviceTransport` is the record of what actually ran.
      transport: dc.mac ? "mac-telnet" : dc.api ? "rest" : "ssh",
      restPort: dc.api ? (dc.apiPort ?? 443) : undefined,
      address: dc.mac ? dc.mac : `${dc.host}:${dc.port}`,
      username: dc.username,
      authMode: dc.mac
        ? "mac-telnet"
        : dc.keyFilename || dc.privateKey
          ? "key"
          : dc.password
            ? "password"
            : "none",
      isDefault: name === cfg.defaultDevice,
      description: dc.description,
      disabled: !!dc.disabled,
      // SSH jump host (ProxyJump): the bastion this device is reached THROUGH —
      // either another configured device (`jumpVia`) or an inline host (no secrets,
      // just host:port). Surfaced so the dashboard can draw the tunnel.
      jumpVia: dc.jumpVia,
      jumpHost: dc.jumpHost ? { host: dc.jumpHost.host, port: dc.jumpHost.port } : undefined,
      status: getDeviceStatus(name),
      // ISO country (+ flag) geolocated from the device's public IP, when it has
      // one. null for MAC-Telnet / private-IP / not-yet-resolved devices.
      geo: getDeviceGeo(name),
      history: getDeviceHistory(name),
      activity: activity.get(name) ?? {
        calls: 0,
        errors: 0,
        lastSeen: 0,
        avgMs: 0,
      },
      // SSH connection pool: null for MAC-Telnet devices or when pooling is off.
      pool:
        isMac || !poolEnabled
          ? null
          : {
              device: name,
              pooled: !!ps,
              inflight: ps?.inflight ?? 0,
              idle: ps?.idle ?? false,
              dead: ps?.dead ?? false,
            },
    };
  });
  return { server: SERVER_TAG, defaultDevice: cfg.defaultDevice, devices };
}

/** Live Layer-2 topology built from each device's discovered neighbour cache. */
function topologyPayload(): unknown {
  const cfg = getConfig();
  const devices = Object.entries(cfg.devices).map(([name, config]) => ({
    name,
    config,
    status: getDeviceStatus(name),
  }));
  const neighborsByDevice: Record<string, ReturnType<typeof getDeviceNeighbors>> = {};
  for (const { name } of devices) neighborsByDevice[name] = getDeviceNeighbors(name);
  return {
    server: SERVER_TAG,
    defaultDevice: cfg.defaultDevice,
    generatedAt: Date.now(),
    ...buildTopology({ devices, neighborsByDevice }),
  };
}

/**
 * Effective runtime configuration, with every secret redacted. Returns the FULL
 * config (all top-level sections) so an editor can round-trip it without
 * clobbering the omitted blocks: `POST /api/config` validates the whole schema,
 * so any section missing here would be reset to its Zod default on save.
 */
function configPayload(): unknown {
  const cfg = getConfig();
  return redact({
    devices: cfg.devices,
    defaultDevice: cfg.defaultDevice,
    mcp: cfg.mcp,
    s3: cfg.s3,
    dashboard: cfg.dashboard,
    ssh: cfg.ssh,
    readOnly: cfg.readOnly,
    tools: cfg.tools,
    memory: cfg.memory,
    backupDir: cfg.backupDir,
    disableUpdateCheck: cfg.disableUpdateCheck,
  });
}

/**
 * A Server-Sent Events response that streams every new tool call. Built on a
 * Web-standard `ReadableStream` (Bun serves it natively): we subscribe to the
 * recorder on `start`, push `data:` frames per event with periodic keep-alive
 * comments, and unsubscribe on `cancel` when the client disconnects.
 */
function sseResponse(transportLabel: string): Response {
  let unsub: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (text: string): void => {
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          /* stream closed */
        }
      };
      send(`event: hello\ndata: ${JSON.stringify({ transport: transportLabel })}\n\n`);
      unsub = subscribe((e: ToolEvent) => send(`event: tool\ndata: ${JSON.stringify(e)}\n\n`));
      ping = setInterval(() => send(`: ping\n\n`), 15_000);
    },
    cancel() {
      unsub?.();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

/**
 * SSE variant of the traffic channel — the fallback when a client can't open a
 * WebSocket. Subscribes to the per-device traffic hub and emits one `traffic`
 * event per sample, with keep-alive pings.
 */
function sseTrafficResponse(device: string, transportLabel: string): Response {
  let unsub: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (text: string): void => {
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          /* stream closed */
        }
      };
      send(`event: hello\ndata: ${JSON.stringify({ transport: transportLabel })}\n\n`);
      unsub = subscribeTraffic(device, (sample) => {
        send(`event: traffic\ndata: ${JSON.stringify(sample)}\n\n`);
      });
      ping = setInterval(() => send(`: ping\n\n`), 15_000);
    },
    cancel() {
      unsub?.();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

// ── Config Studio API ────────────────────────────────────────────────────────
/** Parse a JSON request body, or `undefined` on empty/invalid input. */
async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** The live JSON Schema for the config (computed from the Zod schema, never stale). */
function configSchemaJson(): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "MikrotikConfig",
    ...z.toJSONSchema(MikrotikConfigSchema, { target: "draft-2020-12" }),
  };
}

/** Clamp a requested rollback window to a sane range (default 60s, max 10min). */
function clampRollback(v: unknown): number {
  const n = typeof v === "number" ? v : 60_000;
  return Math.max(0, Math.min(600_000, n));
}

function issues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
}

/**
 * Handle every Config Studio route. Returns a `Response` when it owns the path,
 * or `null` to let the main router continue. All writes go through `admin`, which
 * backs up + arms an auto-rollback; secrets are merged back in from the live
 * config before validation so the browser never has to hold them.
 */
async function configRoutes(req: Request, url: URL, admin: ConfigAdmin): Promise<Response | null> {
  const p = url.pathname;

  if (p === "/api/config-schema" && req.method === "GET") {
    return json(configSchemaJson());
  }

  if (p === "/api/config/validate" && req.method === "POST") {
    const merged = mergeSecrets(await readJson(req), getConfig());
    return json(validateConfig(merged));
  }

  if (p === "/api/config/test-device" && req.method === "POST") {
    const body = (await readJson(req)) as { name?: string; config?: unknown };
    const name = typeof body?.name === "string" ? body.name : "(unsaved)";
    const currentDc = (getConfig().devices as Record<string, unknown>)[name];
    const merged = mergeSecrets(body?.config, currentDc);
    const parsed = DeviceConfigSchema.safeParse(merged);
    if (!parsed.success) return json({ ok: false, errors: issues(parsed.error) }, 400);
    const status = await probeDevice(`config-test:${name}`, parsed.data);
    return json({ ok: true, status });
  }

  if (p === "/api/config/preview" && req.method === "POST") {
    const before = JSON.stringify(redact(getConfig()), null, 2);
    const after = JSON.stringify((await readJson(req)) ?? {}, null, 2);
    const d = diffLines(before, after, { fromLabel: "current", toLabel: "edited" });
    return json({ summary: d.summary, unified: d.unified });
  }

  if (p === "/api/config" && req.method === "POST") {
    const body = (await readJson(req)) as { config?: unknown; rollbackMs?: unknown };
    const merged = mergeSecrets(body?.config, getConfig());
    const v = validateConfig(merged);
    if (!v.ok || !v.value) return json({ ok: false, errors: v.errors }, 400);

    const prev = getConfig();
    const before = JSON.stringify(redact(prev), null, 2);
    const after = JSON.stringify(redact(v.value), null, 2);
    const diff = diffLines(before, after, { fromLabel: "current", toLabel: "saved" });
    // Adding/removing a device name needs an MCP client reconnect to surface in
    // the tool `device` enum — flag it so the UI can warn.
    const prevDevs = Object.keys(prev.devices);
    const nextDevs = Object.keys(v.value.devices);
    const devicesChanged =
      prevDevs.length !== nextDevs.length || prevDevs.some((d) => !nextDevs.includes(d));

    const res = admin.applyConfig(v.value, clampRollback(body?.rollbackMs));
    return json({ ok: true, ...res, devicesChanged, summary: diff.summary, unified: diff.unified });
  }

  if (p === "/api/config/keep" && req.method === "POST") {
    const body = (await readJson(req)) as { pendingId?: string };
    const kept = admin.keepConfig(String(body?.pendingId ?? ""));
    // A kept change is now permanent — snapshot it to the version timeline.
    if (kept) recordVersion(getConfig(), "auto", Date.now());
    return json({ kept });
  }

  if (p === "/api/config/rollback" && req.method === "POST") {
    const body = (await readJson(req)) as { pendingId?: string };
    const rolledBack = admin.rollback(String(body?.pendingId ?? ""));
    return json({ rolledBack, config: redact(getConfig()) });
  }

  // Reload the server. `hard:false` (default) re-reads the config from its source
  // (file/env) and applies it live — zero downtime, picks up externally-edited or
  // freshly-added devices immediately. `hard:true` exits the process so a
  // supervisor (systemd/docker/pm2/the MCP host) respawns it — a full restart that
  // also re-registers tools and reloads code.
  if (p === "/api/reload" && req.method === "POST") {
    const body = (await readJson(req)) as { hard?: unknown };
    if (body?.hard === true) {
      const relaunched = restartProcess();
      return json({
        ok: true,
        mode: "restart",
        note: relaunched
          ? "Restarting now — a fresh server process was launched and will bind the same port(s) in ~1.5s. Reconnect shortly."
          : "Could not self-relaunch; the process is exiting. It only comes back if a supervisor respawns it.",
      });
    }
    try {
      const cfg = loadConfig();
      setConfig(cfg);
      const devices = Object.keys(cfg.devices);
      logger.info(
        `Config reloaded from source — ${devices.length} device(s): ${devices.join(", ")}`,
      );
      return json({ ok: true, mode: "config", count: devices.length, devices });
    } catch (e) {
      // Full detail (stack, absolute paths) to stderr; only the sanitised
      // one-liner goes back over HTTP.
      logger.error(`Config reload failed: ${logError(e)}`);
      return json({ ok: false, error: clientError(e) }, 500);
    }
  }

  // ── Config version history (point-in-time snapshots) ───────────────────────
  if (p === "/api/config/history" && req.method === "GET") {
    const current = JSON.stringify(redact(getConfig()), null, 2);
    const versions = listVersions().map((v) => {
      let added = 0;
      let removed = 0;
      try {
        const vc = JSON.stringify(redact(readVersion(v.id).config), null, 2);
        const d = diffLines(vc, current);
        added = d.summary.added;
        removed = d.summary.removed;
      } catch {
        /* drift stays 0 for an unreadable version */
      }
      return { ...v, drift: { added, removed } };
    });
    return json({ versions, bytes: historyBytes(), retention: AUTO_RETENTION });
  }

  if (p === "/api/config/history/get" && req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    try {
      const v = readVersion(id);
      return json({
        ts: v.ts,
        kind: v.kind,
        label: v.label,
        config: JSON.stringify(redact(v.config), null, 2),
      });
    } catch {
      return json({ error: "not found" }, 404);
    }
  }

  if (p === "/api/config/history/diff" && req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    try {
      const before = JSON.stringify(redact(readVersion(id).config), null, 2);
      const after = JSON.stringify(redact(getConfig()), null, 2);
      const d = diffLines(before, after, { fromLabel: "this version", toLabel: "current" });
      return json({ summary: d.summary, unified: d.unified });
    } catch {
      return json({ error: "not found" }, 404);
    }
  }

  if (p === "/api/config/history/checkpoint" && req.method === "POST") {
    const b = (await readJson(req)) as { label?: string };
    const label = b?.label?.trim() || "checkpoint";
    return json({ ok: true, version: recordVersion(getConfig(), "checkpoint", Date.now(), label) });
  }

  if (p === "/api/config/history/restore" && req.method === "POST") {
    const b = (await readJson(req)) as { id?: string };
    if (!b?.id) return json({ error: "id required" }, 400);
    let target;
    try {
      target = readVersion(b.id);
    } catch {
      return json({ error: "not found" }, 404);
    }
    const v = validateConfig(target.config);
    if (!v.ok || !v.value) return json({ ok: false, errors: v.errors }, 400);
    // Snapshot the current state first so the restore itself is reversible.
    recordVersion(getConfig(), "auto", Date.now(), "before restore");
    setConfig(v.value);
    let persisted = true;
    try {
      atomicWrite(getConfigSource().path, serializeConfig(v.value));
    } catch {
      persisted = false;
    }
    const label = target.label ? `restored "${target.label}"` : `restored ${b.id}`;
    recordVersion(getConfig(), "auto", Date.now(), label);
    return json({ ok: true, persisted, restored: b.id, config: redact(getConfig()) });
  }

  if (p === "/api/config/history/delete" && req.method === "POST") {
    const b = (await readJson(req)) as { id?: string };
    if (!b?.id) return json({ error: "id required" }, 400);
    return deleteVersion(b.id) ? json({ ok: true }) : json({ error: "not found" }, 404);
  }

  return null;
}

// ── Tool Modules API ─────────────────────────────────────────────────────────
/**
 * Routes for the Modules page — see every catalog module and toggle each on/off.
 *
 *   • `GET  /api/modules`        — all modules + their live enabled/disabled state.
 *   • `POST /api/modules/toggle` — `{ slug, enabled }`: flip one module's
 *     exposure, apply it live (`setConfig`) and persist it to the config file's
 *     `tools` block. The change re-curates the surface the MCP server registers,
 *     so an MCP client must reconnect (or the server restart) for the tool list
 *     to actually shrink/grow — flagged via `requiresReconnect` so the UI warns.
 *
 * The persist path mirrors the Backups page: write the live config back to its
 * source file; if that fails (read-only fs, env-assembled config) the toggle
 * still applies for this process and we report `persisted:false` rather than
 * failing the request.
 */
async function modulesRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/modules" && p !== "/api/modules/toggle" && p !== "/api/modules/app-views")
    return null;

  if (p === "/api/modules" && req.method === "GET") {
    const cfg = getConfig();
    const src = getConfigSource();
    return json({
      ...moduleSurface(cfg.tools),
      filter: cfg.tools,
      source: src,
      appViews: cfg.mcp.appViews,
    });
  }

  if (p === "/api/modules/toggle" && req.method === "POST") {
    const b = (await readJson(req)) as { slug?: string; enabled?: boolean };
    if (typeof b?.slug !== "string" || typeof b?.enabled !== "boolean") {
      return json({ error: "slug (string) and enabled (boolean) are required" }, 400);
    }
    const mod = moduleCatalog.find((m) => m.slug.toLowerCase() === b.slug!.toLowerCase());
    if (!mod) return json({ error: `unknown module: ${b.slug}` }, 404);

    const cfg = getConfig();
    // Re-validate the toggled filter through the schema so the persisted shape is
    // always canonical (defaults filled, types coerced).
    const nextTools = ToolFilterSchema.parse(applyModuleToggle(cfg.tools, mod.slug, b.enabled));
    const next = { ...cfg, tools: nextTools };
    setConfig(next);

    let persisted = true;
    let warning: string | undefined;
    try {
      atomicWrite(getConfigSource().path, serializeConfig(next));
    } catch (e) {
      persisted = false;
      warning = `applied live but not saved to disk: ${clientError(e)}`;
    }
    if (persisted) {
      recordVersion(
        getConfig(),
        "auto",
        Date.now(),
        `module ${b.enabled ? "enabled" : "disabled"}: ${mod.slug}`,
      );
    }
    return json({
      ok: true,
      persisted,
      requiresReconnect: true,
      warning,
      slug: mod.slug,
      enabled: b.enabled,
      ...moduleSurface(getConfig().tools),
      filter: getConfig().tools,
      source: getConfigSource(),
    });
  }

  // POST /api/modules/app-views — toggle MCP App view metadata on/off.
  if (p === "/api/modules/app-views" && req.method === "POST") {
    const b = (await readJson(req)) as { enabled?: boolean };
    if (typeof b?.enabled !== "boolean") {
      return json({ error: "enabled (boolean) is required" }, 400);
    }

    const cfg = getConfig();
    const next = { ...cfg, mcp: { ...cfg.mcp, appViews: b.enabled } };
    setConfig(next);

    let persisted = true;
    let warning: string | undefined;
    try {
      atomicWrite(getConfigSource().path, serializeConfig(next));
    } catch (e) {
      persisted = false;
      warning = `applied live but not saved to disk: ${clientError(e)}`;
    }
    if (persisted) {
      recordVersion(
        getConfig(),
        "auto",
        Date.now(),
        `app views ${b.enabled ? "enabled" : "disabled"}`,
      );
    }
    return json({
      ok: true,
      persisted,
      requiresReconnect: true,
      warning,
      appViews: b.enabled,
      source: getConfigSource(),
    });
  }

  return null;
}

// ── Packet Capture Studio API ────────────────────────────────────────────────
/**
 * Routes for the live capture view: status/stats, the recent-packet ring, a
 * pcap download, and start/stop of the host-side TZSP receiver (the device-side
 * mirror is configured by the start_packet_capture tool).
 */
async function captureRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/api/capture/status" && req.method === "GET") {
    return json(capture.stats());
  }
  if (p === "/api/capture/packets" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
    return json({ packets: capture.recent(limit), stats: capture.stats() });
  }
  if (p === "/api/capture/pcap" && req.method === "GET") {
    return new Response(capture.pcap(), {
      headers: {
        "content-type": "application/vnd.tcpdump.pcap",
        "content-disposition": `attachment; filename="capture.pcap"`,
      },
    });
  }
  if (p === "/api/capture/start" && req.method === "POST") {
    const body = (await readJson(req)) as { port?: number };
    return json(
      await capture.start(typeof body?.port === "number" ? body.port : DEFAULT_TZSP_PORT),
    );
  }
  if (p === "/api/capture/stop" && req.method === "POST") {
    capture.stop();
    return json({ ok: true, ...capture.stats() });
  }
  return null;
}

// ── Connected Clients API ────────────────────────────────────────────────────
/**
 * Routes for the Clients page — LAN devices on a router, not the routers
 * themselves. Each handler builds a {@link createContext} for the requested
 * device and calls the SAME exported operations the connected-device MCP tools
 * wrap, so a block/allow/pin from the web page and from chat run identical
 * RouterOS commands. Mutations return the operation result plus a refreshed
 * device `view` so the page can adopt the new state without a second request.
 */
/**
 * CAPsMAN read-only routes for the dashboard page. Each builds a device context
 * from `?device=` and runs the pure engine over the fetched CAPsMAN state.
 */
/** CAPsMAN trend store, opened in runDashboard and filled by the slow sampler. */
let capsmanStore: CapsmanStore | null = null;

async function capsmanRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/capsman")) return null;

  if (req.method === "GET") {
    const ctx = createContext(undefined, url.searchParams.get("device") ?? undefined);
    if (p === "/api/capsman/overview") {
      return json(capsmanOverview(await fetchCapsmanState(ctx)));
    }
    if (p === "/api/capsman/clients") {
      const state = await fetchCapsmanState(ctx);
      const weakDbm = Number.parseInt(url.searchParams.get("weak_dbm") ?? "", 10);
      const weak = reportWeakClients(state, Number.isFinite(weakDbm) ? weakDbm : undefined);
      return json({ clients: state.clients, weak });
    }
    if (p === "/api/capsman/audit") {
      return json(runCapsmanAudit(await fetchCapsmanState(ctx)));
    }
    if (p === "/api/capsman/trends") {
      if (!capsmanStore) return json({ error: "capsman store not active" }, 503);
      const device = resolveDeviceName(url.searchParams.get("device") ?? undefined);
      const days = daysParam(url, 7, 30);
      const series = capsmanStore.radioSeries(device, Date.now() - days * 86_400_000);
      return json({ series, days });
    }
    return null;
  }

  // Writes: same snapshot + Safe-Mode envelope as the tools (fallback OFF).
  if (req.method === "POST") {
    const body = (await readJson(req)) as {
      device?: string;
      action?: string;
      mac?: string;
      mode?: string;
      confirm?: boolean;
    };
    const ctx = createContext(undefined, body?.device);
    const state = await fetchCapsmanState(ctx);

    if (p === "/api/capsman/apply/steer") {
      const client = state.clients.find(
        (c) => c.mac.toLowerCase() === (body.mac ?? "").toLowerCase(),
      );
      if (!client) return json({ ok: false, error: "client not associated" }, 400);
      if (steerAlreadyPresent(state, body.mac ?? "")) {
        return json({ ok: true, message: "already steered (no-op)" });
      }
      const mode = body.mode === "soft" ? "soft" : "hard";
      const commands = buildSteerCommands(state, body.mac ?? "", client.radioId, mode);
      if (!body.confirm) return json({ ok: true, preview: commands });
      return json(await applyCapsmanWrites(ctx, commands, `pre-steer-${body.mac}`));
    }
    if (p === "/api/capsman/apply/load-balance") {
      const plan = loadBalancePlan(state);
      const commands = buildLoadBalanceCommands(state, plan);
      if (!body.confirm) return json({ ok: true, preview: commands, plan });
      return json(await applyCapsmanWrites(ctx, commands, "pre-load-balance"));
    }
    if (p === "/api/capsman/apply/channel-plan") {
      if (state.path === "/caps-man") {
        return json({ ok: false, error: "channel-plan apply is v7 /interface wifi only" }, 400);
      }
      const commands = buildChannelPlanCommands(state);
      if (!body.confirm) return json({ ok: true, preview: commands });
      return json(await applyCapsmanWrites(ctx, commands, "pre-channel-plan"));
    }
    if (p === "/api/capsman/apply/ft") {
      const commands = buildFtCommands(state);
      if (!body.confirm) return json({ ok: true, preview: commands });
      return json(await applyCapsmanWrites(ctx, commands, "pre-ft"));
    }
    if (p === "/api/capsman/apply/ha") {
      const commands = buildHaCommands(state);
      const guidance = haGuidance(state);
      if (!body.confirm) return json({ ok: true, preview: commands, guidance });
      const res = await applyCapsmanWrites(ctx, commands, "pre-ha");
      return json({ ...res, guidance });
    }
  }
  return null;
}

/** Snapshot + Safe-Mode apply for the dashboard CAPsMAN write routes. */
async function applyCapsmanWrites(
  ctx: ReturnType<typeof createContext>,
  commands: string[],
  label: string,
): Promise<{
  ok: boolean;
  snapshotId?: string;
  safeMode?: string;
  applied?: number;
  error?: string;
}> {
  if (commands.length === 0) return { ok: true, applied: 0 };
  const snapshotId = await captureSnapshot(ctx, label);
  const device = resolveDeviceName(ctx.device);
  const outcome = await applyWritesSafely(ctx, device, commands, { allowDirectFallback: false });
  return {
    ok: outcome.committed && !outcome.error,
    snapshotId,
    safeMode: outcome.safeMode,
    applied: outcome.applied,
    error: outcome.error,
  };
}

async function clientsRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/clients")) return null;

  const deviceFromQuery = (): string | undefined => url.searchParams.get("device") ?? undefined;

  if (p === "/api/clients" && req.method === "GET") {
    const ctx = createContext(undefined, deviceFromQuery());
    return json(devicesView(await fetchDevices(ctx)));
  }

  if (p === "/api/clients/traffic" && req.method === "GET") {
    const ip = url.searchParams.get("ip");
    if (!ip) return json({ error: "ip required" }, 400);
    const ctx = createContext(undefined, deviceFromQuery());
    return json(await sampleDeviceTraffic(ctx, ip));
  }

  if (p === "/api/clients/traffic-bulk" && req.method === "GET") {
    const ctx = createContext(undefined, deviceFromQuery());
    return json(await sampleAllTraffic(ctx));
  }

  // Mutations: each takes { mac, device?, ... } and returns { ok, message, view? }.
  if (req.method === "POST") {
    const b = (await readJson(req)) as {
      mac?: string;
      device?: string;
      ip?: string;
      label?: string;
      comment?: string;
      download?: string;
      upload?: string;
    };
    const ctx = createContext(undefined, b?.device);

    // Rate limits are keyed by IP (the queue target), not MAC.
    if (p === "/api/clients/limits") {
      if (!b?.ip) return json({ error: "ip required" }, 400);
      return json(await setDeviceLimits(ctx, b.ip, { download: b.download, upload: b.upload }));
    }

    if (!b?.mac) return json({ error: "mac required" }, 400);

    const run = async (op: Promise<{ ok: boolean; message: string }>): Promise<Response> => {
      const r = await op;
      return json({ ...r, view: r.ok ? devicesView(await fetchDevices(ctx)) : undefined });
    };

    if (p === "/api/clients/block") return run(blockDevice(ctx, b.mac, b.comment));
    if (p === "/api/clients/allow") return run(allowDevice(ctx, b.mac));
    if (p === "/api/clients/pin") return run(makeDeviceStatic(ctx, b.mac));
    if (p === "/api/clients/remove") return run(removeDeviceLease(ctx, b.mac));
    if (p === "/api/clients/set-ip") {
      if (!b.ip) return json({ error: "ip required" }, 400);
      return run(setDeviceIp(ctx, b.mac, b.ip));
    }
    if (p === "/api/clients/label") {
      if (typeof b.label !== "string") return json({ error: "label required" }, 400);
      return run(setDeviceLabel(ctx, b.mac, b.label));
    }
  }

  return null;
}

// ── AAA (RADIUS + User Manager) API ──────────────────────────────────────────
/**
 * Routes for the AAA page — full management of the router's RADIUS client
 * (`/radius`) and the built-in User Manager RADIUS server (`/user-manager`:
 * users, profiles, limitations, NAS clients, user-profile assignments, sessions
 * and global settings). Each handler builds a {@link createContext} for the
 * requested device and calls the shared `aaa-data` layer, so the dashboard and
 * the AAA MCP App view run identical RouterOS commands. Reads return
 * `{ available, rows }`; mutations return `{ ok, message }`.
 */
async function aaaRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/aaa")) return null;

  const deviceFromQuery = (): string | undefined => url.searchParams.get("device") ?? undefined;

  // ── Reads (GET) ────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    if (p === "/api/aaa/entities") {
      // Static metadata so the UI knows which entities/fields exist.
      return json({ entities: AAA_ENTITIES });
    }
    if (p === "/api/aaa/radius-incoming") {
      return json(await getRadiusIncoming(createContext(undefined, deviceFromQuery())));
    }
    if (p === "/api/aaa/um-settings") {
      return json(await getUmSettings(createContext(undefined, deviceFromQuery())));
    }
    const listMatch = p.match(/^\/api\/aaa\/list\/([\w-]+)$/);
    if (listMatch) {
      const slug = listMatch[1] as string;
      if (!AAA_ENTITIES[slug]) return json({ error: "unknown entity" }, 404);
      return json(await listAaaEntity(createContext(undefined, deviceFromQuery()), slug));
    }
    return null;
  }

  // ── Writes (POST) ──────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = (await readJson(req)) as {
      device?: string;
      slug?: string;
      id?: string;
      enable?: boolean;
      fields?: Record<string, string>;
    };
    const ctx = createContext(undefined, body?.device);

    if (p === "/api/aaa/radius-incoming")
      return json(await setRadiusIncoming(ctx, body?.fields ?? {}));
    if (p === "/api/aaa/um-settings") return json(await setUmSettings(ctx, body?.fields ?? {}));
    if (p === "/api/aaa/radius-reset-counters") return json(await resetRadiusCounters(ctx));

    const slug = body?.slug ?? "";
    if (!AAA_ENTITIES[slug]) return json({ error: "unknown entity" }, 404);

    if (p === "/api/aaa/add") return json(await addAaaEntity(ctx, slug, body?.fields ?? {}));
    if (p === "/api/aaa/update") {
      if (!body?.id) return json({ error: "id required" }, 400);
      return json(await updateAaaEntity(ctx, slug, body.id, body?.fields ?? {}));
    }
    if (p === "/api/aaa/remove") {
      if (!body?.id) return json({ error: "id required" }, 400);
      return json(await removeAaaEntity(ctx, slug, body.id));
    }
    if (p === "/api/aaa/toggle") {
      if (!body?.id) return json({ error: "id required" }, 400);
      return json(await toggleAaaEntity(ctx, slug, body.id, body?.enable === true));
    }
  }

  return null;
}

// ── Usage history API (clients + User Manager, persisted) ────────────────────
// The usage store is opened once in runDashboard and held here so the routes can
// read it (it's filled by the background usage sampler).
let usageStore: UsageStore | null = null;

/** Clamp a `days` query param to a sane window (default 90, max ~400). */
function daysParam(url: URL, fallback: number, max: number): number {
  const n = Number(url.searchParams.get("days"));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/**
 * Routes for the persisted usage views:
 *   • `GET /api/usage/client`   — a connected client's per-day ↓/↑ over N days.
 *   • `GET /api/usage/um-user`  — a User Manager user's per-day ↓/↑ over N days.
 *   • `GET /api/usage/um-users` — User Manager users that have stored sessions.
 *   • `GET /api/usage/heatmap`  — per-day connection counts (GitHub-style), for
 *     one user or all, since N days ago.
 */
async function usageRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/usage")) return null;

  // Sampling-interval control (dashboard-level, not a device command).
  if (p === "/api/usage/sampler") {
    if (req.method === "GET") return json({ intervalMs: getUsageSamplerInterval() });
    if (req.method === "POST") {
      const b = (await readJson(req)) as { intervalMs?: number };
      const applied = setUsageSamplerInterval(Number(b?.intervalMs));
      return json({ intervalMs: applied });
    }
    return null;
  }

  if (req.method !== "GET") return null;
  if (!usageStore) return json({ error: "usage store not active" }, 503);

  const device = resolveDeviceName(url.searchParams.get("device") ?? undefined);
  const sinceTs = (days: number): number => Date.now() - days * 86_400_000;

  if (p === "/api/usage/um-users") {
    return json({ users: usageStore.umUsers(device) });
  }
  if (p === "/api/usage/client") {
    const ip = url.searchParams.get("ip");
    if (!ip) return json({ error: "ip required" }, 400);
    const series = usageStore.clientDailyUsage(device, ip, sinceTs(daysParam(url, 90, 400)));
    return json(withTotals(series));
  }
  if (p === "/api/usage/um-user") {
    const user = url.searchParams.get("user");
    if (!user) return json({ error: "user required" }, 400);
    const series = usageStore.umUserDailyUsage(device, user, sinceTs(daysParam(url, 90, 400)));
    return json(withTotals(series));
  }
  if (p === "/api/usage/heatmap") {
    const user = url.searchParams.get("user");
    const days = usageStore.heatmap(device, user || null, sinceTs(daysParam(url, 371, 400)));
    const total = days.reduce((s, d) => s + d.count, 0);
    const max = days.reduce((m, d) => Math.max(m, d.count), 0);
    return json({ days, total, max });
  }
  return null;
}

/** Attach cumulative totals to a per-day usage series. */
function withTotals(series: { day: string; rx: number; tx: number }[]): unknown {
  return {
    series,
    totalRx: series.reduce((s, d) => s + d.rx, 0),
    totalTx: series.reduce((s, d) => s + d.tx, 0),
  };
}

// Lazily open the config-snapshot store (shared with the snapshot tools), so the
// SQLite handle isn't created unless the Snapshots page is actually used.
let snapStorePromise: Promise<SnapshotStore> | null = null;
function snapStore(): Promise<SnapshotStore> {
  if (!snapStorePromise) snapStorePromise = openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return snapStorePromise;
}

/**
 * Read-only feature pages that surface existing MCP capabilities in the dashboard:
 *   • `/api/snapshots*` — config-snapshot history + time-travel diff (local store).
 *   • `/api/plan`        — a terraform-style dry-run of intended RouterOS commands
 *     (pure `buildChangePlan`, never touches a device).
 */
async function featureRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;

  // ── Config snapshots ──────────────────────────────────────────────────────
  if (p === "/api/snapshots" && req.method === "GET") {
    const store = await snapStore();
    const cfg = getConfig();
    const all = Object.keys(cfg.devices).flatMap((d) => store.list(d, 200, false));
    all.sort((a, b) => b.ts - a.ts);
    return json({ snapshots: all });
  }
  const snapMatch = p.match(/^\/api\/snapshot\/(.+)$/);
  if (snapMatch && req.method === "GET") {
    const store = await snapStore();
    const s = store.get(decodeURIComponent(snapMatch[1] as string));
    return s ? json(s) : json({ error: "not found" }, 404);
  }
  if (p === "/api/snapshots/diff" && req.method === "POST") {
    const store = await snapStore();
    const b = (await readJson(req)) as { from?: string; to?: string };
    const from = b?.from ? store.get(b.from) : null;
    const to = b?.to ? store.get(b.to) : null;
    if (!from || !to) {
      return json({ error: "both 'from' and 'to' snapshot ids are required" }, 400);
    }
    // Diff the normalised exports so the volatile header line is ignored.
    const diff = diffLines(normalizeExport(from.body), normalizeExport(to.body), {
      fromLabel: from.label ?? from.id,
      toLabel: to.label ?? to.id,
    });
    return json({
      from: { id: from.id, label: from.label, ts: from.ts, device: from.device },
      to: { id: to.id, label: to.label, ts: to.ts, device: to.device },
      summary: diff.summary,
      unified: diff.unified,
    });
  }

  // ── Change plan (dry-run; pure, no device I/O) ────────────────────────────
  if (p === "/api/plan" && req.method === "POST") {
    const b = (await readJson(req)) as { commands?: string[]; script?: string };
    const commands = [
      ...(b?.commands ?? []).map((c) => c.trim()).filter(Boolean),
      ...(b?.script ? splitCommands(b.script) : []),
    ];
    if (commands.length === 0) return json({ error: "no commands provided" }, 400);
    const plan = buildChangePlan(commands);
    return json({ plan, text: renderPlan(plan) });
  }

  // ── S3 backup management (list / read / delete) ───────────────────────────
  if (p === "/api/s3" && req.method === "GET") {
    return json({ configured: isS3Configured(), target: isS3Configured() ? s3Target() : null });
  }
  if (p === "/api/s3/list" && req.method === "GET") {
    if (!isS3Configured()) return json({ configured: false, objects: [] });
    const prefix = url.searchParams.get("prefix") ?? "";
    try {
      const res = await getS3Client().list({ prefix: prefix || undefined, maxKeys: 1000 });
      const objects = (res.contents ?? []).map((o) => ({
        key: o.key,
        size: o.size ?? 0,
        lastModified: o.lastModified ?? null,
      }));
      return json({ configured: true, target: s3Target(), objects, truncated: !!res.isTruncated });
    } catch (e) {
      return json({ error: clientError(e) }, 502);
    }
  }
  if (p === "/api/s3/presign" && req.method === "GET") {
    if (!isS3Configured()) return json({ error: "S3 not configured" }, 400);
    const key = url.searchParams.get("key");
    if (!key) return json({ error: "key required" }, 400);
    try {
      // A short-lived GET URL the browser can open to download/read the object.
      const link = getS3Client().presign(key, { expiresIn: presignExpiresIn(), method: "GET" });
      return json({ url: link });
    } catch (e) {
      return json({ error: clientError(e) }, 502);
    }
  }
  if (p === "/api/s3/delete" && req.method === "POST") {
    if (!isS3Configured()) return json({ error: "S3 not configured" }, 400);
    const b = (await readJson(req)) as { key?: string };
    if (!b?.key) return json({ error: "key required" }, 400);
    try {
      const client = getS3Client();
      if (!(await client.exists(b.key))) return json({ error: "not found" }, 404);
      await client.delete(b.key);
      return json({ ok: true, key: b.key });
    } catch (e) {
      return json({ error: clientError(e) }, 502);
    }
  }

  // ── Local backup vault (create on device side via tools; here: read/manage) ─
  if (p === "/api/backups" && req.method === "GET") {
    return json({
      dir: backupDir(),
      devices: Object.keys(getConfig().devices),
      backups: listBackups(),
    });
  }
  if (p === "/api/backups/dir" && req.method === "POST") {
    const b = (await readJson(req)) as { dir?: string };
    const raw = b?.dir?.trim();
    if (!raw) return json({ error: "dir required" }, 400);
    // Expand a leading ~ so users can type `~/backups` in the dashboard.
    const dir = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
    const next = { ...getConfig(), backupDir: dir };
    setConfig(next);
    // Persist to the config file so the new path survives a restart. If the
    // write fails (read-only fs, no config file), the change still applies live
    // for this process — report that it wasn't persisted rather than failing.
    try {
      atomicWrite(getConfigSource().path, serializeConfig(next));
    } catch (e) {
      return json({
        ok: true,
        dir: backupDir(),
        persisted: false,
        warning: `applied live but not saved: ${clientError(e)}`,
      });
    }
    recordVersion(getConfig(), "auto", Date.now(), "backup path changed");
    return json({ ok: true, dir: backupDir(), persisted: true });
  }
  if (p === "/api/backups/get" && req.method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return json({ error: "name required" }, 400);
    try {
      return json({ name, content: readBackup(name) });
    } catch {
      return json({ error: "not found" }, 404);
    }
  }
  if (p === "/api/backups/raw" && req.method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return new Response("name required", { status: 400 });
    try {
      return new Response(readBackup(name), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }
  if (p === "/api/backups/upload" && req.method === "POST") {
    const b = (await readJson(req)) as { name?: string; content?: string };
    if (!b?.name || typeof b.content !== "string") {
      return json({ error: "name and content are required" }, 400);
    }
    try {
      const safe = b.name.endsWith(".rsc") ? b.name : `${b.name}.rsc`;
      return json({ ok: true, name: writeBackup(safe, b.content) });
    } catch (e) {
      return json({ error: clientError(e) }, 400);
    }
  }
  if (p === "/api/backups/rename" && req.method === "POST") {
    const b = (await readJson(req)) as { name?: string; new_name?: string };
    if (!b?.name || !b?.new_name) return json({ error: "name and new_name are required" }, 400);
    try {
      return json({ ok: true, name: renameBackup(b.name, b.new_name) });
    } catch (e) {
      return json({ error: clientError(e) }, 400);
    }
  }
  if (p === "/api/backups/delete" && req.method === "POST") {
    const b = (await readJson(req)) as { name?: string };
    if (!b?.name) return json({ error: "name required" }, 400);
    try {
      return deleteBackup(b.name) ? json({ ok: true }) : json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: clientError(e) }, 400);
    }
  }
  if (p === "/api/backups/restore" && req.method === "POST") {
    const b = (await readJson(req)) as { name?: string; device?: string; confirm?: boolean };
    if (!b?.name) return json({ error: "name required" }, 400);
    const device = resolveDeviceName(b.device);
    return json(await restoreLocalBackup(device, b.name, b.confirm === true));
  }
  if (p === "/api/backups/create" && req.method === "POST") {
    const b = (await readJson(req)) as {
      device?: string;
      label?: string;
      show_sensitive?: boolean;
      verbose?: boolean;
      compact?: boolean;
      terse?: boolean;
    };
    const ctx = createContext(undefined, b?.device);
    const r = await createLocalBackup(ctx, {
      label: b?.label,
      showSensitive: b?.show_sensitive === true,
      verbose: b?.verbose === true,
      compact: b?.compact === true,
      terse: b?.terse === true,
    });
    return r.ok ? json(r) : json({ error: r.error ?? "export failed" }, 502);
  }

  return null;
}

export interface DashboardHandle {
  server: Server<SocketData>;
  store: EventStore;
  stop(): void;
}

/**
 * Open the store, turn on the recorder, and start the dashboard server. Returns
 * a handle for tests/shutdown. `transportLabel` tags recorded events.
 */
export async function runDashboard(
  cfg: DashboardConfig,
  transportLabel: string,
): Promise<DashboardHandle> {
  const store = await openSqliteStore(cfg.dbPath);
  configureRecorder({
    store,
    capture: {
      captureBody: cfg.captureBody,
      maxBodyBytes: cfg.maxBodyBytes,
      redactInput: cfg.redactInput,
    },
    maxEvents: cfg.maxEvents,
    transport: transportLabel,
  });

  // Periodically probe each configured device's SSH reachability for the
  // connectivity graph/status (one immediate pass, then every 30s).
  startHealthChecks(30_000);
  // Geolocate each device's public IP for the country flag (cached ~1 day).
  startGeoLookups();

  // Persisted usage history: a SQLite DB beside the events DB, filled by a slow
  // background sampler (per-client ↓/↑ snapshots + User Manager session ingest)
  // that powers the 3-month usage graphs and the forever connection heatmap.
  try {
    usageStore = await openUsageStore(join(dirname(cfg.dbPath), "usage.db"));
    startUsageSampler(usageStore);
  } catch (e) {
    logger.warn(`[${SERVER_TAG}] usage history disabled: ${String(e)}`);
  }

  // CAPsMAN trends: a SQLite DB beside the events DB, filled by a slow (5-min)
  // background sampler that snapshots each radio's client load for the graphs.
  try {
    capsmanStore = await openCapsmanStore(join(dirname(cfg.dbPath), "capsman.db"));
    startCapsmanSampler(capsmanStore);
  } catch (e) {
    logger.warn(`[${SERVER_TAG}] capsman trends disabled: ${String(e)}`);
  }

  // Seed an initial config baseline so the version timeline always has at least
  // one restore point (the state the dashboard started with).
  try {
    if (historyIsEmpty()) recordVersion(getConfig(), "auto", Date.now(), "baseline");
  } catch (e) {
    logger.warn(`[${SERVER_TAG}] could not seed config history baseline: ${String(e)}`);
  }

  // Config Studio: a safe-apply state machine bound to real fs/clock/timers. It
  // backs up the config file, hot-swaps via setConfig, and auto-reverts unless
  // the dashboard confirms within the rollback window.
  const configAdmin = createConfigAdmin({
    getConfig,
    setConfig,
    source: getConfigSource,
    readFile: (pth) => {
      try {
        return readFileSync(pth, "utf8");
      } catch {
        return null;
      }
    },
    writeText: atomicWrite,
    now: Date.now,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => {
      if (h) clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  });

  const tokenOk = (req: Request, url: URL): boolean => {
    if (!cfg.token) return true;
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    return bearer === cfg.token || url.searchParams.get("token") === cfg.token;
  };

  /** Route all dashboard API requests; exceptions bubble to the caller. */
  async function dashboardRoute(
    req: Request,
    url: URL,
    srv: Server<SocketData>,
    ca: typeof configAdmin,
    tl: string,
  ): Promise<Response> {
    // Live stream — Bun-native WebSocket (preferred). One endpoint serves two
    // channels: `?traffic=<device>` is the Clients-page traffic feed, otherwise
    // it's the tool-event feed. `open()` branches on `ws.data.traffic`.
    if (url.pathname === "/api/stream") {
      const traffic = url.searchParams.has("traffic")
        ? (url.searchParams.get("traffic") ?? "")
        : undefined;
      if (srv.upgrade(req, { data: { traffic } })) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Live stream — Server-Sent Events (the front-end's automatic fallback when
    // WebSocket can't connect, e.g. through some proxies). Same two channels.
    if (url.pathname === "/api/sse") {
      const traffic = url.searchParams.has("traffic")
        ? (url.searchParams.get("traffic") ?? "")
        : undefined;
      return traffic === undefined ? sseResponse(tl) : sseTrafficResponse(traffic, tl);
    }

    // Config Studio routes are independent of the event store, so dispatch
    // them before the recorder guard below.
    const configResp = await configRoutes(req, url, ca);
    if (configResp) return configResp;

    const modulesResp = await modulesRoutes(req, url);
    if (modulesResp) return modulesResp;

    const captureResp = await captureRoutes(req, url);
    if (captureResp) return captureResp;

    const capsmanResp = await capsmanRoutes(req, url);
    if (capsmanResp) return capsmanResp;

    const clientsResp = await clientsRoutes(req, url);
    if (clientsResp) return clientsResp;

    const aaaResp = await aaaRoutes(req, url);
    if (aaaResp) return aaaResp;

    const usageResp = await usageRoutes(req, url);
    if (usageResp) return usageResp;

    const featureResp = await featureRoutes(req, url);
    if (featureResp) return featureResp;

    const driftResp = await driftRoutes(req, url);
    if (driftResp) return driftResp;

    const txnResp = await txnRoutes(req, url);
    if (txnResp) return txnResp;

    const flowResp = await flowRoutes(req, url);
    if (flowResp) return flowResp;

    // `getEventStore()` rather than the `db` binding below, which is declared
    // later in this function — alerting's rule preview replays stored events.
    const alertResp = await alertRoutes(req, url, getEventStore());
    if (alertResp) return alertResp;

    const memoryResp = await memoryRoutes(req, url);
    if (memoryResp) return memoryResp;

    const db = getEventStore();
    if (!db) return json({ error: "recorder not active" }, 503);

    // Delete selected events (`{ ids: [...] }`) or every event (`{ all: true }`).
    // Gated by the same bearer token as every other route (checked above).
    if (url.pathname === "/api/events" && req.method === "DELETE") {
      let body: { ids?: unknown; all?: unknown } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        /* empty / invalid body → no-op selection */
      }
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === "string")
        : [];
      const removed = body.all === true ? db.clear() : db.delete(ids);
      return json({ removed, total: db.total() });
    }

    if (url.pathname === "/api/ssh-pool") {
      const cfg = getConfig();
      const enabled = isPoolEnabled();
      const ps = poolStatus();
      const totalInflight = ps.reduce((s, p) => s + p.inflight, 0);
      const totalIdle = ps.filter((p) => p.idle).length;
      const totalBusy = ps.filter((p) => p.inflight > 0).length;
      return json({
        enabled,
        config: {
          keepAlive: cfg.ssh.keepAlive,
          keepAliveInterval: cfg.ssh.keepAliveInterval,
          idleTimeout: cfg.ssh.idleTimeout,
        },
        aggregate: {
          totalConnections: ps.length,
          totalInflight,
          totalIdle,
          totalBusy,
        },
        devices: ps,
      });
    }

    // Country flag SVG (circle-flags), proxied same-origin so the dashboard's CSP
    // doesn't block it. `/api/flag/<iso2>` (optional `.svg`).
    if (url.pathname.startsWith("/api/flag/")) {
      const code = url.pathname.slice("/api/flag/".length).replace(/\.svg$/, "");
      const svg = await flagSvg(code);
      if (!svg) return new Response("flag not found", { status: 404 });
      return new Response(svg, {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (url.pathname === "/api/devices") {
      return json(devicesPayload(db));
    }

    // Capability probes. GET is deliberately non-probing: it reports only what
    // has already been learned, so opening the dashboard cannot fan out a probe
    // to every configured router. Use the refresh endpoint to actually probe.
    if (url.pathname === "/api/capabilities") {
      const devices = Object.keys(getConfig().devices).map((name) => ({
        device: name,
        capabilities: serializeCapabilities(peekCapabilities(name)),
      }));
      return json({ devices });
    }

    if (url.pathname === "/api/capabilities/refresh" && req.method === "POST") {
      const b = (await readJson(req)) as { device?: string };
      if (typeof b?.device !== "string") return json({ error: "device (string) is required" }, 400);
      if (!(b.device in getConfig().devices)) {
        return json({ error: `unknown device: ${b.device}` }, 404);
      }
      invalidateCapabilities(b.device);
      try {
        const caps = await getCapabilities(b.device);
        return json({ device: b.device, capabilities: serializeCapabilities(caps) });
      } catch (e) {
        logger.error(`Capability probe failed for '${b.device}': ${logError(e)}`);
        return json({ error: clientError(e) }, 502);
      }
    }

    if (url.pathname === "/api/devices/toggle" && req.method === "POST") {
      const b = (await readJson(req)) as { device?: string; disabled?: boolean };
      if (typeof b?.device !== "string" || typeof b?.disabled !== "boolean") {
        return json({ error: "device (string) and disabled (boolean) are required" }, 400);
      }
      const cfg = getConfig();
      if (!(b.device in cfg.devices)) return json({ error: `unknown device: ${b.device}` }, 404);

      const dc = cfg.devices[b.device];
      const next: MikrotikConfig = {
        ...cfg,
        devices: {
          ...cfg.devices,
          [b.device]: { ...dc, disabled: b.disabled || undefined },
        },
      };
      setConfig(next);

      let persisted = true;
      let warning: string | undefined;
      try {
        atomicWrite(getConfigSource().path, serializeConfig(next));
      } catch (e) {
        persisted = false;
        warning = `applied live but not saved to disk: ${clientError(e)}`;
      }
      if (persisted) {
        recordVersion(
          getConfig(),
          "auto",
          Date.now(),
          `device ${b.disabled ? "disabled" : "enabled"}: ${b.device}`,
        );
      }
      return json({
        ok: true,
        persisted,
        requiresReconnect: true,
        warning,
        ...(devicesPayload(db) as Record<string, unknown>),
      });
    }

    // Probe a saved device NOW (fresh SSH connect + `/system resource`) and
    // refresh the cached health the cards read. `reconnect` additionally drops the
    // device's pooled connection first, so the next real tool call dials fresh.
    if (
      (url.pathname === "/api/devices/test" || url.pathname === "/api/devices/reconnect") &&
      req.method === "POST"
    ) {
      const b = (await readJson(req)) as { device?: string };
      const name = typeof b?.device === "string" ? b.device : "";
      const cfg = getConfig();
      if (!(name in cfg.devices)) return json({ error: `unknown device: ${name}` }, 404);
      if (url.pathname === "/api/devices/reconnect") closeDevice(name);
      const status = await probeDevice(name, cfg.devices[name]);
      return json({ ok: true, status, ...(devicesPayload(db) as Record<string, unknown>) });
    }

    if (url.pathname === "/api/topology") {
      return json(topologyPayload());
    }

    if (url.pathname === "/api/config") {
      return json(configPayload());
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(dashboardHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/releases/latest") {
      try {
        return json(await fetchLatestRelease());
      } catch (e) {
        return json({ error: clientError(e, "fetch failed") }, 502);
      }
    }

    // Full read-only catalog: every module (with its tools + risk) and every
    // prompt (with its arguments + body) — for the dashboard/Raycast browser.
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      const modules = moduleCatalog.map((m) => ({
        label: m.label,
        slug: m.slug,
        group: m.group,
        description: m.description,
        toolCount: m.tools.length,
        tools: m.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          risk: riskOf(t.annotations),
        })),
      }));
      const prompts = listPrompts();
      const groups = [...new Set(modules.map((m) => m.group))].sort();
      return json({
        modules,
        prompts,
        groups,
        counts: {
          modules: modules.length,
          tools: modules.reduce((n, m) => n + m.toolCount, 0),
          prompts: prompts.length,
          groups: groups.length,
        },
        version: VERSION,
      });
    }

    // Every published release (newest first) + relation to the running version.
    if (url.pathname === "/api/releases" && req.method === "GET") {
      try {
        return json(await fetchAllReleases());
      } catch (e) {
        return json({ error: clientError(e, "fetch failed") }, 502);
      }
    }

    // Install a specific version globally (`bun i -g @usex/mikrotik-mcp@<v>`),
    // then self-restart so the new binary loads. `version` is "latest" or a
    // strict x.y.z (validated to prevent injecting anything into the package arg).
    if (url.pathname === "/api/upgrade" && req.method === "POST") {
      const body = (await readJson(req)) as { version?: unknown; restart?: unknown };
      const version = String(body?.version ?? "latest");
      if (version !== "latest" && !/^\d+\.\d+\.\d+$/.test(version)) {
        return json(
          { ok: false, error: `Invalid version "${version}" (use "latest" or x.y.z).` },
          400,
        );
      }
      const spec = `@usex/mikrotik-mcp@${version}`;
      logger.warn(`Dashboard requested upgrade: bun i -g ${spec}`);
      const { ok, log } = await runUpgrade(spec);
      if (!ok) return json({ ok: false, version, log }, 500);
      // Success → relaunch on the newly-installed version unless told not to.
      const willRestart = body?.restart !== false;
      const relaunched = willRestart ? restartProcess() : false;
      return json({
        ok: true,
        version,
        log,
        restarting: relaunched,
        note: relaunched
          ? "Installed. Restarting on the new version now — reconnect shortly."
          : "Installed. Restart the server (or use the restart button) for it to take effect.",
      });
    }

    if (url.pathname === "/api/meta") {
      const f = facets(db);
      return json({
        ...f,
        version: VERSION,
        risks: ["READ", "WRITE", "WRITE_IDEMPOTENT", "DESTRUCTIVE", "DANGEROUS"],
        total: db.total(),
        liveClients: subscriberCount(),
        transport: tl,
      });
    }

    if (url.pathname === "/api/events") {
      const filter = filterFromQuery(url);
      return json({ events: db.query(filter), total: db.total() });
    }

    const eventMatch = url.pathname.match(/^\/api\/event\/(.+)$/);
    if (eventMatch) {
      const e = db.get(decodeURIComponent(eventMatch[1]));
      return e ? json(e) : json({ error: "not found" }, 404);
    }

    if (url.pathname === "/api/stats") {
      const now = Date.now();
      const windowMs = Number(url.searchParams.get("window") ?? 3_600_000);
      const buckets = Number(url.searchParams.get("buckets") ?? 60);
      const events = db.query({ since: now - windowMs, limit: 5000 });
      return json(computeStats(events, { now, windowMs, buckets }));
    }

    return new Response("Not Found", { status: 404 });
  }

  const server = serve<SocketData>({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/health") return new Response("OK");

      if (!tokenOk(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        return await dashboardRoute(req, url, srv, configAdmin, transportLabel);
      } catch (e) {
        logger.error(`Dashboard request failed (${url.pathname}): ${logError(e)}`);
        return json({ error: clientError(e) }, 502);
      }
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        if (ws.data.traffic !== undefined) {
          // Traffic channel: push each broadcast sample for the chosen device.
          ws.data.unsub = subscribeTraffic(ws.data.traffic, (sample) => {
            try {
              ws.send(JSON.stringify({ type: "traffic", sample }));
            } catch {
              // client went away mid-send; close() will clean up
            }
          });
        } else {
          const send = (payload: unknown): void => {
            try {
              ws.send(JSON.stringify(payload));
            } catch {
              // client went away mid-send; close() will clean up
            }
          };
          // The tool feed and the transaction lanes share this one socket —
          // a second socket per page is exactly what the dashboard avoids.
          const unsubEvents = subscribe((e: ToolEvent) => send({ type: "event", event: e }));
          const unsubTxn = subscribeTxn((update) => send({ type: "txn", update }));
          ws.data.unsub = () => {
            unsubEvents();
            unsubTxn();
          };
        }
        ws.send(JSON.stringify({ type: "hello", transport: transportLabel }));
      },
      message() {
        // The dashboard is push-only; inbound messages are ignored (keep-alive).
      },
      close(ws: ServerWebSocket<SocketData>) {
        ws.data.unsub?.();
      },
    },
  });

  // When bound to all interfaces, "0.0.0.0" isn't a usable URL — surface the
  // actual LAN addresses so the dashboard can be opened from another device.
  const wildcard = cfg.host === "0.0.0.0" || cfg.host === "::";
  const urls = wildcard
    ? [
        `http://localhost:${cfg.port}`,
        ...Object.values(networkInterfaces())
          .flat()
          .filter((a) => a && a.family === "IPv4" && !a.internal)
          .map((a) => `http://${a!.address}:${cfg.port}`),
      ].join("  ")
    : `http://${cfg.host}:${cfg.port}`;
  logger.info(
    `Observability dashboard ready — open ${urls} ` +
      `(db=${cfg.dbPath}, capture=${cfg.captureBody ? "on" : "off"}${cfg.token ? ", token required" : ""})`,
  );
  if (wildcard && !cfg.token) {
    logger.warn(
      "Dashboard is bound to all network interfaces with no token — anyone on your LAN can view it and edit device config. Set dashboard.token (or --dashboard-token) to require auth.",
    );
  }

  return {
    server,
    store,
    stop() {
      stopHealthChecks();
      stopGeoLookups();
      stopUsageSampler();
      stopCapsmanSampler();
      void server.stop(true);
      store.close();
      usageStore?.close();
      usageStore = null;
      capsmanStore?.close();
      capsmanStore = null;
      closeMemoryStore();
    },
  };
}
