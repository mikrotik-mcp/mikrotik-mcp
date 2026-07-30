/**
 * The poll loop and the live wiring.
 *
 * Shaped after task 09's runner because the same four disciplines apply to any
 * unattended loop over a fleet: bounded concurrency, skip-if-still-running, no
 * backfill, and a failure on one device that does not stop the others.
 *
 * Everything device-facing lives here so `detectors.ts`, `correlate.ts` and
 * `respond.ts` stay pure enough to test with a fixture and a fake clock.
 */
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { getConfig, listDevices } from "../core/runtime";
import { logger } from "../logger";
import { emitAlertEvent } from "../alerts/engine";
import { correlate, mergeIncident } from "./correlate";
import type { Incident } from "./correlate";
import { DEFAULT_DETECTOR_CONFIG, runDetectors } from "./detectors";
import type { DetectionInput, Signal, Unavailable } from "./detectors";
import { executePlan, readScanList } from "./execute";
import { dedupe, parseLog } from "./parse";
import type { LogEvent } from "./parse";
import { decide, isPlan } from "./respond";
import type { GuardContext, ResponsePolicy } from "./respond";
import { attackStore } from "./store";

/** Poll windows overlap, so every consumer de-duplicates on the event key. */
const seenEvents = new Set<string>();
/** Bounded: the ring buffer is finite, and so must our memory of it be. */
const SEEN_CAP = 50_000;

function remember(events: LogEvent[]): LogEvent[] {
  if (seenEvents.size > SEEN_CAP) seenEvents.clear();
  return dedupe(events, seenEvents);
}

/** Read one device's recent log. */
export async function fetchLog(device: string, windowMinutes: number): Promise<LogEvent[]> {
  const ctx = createContext(undefined, device);
  // `print detail` — the `value` format transposes into columns and is
  // unparseable at any real line count.
  const raw = await executeMikrotikCommand(
    `/log print detail where time > ([:timestamp] - ${windowMinutes}m)`,
    ctx,
  );
  const { events, unparsed } = parseLog(raw, device);
  if (unparsed.length > 0) {
    logger.warn(
      `[${device}] ${unparsed.length} log line(s) could not be read by the attack parser`,
    );
  }
  return events;
}

/**
 * Everything that may never be blocked, gathered from the deployment.
 *
 * The operator cannot be expected to remember their own gateway at three in the
 * morning, and the one time they forget is the time it matters.
 */
export function buildGuards(): GuardContext {
  const cfg = getConfig();
  const deviceHosts: string[] = [];
  for (const device of Object.values(cfg.devices)) {
    if (device.host) deviceHosts.push(device.host);
  }
  return {
    deviceHosts,
    // The tunnel/LAN address this server reaches devices from is not knowable
    // without asking the device, so the private ranges below cover it and the
    // operator can name a specific address in `neverBlock`.
    managementSources: [],
    infrastructure: [],
    configured: [
      ...cfg.attacks.neverBlock,
      // Nothing private is ever an internet attacker worth an automatic block,
      // and this is where the MCP host itself lives.
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "127.0.0.0/8",
    ],
  };
}

export function policyFromConfig(): ResponsePolicy {
  const cfg = getConfig().attacks;
  return {
    mode: cfg.mode,
    minConfidence: cfg.minConfidence,
    blockTimeout: cfg.blockTimeout,
    maxBlocksPerHour: cfg.maxBlocksPerHour,
    neverBlock: cfg.neverBlock,
    autoRespondTo: cfg.autoRespondTo,
  };
}

export interface SweepResult {
  incidents: Incident[];
  unavailable: Unavailable[];
  devices: { device: string; ok: boolean; events: number; error?: string }[];
  responses: { incidentId: string; action: string; detail: string }[];
}

