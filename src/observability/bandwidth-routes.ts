import { z } from "zod";
import { readOperationBody, DashboardInputError } from "./bounded-request";
import {
  BandwidthError,
  bandwidthAccess,
  bandwidthAddresses,
  bandwidthDevices,
  bandwidthStore,
  canReadBandwidth,
  launchBandwidth,
  preflightBandwidth,
  validateBandwidthJob,
} from "../bandwidth/service";
import { BANDWIDTH_CONCURRENCY } from "../bandwidth/store";
import type { BandwidthStore } from "../bandwidth/store";
import { logger } from "../logger";

/** Shared dashboard/Raycast API; no credentials or raw device output enter saved state. */
export async function bandwidthRoutes(
  req: Request,
  url: URL,
  getStore: () => Promise<BandwidthStore> = bandwidthStore,
): Promise<Response | null> {
  if (url.pathname !== "/api/bandwidth" && !url.pathname.startsWith("/api/bandwidth/")) return null;
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  try {
    const store = await getStore();
    store.recover(Date.now());
    if (req.method === "GET" && url.pathname === "/api/bandwidth") {
      return json({
        jobs: store.jobs().filter(canReadBandwidth),
        runs: store.runs().filter((r) => canReadBandwidth(r.job)),
        devices: bandwidthDevices(),
        concurrency: BANDWIDTH_CONCURRENCY,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/bandwidth/notifications") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        return json({ error: "Invalid notification cursor or limit" }, 400);
      const feed = store.notifications(after, limit);
      return json({ ...feed, events: feed.events.filter((e) => canReadBandwidth(e.run.job)) });
    }
    if (req.method === "GET" && url.pathname === "/api/bandwidth/options") {
      const device = url.searchParams.get("device");
      if (!device || !bandwidthDevices().includes(device))
        return json({ error: "Select an allowed router" }, 400);
      return json({ addresses: await bandwidthAddresses(device) });
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = JSON.parse(await readOperationBody(req));
    if (url.pathname === "/api/bandwidth/preflight") {
      const input = z.object({ job: z.unknown() }).strict().parse(body);
      return json(await preflightBandwidth(validateBandwidthJob(input.job)));
    }
    if (url.pathname === "/api/bandwidth/save") {
      const input = z
        .object({ job: z.unknown(), acknowledgeImpact: z.boolean().optional() })
        .strict()
        .parse(body);
      const job = validateBandwidthJob(input.job);
      bandwidthAccess(job, true);
      const previous = store.job(job.id);
      if (previous) bandwidthAccess(previous, true);
      if (job.enabled && input.acknowledgeImpact !== true)
        return json({ error: "Acknowledge bandwidth/CPU impact before enabling a schedule" }, 400);
      if (!previous && store.jobs().length >= 100)
        return json({ error: "Maximum 100 saved tests" }, 400);
      job.nextRunAt = Date.now() + job.intervalSeconds * 1000;
      store.save(job);
      return json({ job });
    }
    if (url.pathname === "/api/bandwidth/run" || url.pathname === "/api/bandwidth/delete") {
      const input = z
        .object({ id: z.string().min(1).max(64), acknowledgeImpact: z.boolean().optional() })
        .strict()
        .parse(body);
      const saved = store.job(input.id);
      if (!saved || !canReadBandwidth(saved)) return json({ error: "Saved test not found" }, 404);
      bandwidthAccess(saved, true);
      if (url.pathname.endsWith("/delete")) {
        store.remove(saved.id);
        return json({ removed: saved.id });
      }
      if (input.acknowledgeImpact !== true)
        return json({ error: "Acknowledge bandwidth/CPU impact before running" }, 400);
      const { run, done } = launchBandwidth(store, validateBandwidthJob(saved), "manual");
      void done.catch(() =>
        logger.error("Bandwidth completion could not be persisted; lease retained for recovery."),
      );
      return json({ run }, 202);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof DashboardInputError) return json({ error: error.message }, error.status);
    if (error instanceof BandwidthError) return json({ error: error.message }, 400);
    return json(
      { error: "Bandwidth operation unavailable. Check settings, access and local storage." },
      400,
    );
  }
}
