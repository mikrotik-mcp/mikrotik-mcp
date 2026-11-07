import { join, dirname } from "node:path";
import { getConfig, getDevice, listDevices, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { executeMikrotikCommand, executeMikrotikJson } from "../core/connector";
import { createContext } from "../core/context";
import { Cmd, looksLikeError } from "../core/routeros";
import { parseKeyValues } from "../core/routeros-parse";
import { getSafeModeManager } from "../ssh/safe-mode";
import { bandwidthServerTools } from "../tools/tool-bandwidth-server";
import { logger } from "../logger";
import {
  BandwidthJobSchema,
  bandwidthCommand,
  expectedRoute,
  parseBandwidthResult,
  PATH_WARNING,
} from "./model";
import { openBandwidthStore } from "./store";
import type { BandwidthStore } from "./store";
import type { BandwidthJob, BandwidthRun, BandwidthPreflight } from "./types";

/** Fixed operator messages, never transport output or credential-bearing command text. */
export class BandwidthError extends Error {}

/** Canonical device keys ensure aliases cannot bypass same-router checks. */
export function validateBandwidthJob(input: unknown): BandwidthJob {
  const parsed = BandwidthJobSchema.safeParse(input);
  if (!parsed.success)
    throw new BandwidthError(
      "Invalid test settings. Check IPv4 addresses, IDs, bounded duration/rates and interval (whole milliseconds).",
    );
  const job = { ...parsed.data, nextRunAt: parsed.data.nextRunAt ?? 0 };
  try {
    job.source = resolveDeviceName(job.source);
    job.destination = resolveDeviceName(job.destination);
    if (routerIdentity(job.source) === routerIdentity(job.destination))
      throw new Error("Source and destination resolve to the same router");
  } catch {
    throw new BandwidthError("Select two different enabled configured routers.");
  }
  for (const address of [job.sourceAddress, job.destinationAddress]) {
    const first = Number(address.split(".")[0]);
    if (first === 0 || first === 127 || first >= 224 || address === "255.255.255.255")
      throw new BandwidthError("Use unicast tunnel IPv4 addresses.");
  }
  if (job.sourceAddress === job.destinationAddress)
    throw new BandwidthError("Source and destination addresses must differ.");
  return job;
}

/** Config aliases to one management endpoint share a lock. */
export function routerIdentity(name: string): string {
  const dc = getDevice(name);
  return dc.mac ? `mac:${dc.mac.toLowerCase()}` : `host:${dc.host.toLowerCase()}`;
}

/** Apply the same scope and read-only policy to HTTP and unattended work. */
export function bandwidthAccess(
  job: Pick<BandwidthJob, "source" | "destination">,
  write: boolean,
): void {
  try {
    assertDeviceAccess([job.source, job.destination], "bandwidth_test", write ? "WRITE" : "READ");
  } catch {
    throw new BandwidthError("Bandwidth test access denied by server policy or read-only mode.");
  }
}

/** Inventory is read only and is loaded only on an explicit operator request. */
export async function bandwidthAddresses(
  device: string,
): Promise<{ interface: string; address: string }[]> {
  assertDeviceAccess([device], "bandwidth_test", "READ");
  const out = await executeMikrotikJson(
    new Cmd("/ip address print").raw("detail").build(),
    createContext(undefined, device),
    { maxMs: 20_000 },
  );
  return out.rows
    .filter(
      (row) =>
        row.address &&
        row.interface &&
        !/[XI]/.test(row.flags ?? "") &&
        row.disabled !== "true" &&
        row.disabled !== "yes" &&
        row.invalid !== "true",
    )
    .map((row) => ({ interface: row.interface, address: row.address.split("/")[0] }));
}

/** Prove current addressing and a unique main-table path without changing either router. */
export async function preflightBandwidth(job: BandwidthJob): Promise<BandwidthPreflight> {
  bandwidthAccess(job, false);
  const checks: BandwidthPreflight["checks"] = [];
  const check = (name: string, ok: boolean, message: string) => checks.push({ name, ok, message });
  try {
    const source = getDevice(job.source);
    const safe = getSafeModeManager(job.source);
    check(
      "transport",
      !source.mac && !source.api && !safe.isActive && !safe.requiresRecovery,
      "Source must use SSH without REST or an active/recovering Safe Mode session, to enforce the test deadline.",
    );
    const addresses = await bandwidthAddresses(job.source);
    check(
      "source-address",
      addresses.some((a) => a.interface === job.sourceInterface && a.address === job.sourceAddress),
      "Expected source address must be assigned and enabled on the selected interface.",
    );
    const interfaces = await executeMikrotikJson(
      new Cmd("/interface print").raw("detail").build(),
      createContext(undefined, job.source),
      { maxMs: 20_000 },
    );
    check(
      "source-interface",
      interfaces.rows.some(
        (r) =>
          r.name === job.sourceInterface &&
          (r.running === "true" || r.running === "yes" || /R/.test(r.flags ?? "")) &&
          !/X/.test(r.flags ?? "") &&
          r.disabled !== "true" &&
          r.disabled !== "yes",
      ),
      "Expected source interface must be enabled and running.",
    );
    const destination = await bandwidthAddresses(job.destination);
    check(
      "destination-address",
      destination.some((a) => a.address === job.destinationAddress),
      "Explicit destination IP must belong to the selected destination router.",
    );
    const routes = await executeMikrotikJson(
      new Cmd("/ip route print").raw("detail").build(),
      createContext(undefined, job.source),
      { maxMs: 20_000 },
    );
    check(
      "route",
      expectedRoute(job, routes.rows),
      "Require one active longest-prefix main-table route via the selected interface; if pref-src is present it must match. ECMP/unknown paths are refused. Policy routing and firewall delivery are not proven.",
    );
    const raw = await bandwidthServerTools[0].handler(
      {},
      createContext(undefined, job.destination),
    );
    const server = typeof raw === "string" ? parseKeyValues(raw) : {};
    check(
      "server",
      typeof raw === "string" && !looksLikeError(raw) && ["yes", "true"].includes(server.enabled),
      "Destination bandwidth server must already be enabled. No server or firewall settings will be changed.",
    );
    const destinationConfig = getDevice(job.destination);
    const credentials = destinationConfig.bandwidthAuth ?? destinationConfig;
    check(
      "authentication",
      ["no", "false"].includes(server.authenticate) ||
        (["yes", "true"].includes(server.authenticate) &&
          !!credentials.username &&
          !!credentials.password &&
          credentials.password.length <= 32),
      "Authenticated tests use destination credentials from server configuration at execution time. SSH keys cannot authenticate bandwidth-test; the password must be 1–32 characters. No password is collected or persisted here.",
    );
  } catch {
    check(
      "read",
      false,
      "Read-only preflight could not finish. Check connection, permissions and RouterOS support.",
    );
  }
  return { ready: checks.length > 0 && checks.every((c) => c.ok), checks, warning: PATH_WARNING };
}

export interface BandwidthExecutor {
  preflight(job: BandwidthJob): Promise<BandwidthPreflight>;
  measure(job: BandwidthJob): Promise<ReturnType<typeof parseBandwidthResult>>;
}

/** Reuse the connector and command builder, without exposing password-bearing diagnostics. */
const liveExecutor: BandwidthExecutor = {
  preflight: preflightBandwidth,
  async measure(job) {
    bandwidthAccess(job, true);
    const dc = getDevice(job.source);
    const safe = getSafeModeManager(job.source);
    if (dc.mac || dc.api || safe.isActive || safe.requiresRecovery)
      throw new BandwidthError("Source transport changed; rerun preflight.");
    const destination = getDevice(job.destination);
    const auth = destination.bandwidthAuth ?? destination;
    const credentials = auth.password
      ? { username: auth.username, password: auth.password }
      : undefined;
    // The connector's progress logger includes the command. Suppress it for this credential-bearing call.
    const ctx = { device: job.source, info: () => {}, error: () => {} };
    const raw = await executeMikrotikCommand(bandwidthCommand(job, credentials), ctx, {
      maxMs: job.durationSeconds * 1000 + 12_000,
    });
    return parseBandwidthResult(raw, job.direction);
  },
};

const outstanding = new Set<Promise<void>>();
let stopping = false;

/** Claim work synchronously before launching it, so HTTP retries cannot overlap a router. */
export function launchBandwidth(
  store: BandwidthStore,
  job: BandwidthJob,
  trigger: BandwidthRun["trigger"],
  executor = liveExecutor,
  now = Date.now(),
): { run: BandwidthRun; done: Promise<void> } {
  if (stopping) throw new BandwidthError("Bandwidth service is shutting down.");
  bandwidthAccess(job, true);
  const source = routerIdentity(job.source);
  const destination = routerIdentity(job.destination);
  const run: BandwidthRun = {
    id: crypto.randomUUID(),
    job,
    startedAt: now,
    finishedAt: null,
    status: "running",
    trigger,
    txBps: null,
    rxBps: null,
    lostPackets: null,
    message: "Read-only preflight in progress.",
  };
  if (!store.claim(run, source, destination, now))
    throw new BandwidthError(
      "Routers are busy, concurrency limit reached, or this schedule was already claimed. Try later.",
    );
  const done = (async () => {
    const heartbeat = setInterval(() => {
      try {
        store.renew(run.id, Date.now());
      } catch {
        /* original lease remains until the bounded run settles */
      }
    }, 10_000);
    heartbeat.unref?.();
    try {
      const preflight = await executor.preflight(job);
      if (!preflight.ready) {
        run.status = "failed";
        run.message = preflight.checks
          .filter((c) => !c.ok)
          .map((c) => c.message)
          .join(" ");
      } else {
        bandwidthAccess(job, true);
        if (
          source !== routerIdentity(job.source) ||
          destination !== routerIdentity(job.destination)
        )
          throw new BandwidthError("Router configuration changed during preflight; test refused.");
        Object.assign(run, await executor.measure(job));
      }
    } catch {
      run.status = "failed";
      run.message =
        "Test did not complete. Check access, transport, credentials and path preflight. Raw command/output is not stored.";
    } finally {
      clearInterval(heartbeat);
      run.finishedAt = Date.now();
      store.finish(run);
    }
  })();
  outstanding.add(done);
  void done.then(
    () => outstanding.delete(done),
    () => outstanding.delete(done),
  );
  return { run: { ...run }, done };
}

let storePromise: Promise<BandwidthStore> | undefined;
/** Keep bandwidth state beside the configured event database. */
export function bandwidthStore(): Promise<BandwidthStore> {
  storePromise ??= openBandwidthStore(
    join(dirname(getConfig().dashboard.dbPath), "bandwidth.db"),
  ).catch((error) => {
    storePromise = undefined;
    throw error;
  });
  return storePromise;
}
let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;

/** Dispatch due jobs once; missed intervals are coalesced instead of replayed on restart. */
export function tickBandwidth(
  store: BandwidthStore,
  executor = liveExecutor,
  now = Date.now(),
): Promise<void>[] {
  store.recover(now);
  const pending: Promise<void>[] = [];
  for (const job of store.jobs()) {
    if (!job.enabled || job.nextRunAt > now) continue;
    try {
      pending.push(
        launchBandwidth(store, validateBandwidthJob(job), "schedule", executor, now).done,
      );
    } catch {
      /* busy or disallowed jobs remain due, without generating traffic or an unbounded queue */
    }
  }
  return pending;
}

/** Start only host-side scheduling; an empty/disabled job list does no device I/O. */
export async function startBandwidthScheduler(): Promise<void> {
  if (timer) return;
  stopping = false;
  const store = await bandwidthStore();
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    try {
      for (const done of tickBandwidth(store))
        void done.catch(() =>
          logger.error("Bandwidth result could not be persisted; lease retained for recovery."),
        );
    } catch {
      logger.error("Bandwidth scheduler tick failed; retrying on next tick.");
    } finally {
      ticking = false;
    }
  }, 5000);
  timer.unref?.();
}
/** Stop dispatching; finite router durations and durable leases cover interrupted shutdowns. */
export async function stopBandwidthScheduler(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(outstanding),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 10_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  // If transport is still outstanding, leave SQLite and its leases intact until process exit.
  if (!outstanding.size && storePromise) {
    try {
      (await storePromise).close();
    } catch {
      /* startup may have failed */
    }
    storePromise = undefined;
  }
}

/** Hide jobs/results whose routers are outside the current access scope. */
export function canReadBandwidth(job: Pick<BandwidthJob, "source" | "destination">): boolean {
  try {
    bandwidthAccess(job, false);
    return true;
  } catch {
    return false;
  }
}
/** Device selectors reveal only configured devices permitted by the active policy. */
export function bandwidthDevices(): string[] {
  return listDevices().names.filter((name) =>
    canReadBandwidth({ source: name, destination: name }),
  );
}
