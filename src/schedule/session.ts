/**
 * The live wiring: catalog risk lookups, the device list, and the timer that
 * drives `tick`.
 *
 * Everything device- or catalog-facing lives here so `runner.ts` and `model.ts`
 * stay pure enough to test with a fake executor and a fake clock.
 */
import { createContext } from "../core/context";
import { logger } from "../logger";
import { getConfig, listDevices } from "../core/runtime";
import { riskOf } from "../observability/event";
import { auditAdapter } from "./audits";
import { JobSchema } from "./model";
import type { AuditExecutor, RunnerOptions } from "./runner";
import { armJob, tick } from "./runner";
import { scheduleStore } from "./store";
import type { ScheduleJob } from "./store";

/** Tool name → risk, from the live catalog. Built once; the catalog is static. */
let riskByTool: Map<string, ReturnType<typeof riskOf>> | null = null;

async function riskIndex(): Promise<Map<string, ReturnType<typeof riskOf>>> {
  if (riskByTool) return riskByTool;
  const { moduleCatalog } = await import("../tools/index");
  const index = new Map<string, ReturnType<typeof riskOf>>();
  for (const mod of moduleCatalog) {
    for (const tool of mod.tools) index.set(tool.name, riskOf(tool.annotations));
  }
  riskByTool = index;
  return index;
}

/** Warm the index so `liveExecutor().riskOf` can answer synchronously. */
export async function primeRiskIndex(): Promise<void> {
  await riskIndex();
}

export function resetRiskIndex(): void {
  riskByTool = null;
}

/**
 * The real executor: catalog risk, configured devices, and the audit adapters.
 *
 * `riskOf` answers from the warmed index and reports UNKNOWN if the index has
 * not been primed — which the runner treats as a refusal. Failing closed is the
 * only safe default for a check whose whole job is keeping writes out of an
 * unattended loop.
 */
export function liveExecutor(): AuditExecutor {
  return {
    riskOf: (tool) => riskByTool?.get(tool) ?? "UNKNOWN",
    resolveDevices: (spec) => (spec === "all" ? listDevices().names : spec),
    async audit(tool, device) {
      const adapter = auditAdapter(tool);
      if (!adapter) throw new Error(`'${tool}' has no audit adapter and cannot be scheduled`);
      return adapter.run(createContext(undefined, device), device);
    },
  };
}

/** Runner options from the `schedules` config block. */
export function runnerOptions(): RunnerOptions {
  const cfg = getConfig().schedules;
  return {
    concurrency: cfg.concurrency,
    timeoutMs: cfg.timeoutMs,
    jitterMs: cfg.jitterMs,
  };
}

/** Jobs from the store, which is seeded from the config block at startup. */
export async function listJobs(): Promise<ScheduleJob[]> {
  try {
    return (await scheduleStore()).listJobs();
  } catch (e) {
    logger.error(`schedule store unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Copy config-file jobs into the store.
 *
 * The store is the source of truth once running (the tools write to it), so a
 * config job is only seeded when its id is absent — otherwise every restart
 * would silently undo a job someone disabled from the dashboard.
 */
async function seedConfigJobs(): Promise<number> {
  const jobs = getConfig().schedules.jobs;
  if (jobs.length === 0) return 0;
  const store = await scheduleStore();
  const existing = new Set(store.listJobs().map((j) => j.id));
  let seeded = 0;
  for (const raw of jobs) {
    const parsed = JobSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error(
        `schedule job skipped — invalid definition: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
      continue;
    }
    if (existing.has(parsed.data.id)) continue;
    store.saveJob({ ...parsed.data, createdAt: Date.now() });
    seeded++;
  }
  return seeded;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the scheduler loop.
 *
 * The first tick only ARMS each job (see `tick`), so starting the server never
 * fires a nightly audit at boot — otherwise a restart loop becomes an audit
 * loop against every device in the fleet.
 */
export async function startScheduler(): Promise<void> {
  const cfg = getConfig().schedules;
  if (!cfg.enabled || timer) return;

  await primeRiskIndex();
  const seeded = await seedConfigJobs();
  const jobs = await listJobs();
  const now = Date.now();
  for (const job of jobs) if (job.enabled) armJob(job, now);

  logger.info(
    `Scheduled audits enabled: ${jobs.length} job(s)${seeded ? ` (${seeded} seeded from config)` : ""}`,
  );

  timer = setInterval(() => {
    void (async () => {
      try {
        await tick(await listJobs(), liveExecutor(), runnerOptions());
      } catch (e) {
        // A scheduler that dies on one bad tick silently stops watching the
        // network, which is the one failure this feature cannot have.
        logger.error(`schedule tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, cfg.tickSeconds * 1000);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
