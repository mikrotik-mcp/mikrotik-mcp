import { z } from "zod";
import { Cmd, quoteValue } from "../core/routeros";
import { isYes } from "../utils/yes";

export const macInput = z.string().regex(/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i);
export const diagnosisInput = z.object({
  client: z.ipv4(),
  target: z
    .string()
    .max(253)
    .regex(/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i)
    .default("example.com"),
});
export const compareInput = z.object({
  target: z.ipv4(),
  tables: z.array(z.string().min(1).max(64)).min(1).max(3),
  goal: z.enum(["calls", "gaming", "download"]).default("calls"),
});
export const policyInput = z.object({
  mac: macInput,
  action: z.enum(["pause", "priority", "route"]),
  minutes: z.number().int().min(5).max(120).default(30),
  startInMinutes: z.number().int().min(0).max(1440).default(0),
  table: z.string().min(1).max(64).optional(),
});
export type PolicyInput = z.infer<typeof policyInput>;
export type Row = Record<string, string>;
export interface Finding {
  area: string;
  state: "observed" | "suspected" | "unknown";
  title: string;
  detail: string;
  next: string;
}
export interface HomeClient {
  mac: string;
  ip: string;
  hostname: string;
  name: string;
  person: string;
  firstSeen: number;
  lastSeen: number;
  acknowledged: boolean;
  present: boolean;
}
export interface PathSample {
  table: string;
  state: "observed" | "unknown";
  loss: number | null;
  latency: number | null;
  spread: number | null;
  note: string;
}
export interface Diagnosis {
  device: string;
  client: string;
  target: string;
  at: number;
  findings: Finding[];
  applicationHealth: "unverified";
}
export interface Comparison {
  device: string;
  at: number;
  target: string;
  goal: string;
  paths: PathSample[];
  recommended: string | null;
  explanation: string;
}
export interface PolicyPlan {
  id: string;
  device: string;
  input: PolicyInput;
  ip: string;
  createdAt: number;
  previewExpiresAt: number;
  fingerprint: string;
  commands: string[];
  undo: string[];
  warnings: string[];
  status: "preview" | "applying" | "scheduled" | "active" | "uncertain" | "undone";
  snapshot?: string;
  startsAt?: number;
  endsAt?: number;
  error?: string;
  queueBefore?: { name: string; target: string; parent: string; priority: string };
}
export function enabled(row: Row): boolean {
  return !isYes(row.disabled) && !/[XI]/.test(row.flags ?? "");
}
export function activeRoute(row: Row): boolean {
  return enabled(row) && (isYes(row.active) || /A/.test(row.flags ?? ""));
}
export function milliseconds(text: string | undefined): number | null {
  if (!text) return null;
  const units = [...text.matchAll(/(\d+(?:\.\d+)?)(us|ms|s)/g)];
  if (!units.length || units.map((m) => m[0]).join("") !== text) return null;
  return units.reduce(
    (sum, m) => sum + Number(m[1]) * (m[2] === "s" ? 1000 : m[2] === "us" ? 0.001 : 1),
    0,
  );
}
export function pingSample(table: string, raw: string): PathSample {
  const sent = Number(raw.match(/sent=(\d+)/)?.[1]);
  const received = Number(raw.match(/received=(\d+)/)?.[1]);
  const rtt = (key: string) => milliseconds(raw.match(new RegExp(`${key}-rtt=([^\\s]+)`))?.[1]);
  const min = rtt("min"),
    max = rtt("max");
  if (!Number.isFinite(sent) || sent < 1 || !Number.isFinite(received) || received > sent)
    return {
      table,
      state: "unknown",
      loss: null,
      latency: null,
      spread: null,
      note: "No usable ICMP summary. This RouterOS version may not support table-scoped ping.",
    };
  return {
    table,
    state: "observed",
    loss: ((sent - received) * 100) / sent,
    latency: rtt("avg"),
    spread: min === null || max === null ? null : Math.max(0, max - min),
    note: "Five router-originated ICMP probes; RTT range is not a client jitter or throughput measurement.",
  };
}
export function recommendPath(paths: PathSample[], goal: string): string | null {
  if (goal === "download") return null;
  const usable = paths.filter(
    (p) =>
      p.state === "observed" &&
      p.loss !== null &&
      p.loss < 100 &&
      p.latency !== null &&
      p.spread !== null,
  );
  const score = (p: PathSample) =>
    p.loss! * 1000 + p.latency! + p.spread! * (goal === "calls" ? 2 : 1);
  return usable.sort((a, b) => score(a) - score(b))[0]?.table ?? null;
}

/** Device-owned tags never interpolate arbitrary selectors or ordinal print indices. */
export function tagSelector(tag: string): string {
  return `[find where comment=${quoteValue(tag)}]`;
}
export function namedSelector(name: string): string {
  return `[find where name=${quoteValue(name)}]`;
}

/** Expiring dynamic markers are the clock: a reboot also expires the lease. No host timer is required. */
export function temporaryCommands(
  id: string,
  input: PolicyInput,
  ip: string,
  setup: string[],
  activate: string[],
  revert: string[],
) {
  const tag = `mcp-home-${id}`;
  const clearMarkers = new Cmd(`/ip firewall address-list remove ${tagSelector(tag)}`).build();
  const clearScheduler = new Cmd(`/system scheduler remove ${tagSelector(tag)}`).build();
  const undo = [...revert, clearMarkers, clearScheduler];
  const leaseMatch = `[/ip dhcp-server lease find where mac-address=${quoteValue(input.mac)} address=${quoteValue(ip)} dynamic=no status=bound]`;
  const expired = `([:len [/ip firewall address-list find where list=${quoteValue(`${tag}-end`)}]] = 0 || [:len ${leaseMatch}] != 1)`;
  const waiting = `[:len [/ip firewall address-list find where list=${quoteValue(`${tag}-start`)}]] = 0`;
  // A lost/rebooted marker always wins over activation; repeated cleanup is safe.
  const tick = `:if (${expired}) do={ ${undo.join("; ")} } else={ :if (${waiting}) do={ ${activate.join("; ")} } }`;
  const commands = [
    ...setup,
    new Cmd("/ip firewall address-list add")
      .set("list", `${tag}-end`)
      .set("address", ip)
      .set("timeout", `${input.minutes + input.startInMinutes}m`)
      .set("comment", tag)
      .build(),
    ...(input.startInMinutes
      ? [
          new Cmd("/ip firewall address-list add")
            .set("list", `${tag}-start`)
            .set("address", ip)
            .set("timeout", `${input.startInMinutes}m`)
            .set("comment", tag)
            .build(),
        ]
      : []),
    new Cmd("/system scheduler add")
      .set("name", tag)
      .set("comment", tag)
      .set("interval", "30s")
      .set("start-time", "startup")
      .set("policy", "read,write")
      .set("on-event", tick)
      .build(),
    new Cmd("/system scheduler add")
      .set("name", `${tag}-boot`)
      .set("comment", tag)
      .set("interval", "0s")
      .set("start-time", "startup")
      .set("policy", "read,write")
      .set("on-event", tick)
      .build(),
    ...(!input.startInMinutes ? activate : []),
  ];
  return { commands, undo };
}
