import { operationsStore } from "../operations/store";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { createContext } from "../core/context";
import type { ToolContext } from "../core/context";
import { checkedRead, rows } from "../home/read";
import { parseSystemResource } from "../core/routeros-parse";
import { getSafeModeManager } from "../ssh/safe-mode";
import { subscribe, isRecording } from "../observability/recorder";
import type { ToolEvent } from "../observability/event";
import {
  recorderInput,
  blankFlight,
  logEvidence,
  detectFlightIncident,
  freezeFlight,
  trimFlight,
} from "./model";
import type { FlightRecord, FlightSample, FlightEvent } from "./model";

const kind = "flight-recorder";
const queues = new Map<string, Promise<unknown>>();
function access(ctx: ToolContext, tool: string, write = false) {
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], tool, write ? "WRITE" : "READ");
  return device;
}
async function record(device: string): Promise<FlightRecord> {
  return (
    (await operationsStore()).get<FlightRecord>(kind, device, device) ??
    blankFlight(device, Date.now())
  );
}
/** Serialize local updates and refuse another process holding the same capture record. */
async function edit<T>(device: string, work: (r: FlightRecord) => Promise<T>): Promise<T> {
  const task = (queues.get(device) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const store = await operationsStore(),
        owner = crypto.randomUUID(),
        key = `flight:${device}`;
      store.lock(key, owner);
      try {
        const r = await record(device),
          result = await work(r);
        store.put(kind, trimFlight(r, Date.now()));
        return result;
      } finally {
        store.unlock(key, owner);
      }
    });
  queues.set(device, task);
  try {
    return await task;
  } finally {
    if (queues.get(device) === task) queues.delete(device);
  }
}
export async function getFlight(ctx: ToolContext) {
  const device = access(ctx, "get_flight_recorder");
  return {
    recorder: trimFlight(await record(device), Date.now()),
    toolEventsAvailable: isRecording(),
    limitations: [
      "SSH-polled log metadata, not a lossless syslog receiver.",
      "Receive-time correlation is not proof of cause or actor identity.",
      "No capture while MCP is stopped; missing observations are not healthy samples.",
    ],
  };
}
export async function configureFlight(input: unknown, ctx: ToolContext) {
  const device = access(ctx, "configure_flight_recorder", true),
    a = recorderInput.parse(input);
  await edit(device, async (r) => {
    Object.assign(r, a);
    r.error = undefined;
  });
  return getFlight(ctx);
}
export async function freezeIncident(title: string, ctx: ToolContext) {
  const device = access(ctx, "freeze_network_incident", true);
  if (!title.trim() || title.length > 120) throw new Error("Use a 1–120 character incident title.");
  await edit(device, async (r) => {
    freezeFlight(r, title.trim(), "manual", Date.now());
  });
  return getFlight(ctx);
}
export async function exportIncident(id: string, ctx: ToolContext) {
  const device = access(ctx, "export_network_incident"),
    r = await record(device);
  const incident = trimFlight(r, Date.now()).incidents.find((i) => i.id === id);
  if (!incident) throw new Error("Incident not found on the selected router or retention expired.");
  return {
    format: "mikrotik-flight-recorder/v1",
    device,
    exportedAt: Date.now(),
    incident,
    privacy:
      "Review device/interface names before sharing. Raw logs, commands, arguments and credentials are excluded.",
    interpretation:
      "Chronology is receipt time on the MCP host. Correlation is not causation; routerTime is untrusted, uncorrected router text.",
  };
}
const numeric = (v?: string) =>
  v && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : undefined;
/** Static bounded RouterOS script: IDs captured once; at most 50 messages leave the router. */
export const FLIGHT_LOG_COMMAND =
  ":local ids [/log find]; :local n [:len $ids]; :local start ($n - 50); :if ($start < 0) do={ :set start 0 }; :foreach id in=[:pick $ids $start $n] do={ :put [:serialize to=json value=[/log get $id]] }";
