import { z } from "zod";
import { createHash } from "node:crypto";
import type { WorkspaceRecord } from "../operations/store";

export const recorderInput = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(30).max(300).default(60),
  windowMinutes: z.number().int().min(15).max(360).default(60),
  retentionDays: z.number().int().min(1).max(30).default(7),
});
export interface FlightSample {
  at: number;
  finishedAt: number;
  reachable: boolean | null;
  cpu?: number;
  memory?: number;
  interfaces: { name: string; running: boolean; rx?: number; tx?: number }[];
  gaps: string[];
}
export interface FlightEvent {
  id: string;
  at: number;
  source: "router-log" | "mcp" | "operator";
  title: string;
  routerTime?: string;
  risk?: string;
  failed?: boolean;
}
export interface FlightIncident {
  id: string;
  at: number;
  until: number;
  title: string;
  trigger: "manual" | "management" | "interface" | "resources";
  samples: FlightSample[];
  events: FlightEvent[];
  complete: boolean;
}
export interface FlightRecord extends WorkspaceRecord, z.infer<typeof recorderInput> {
  samples: FlightSample[];
  events: FlightEvent[];
  incidents: FlightIncident[];
  seenLogs: string[];
  lastAttempt?: number;
  error?: string;
}
export function blankFlight(device: string, now: number): FlightRecord {
  return {
    id: device,
    device,
    updatedAt: now,
    enabled: false,
    intervalSeconds: 60,
    windowMinutes: 60,
    retentionDays: 7,
    samples: [],
    events: [],
    incidents: [],
    seenLogs: [],
  };
}
/** Never persist raw router messages: scripts and application logs can contain arbitrary secrets. */
export function logEvidence(row: Record<string, unknown>, at: number): FlightEvent {
  const message = typeof row.message === "string" ? row.message : "";
  const topics = Array.isArray(row.topics)
    ? row.topics.filter((v): v is string => typeof v === "string").join(",")
    : typeof row.topics === "string"
      ? row.topics
      : "unknown";
  const title = /login failure|authentication failed/i.test(message)
    ? "Authentication failure reported"
    : /logged in/i.test(message)
      ? "Login reported"
      : /logged out/i.test(message)
        ? "Logout reported"
        : /link down|disconnected|terminating/i.test(message)
          ? "Link or session interruption reported"
          : /link up|connected/i.test(message)
            ? "Link or session connection reported"
            : /changed|added|removed|disabled|enabled/i.test(message)
              ? "Configuration activity reported"
              : "Router event observed";
  return {
    id: createHash("sha256")
      .update(JSON.stringify([row[".id"], row.time, row.topics, message]))
      .digest("hex"),
    at,
    source: "router-log",
    title: `${title} · ${topics.replace(/[^a-zA-Z0-9,.-]/g, "").slice(0, 100)}`,
    routerTime: typeof row.time === "string" ? row.time.slice(0, 64) : undefined,
  };
}
export function detectFlightIncident(
  record: FlightRecord,
): Pick<FlightIncident, "title" | "trigger"> | undefined {
  const recent = record.samples.slice(-3),
    last = recent.at(-1),
    previous = recent.at(-2);
  if (!last) return;
  if (last.reachable === false && previous?.reachable === false)
    return { trigger: "management", title: "Two management reads failed" };
  if (
    previous &&
    last.interfaces.some(
      (i) => !i.running && previous.interfaces.some((p) => p.name === i.name && p.running),
    )
  )
    return { trigger: "interface", title: "An observed interface stopped running" };
  if (recent.length === 3 && recent.every((s) => (s.cpu ?? -1) >= 90))
    return { trigger: "resources", title: "Sustained CPU pressure observed" };
}
/** Persisted rolling windows and frozen incidents are bounded by count AND age. */
export function trimFlight(record: FlightRecord, now: number): FlightRecord {
  const since = now - record.windowMinutes * 60_000;
  record.samples = record.samples.filter((s) => s.at >= since).slice(-720);
  record.events = record.events.filter((s) => s.at >= since).slice(-500);
  record.seenLogs = record.seenLogs.slice(-500);
  record.incidents = record.incidents
    .filter((i) => i.at >= now - record.retentionDays * 86400_000)
    .slice(-30);
  for (const i of record.incidents) {
    i.samples = i.samples.slice(-720);
    i.events = i.events.slice(-500);
    i.complete = now >= i.until || !record.enabled;
  }
  record.updatedAt = now;
  return record;
}
export function freezeFlight(
  record: FlightRecord,
  title: string,
  trigger: FlightIncident["trigger"],
  now: number,
): FlightIncident {
  const incident: FlightIncident = {
    id: crypto.randomUUID(),
    at: now,
    until: record.enabled ? now + 120_000 : now,
    title,
    trigger,
    samples: structuredClone(record.samples),
    events: structuredClone(record.events),
    complete: !record.enabled,
  };
  record.incidents.push(incident);
  return incident;
}