/** Detect across every device once. */
export async function sweep(
  options: { devices?: string[]; windowMinutes?: number; now?: number; respond?: boolean } = {},
): Promise<SweepResult> {
  const cfg = getConfig().attacks;
  const now = options.now ?? Date.now();
  const windowMinutes = options.windowMinutes ?? cfg.windowMinutes;
  const targets = options.devices ?? listDevices().names;

  const store = await attackStore().catch(() => null);
  const signals: Signal[] = [];
  const unavailable: Unavailable[] = [];
  const deviceResults: SweepResult["devices"] = [];
  const trusted = [...cfg.neverBlock];

  // Bounded concurrency: a fleet sweep must not be N simultaneous SSH sessions.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(cfg.concurrency, targets.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const device = targets[index];
      try {
        const events = remember(await fetchLog(device, windowMinutes));

        // A successful login is baseline material regardless of what else it is.
        if (store) {
          for (const e of events) {
            if (e.outcome === "success" && e.source) {
              store.recordBaselineSource(device, e.source, e.ts ?? now);
            }
          }
        }

        const input: DetectionInput = {
          device,
          events,
          now,
          trusted,
          config: DEFAULT_DETECTOR_CONFIG,
          baseline: store?.baselineFor(device, cfg.learningDays * 86_400_000, now),
        };
        if (cfg.readScanList) {
          input.scanList = await readScanList(createContext(undefined, device));
        }

        const result = runDetectors(input);
        signals.push(...result.signals);
        unavailable.push(...result.unavailable);
        deviceResults.push({ device, ok: true, events: events.length });
      } catch (e) {
        // One unreachable router must not invalidate the sweep.
        deviceResults.push({
          device,
          ok: false,
          events: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });
  await Promise.all(workers);

  // Correlate across ALL devices at once — one source on three routers is one
  // incident, and that is the only place it can be seen.
  const fresh = correlate(signals, { now });
  const incidents: Incident[] = [];
  for (const incident of fresh) {
    const stored = store?.getIncident(incident.id) ?? null;
    const merged = stored ? mergeIncident(stored, incident) : incident;
    store?.saveIncident(merged);
    incidents.push(merged);

    if (!stored || stored.confidence !== merged.confidence || stored.stage !== merged.stage) {
      // Into task 07's bus rather than a second notification path.
      emitAlertEvent({
        kind: "attack",
        device: merged.devices[0],
        isError: merged.severity === "critical" || merged.severity === "high",
        detail: `${merged.confidence} confidence ${merged.stage}: ${merged.narrative}`,
      });
    }
  }

  const responses: SweepResult["responses"] = [];
  if (options.respond ?? true) {
    for (const incident of incidents) {
      const decision = decide({
        incident,
        policy: policyFromConfig(),
        guards: buildGuards(),
        recentBlockCount: store?.countRecentBlocks(incident.devices, now - 3_600_000) ?? 0,
      });
      if (!isPlan(decision)) continue;
      if (decision.action === "escalate") {
        responses.push({
          incidentId: incident.id,
          action: "escalate",
          detail: decision.reason,
        });
        continue;
      }
      const applied = await executePlan(decision);
      const ok = applied.some((r) => r.ok);
      store?.recordResponse({
        incidentId: incident.id,
        action: decision.action,
        source: decision.source,
        devices: decision.devices,
        timeout: decision.timeout,
        list: decision.list,
        reason: decision.reason,
        ts: now,
        ok,
        error: ok ? undefined : applied.map((r) => r.detail).join("; "),
      });
      responses.push({
        incidentId: incident.id,
        action: decision.action,
        detail: applied.map((r) => `${r.device}: ${r.detail}`).join("; "),
      });
    }
  }

  return { incidents, unavailable, devices: deviceResults, responses };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Start the detection loop. Idempotent. */
export function startAttackDetection(): void {
  const cfg = getConfig().attacks;
  if (!cfg.enabled || timer) return;

  logger.info(
    `Attack detection enabled: every ${cfg.pollSeconds}s over a ${cfg.windowMinutes}m window (mode=${cfg.mode})`,
  );
  timer = setInterval(() => {
    // Skip rather than queue: a slow fleet sweep must never pile up behind
    // itself, and the next tick will see the same log anyway.
    if (running) {
      logger.warn("attack sweep still running; skipping this tick");
      return;
    }
    running = true;
    void sweep()
      .catch((e: unknown) => {
        // A loop that dies on one bad tick silently stops watching, which is the
        // one failure this feature cannot have.
        logger.error(`attack sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        running = false;
      });
  }, cfg.pollSeconds * 1000);
  timer.unref?.();
}

export function stopAttackDetection(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