export async function sampleFlight(device: string): Promise<void> {
  const ctx = createContext(undefined, device);
  access(ctx, "get_flight_recorder");
  await edit(device, async (r) => {
    if (!r.enabled || Date.now() - (r.lastAttempt ?? 0) < r.intervalSeconds * 1000) return;
    const now = Date.now();
    r.lastAttempt = now;
    const sample: FlightSample = {
      at: now,
      finishedAt: now,
      reachable: null,
      interfaces: [],
      gaps: [],
    };
    const events: FlightEvent[] = [];
    if (getSafeModeManager(device).isActive)
      sample.gaps.push("Capture skipped: router is in Safe Mode.");
    else {
      try {
        const resource = parseSystemResource(await checkedRead("/system resource print", ctx));
        if (!resource || !Number.isFinite(resource.cpuLoad)) throw new Error("No resource sample");
        sample.reachable = true;
        sample.cpu = resource.cpuLoad;
        if (
          resource.totalMemory !== undefined &&
          resource.totalMemory > 0 &&
          resource.freeMemory !== undefined
        )
          sample.memory = Math.round((1 - resource.freeMemory / resource.totalMemory) * 100);
      } catch {
        sample.reachable = false;
        sample.gaps.push("Management read failed; network outage is not established.");
      }
      if (sample.reachable) {
        try {
          const interfaces = await rows("/interface", "name,running,disabled,rx-byte,tx-byte", ctx);
          if (interfaces.length > 64) sample.gaps.push("Interface inventory capped at 64 entries.");
          sample.interfaces = interfaces
            .filter((i) => !["yes", "true"].includes(i.disabled) && !(i.flags ?? "").includes("X"))
            .slice(0, 64)
            .map((i) => ({
              name: (i.name ?? "unknown").slice(0, 100),
              running: ["yes", "true"].includes(i.running) || (i.flags ?? "").includes("R"),
              rx: numeric(i["rx-byte"]),
              tx: numeric(i["tx-byte"]),
            }));
        } catch {
          sample.gaps.push("Interface state unavailable.");
        }
        try {
          const raw = await checkedRead(FLIGHT_LOG_COMMAND, ctx);
          const logs = raw.trim()
            ? raw
                .trim()
                .split(/\r?\n/)
                .map((line) => JSON.parse(line) as Record<string, string>)
            : [];
          if (logs.length > 50) throw new Error("Log cap exceeded");
          for (const row of logs) {
            const e = logEvidence(row, Date.now());
            if (!r.seenLogs.includes(e.id)) {
              events.push(e);
              r.seenLogs.push(e.id);
            }
          }
          if (logs.length === 50)
            sample.gaps.push(
              "Only the newest 50 router log entries were checked; earlier entries may be missing.",
            );
        } catch {
          sample.gaps.push("Router log collection unavailable or unsupported.");
        }
      }
    }
    sample.finishedAt = Date.now();
    r.samples.push(sample);
    r.events.push(...events);
    for (const incident of r.incidents.filter((i) => !i.complete && now <= i.until)) {
      incident.samples.push(sample);
      incident.events.push(...events);
    }
    const trigger = detectFlightIncident(r);
    if (trigger && now - (r.incidents.at(-1)?.at ?? 0) >= 300_000)
      freezeFlight(r, trigger.title, trigger.trigger, now);
    r.error = sample.gaps.length ? sample.gaps.join(" ") : undefined;
  });
}
export async function recordFlightTool(event: ToolEvent): Promise<void> {
  if (!event.device || (event.risk === "READ" && !event.isError)) return;
  const device = access(createContext(undefined, event.device), "get_flight_recorder");
  await edit(device, async (r) => {
    if (!r.enabled) return;
    const e: FlightEvent = {
      id: `mcp:${event.id}`,
      at: Date.now(),
      source: "mcp",
      title: event.tool.slice(0, 100),
      risk: event.risk,
      failed: event.isError,
    };
    r.events.push(e);
    for (const i of r.incidents.filter((i) => !i.complete && e.at <= i.until)) i.events.push(e);
  });
}
let timer: ReturnType<typeof setInterval> | undefined,
  unsubscribe: (() => void) | undefined,
  ticking = false;
export function startFlightRecorder(): void {
  if (timer) return;
  unsubscribe = subscribe((e) => {
    void recordFlightTool(e).catch(() => {});
  });
  timer = setInterval(() => {
    void flightTick().catch(() => {});
  }, 5000);
  timer.unref();
}
export function stopFlightRecorder(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
}
export async function flightTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const device of Object.keys(getConfig().devices)) {
      try {
        const r = await record(device);
        if (r.enabled) await sampleFlight(device);
        else if (
          r.samples.length + r.events.length + r.incidents.length > 0 &&
          Date.now() - r.updatedAt > 60000
        )
          await edit(device, async () => {});
      } catch {
        /* A denied/deleted router is never resolved to the default device. */
      }
    }
  } finally {
    ticking = false;
  }
}
