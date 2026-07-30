/**
 * Scheduling and regression maths. PURE — `now` is always a parameter, so every
 * temporal behaviour is testable without waiting for a clock.
 *
 * Two independent jobs live here:
 *
 * 1. **A restricted cron parser.** Five fields: `*`, step syntax, ranges and lists —
 *    no `@yearly`, no seconds, no `L`/`W`. That covers every realistic audit
 *    schedule in about a hundred lines, and avoids a dependency whose whole
 *    surface would then have to be trusted.
 * 2. **The finding diff.** This is the feature: a nightly audit that reports 40
 *    findings is ignored by week two, so the unit of notification is the DELTA —
 *    new, worsened, resolved — and everything unchanged stays silent.
 */
import { z } from "zod";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

/** Lower index = worse. Used to decide whether a finding got worse. */
function rank(severity: string): number {
  const i = SEVERITY_ORDER.indexOf(severity as Severity);
  // An unknown severity sorts last, so it can never masquerade as critical.
  return i === -1 ? SEVERITY_ORDER.length : i;
}

// ── Cron ────────────────────────────────────────────────────────────────────

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** True when the field was `*` — needed for POSIX's dom/dow OR rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
  name: string;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Parse one cron field into the concrete values it allows. */
function parseField(text: string, spec: FieldSpec): number[] {
  const values = new Set<number>();

  for (const part of text.split(",")) {
    const piece = part.trim();
    if (piece === "") throw new Error(`empty ${spec.name} field`);

    const [range, stepText] = piece.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new TypeError(`invalid step '${stepText}' in ${spec.name}`);
    }

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((n) => Number(n));
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new TypeError(`invalid range '${range}' in ${spec.name}`);
      }
      lo = a;
      hi = b;
    } else {
      const value = Number(range);
      if (!Number.isInteger(value)) throw new TypeError(`invalid ${spec.name} '${range}'`);
      lo = value;
      hi = value;
    }

    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`${spec.name} '${piece}' is outside ${spec.min}-${spec.max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return [...values].sort((a, b) => a - b);
}

/** Parse a five-field cron expression. Throws with a usable message. */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }
  const [minute, hour, dom, month, dow] = parts;
  return {
    minutes: parseField(minute, FIELDS[0]),
    hours: parseField(hour, FIELDS[1]),
    daysOfMonth: parseField(dom, FIELDS[2]),
    months: parseField(month, FIELDS[3]),
    daysOfWeek: parseField(dow, FIELDS[4]),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this date match the schedule?
 *
 * POSIX quirk, implemented deliberately: when BOTH day-of-month and day-of-week
 * are restricted, a date matching EITHER runs. `0 0 1 * 1` is "the 1st, and every
 * Monday" — not "Mondays that fall on the 1st".
 */
function dateMatches(cron: CronFields, date: Date): boolean {
  if (!cron.months.includes(date.getMonth() + 1)) return false;
  const domHit = cron.daysOfMonth.includes(date.getDate());
  const dowHit = cron.daysOfWeek.includes(date.getDay());
  if (cron.domRestricted && cron.dowRestricted) return domHit || dowHit;
  if (cron.domRestricted) return domHit;
  if (cron.dowRestricted) return dowHit;
  return true;
}

/**
 * The next time this schedule fires, strictly after `from` (epoch ms).
 *
 * Walks LOCAL time minute by minute, skipping whole days and hours that cannot
 * match. Local time is deliberate: "03:00 nightly" means 03:00 where the operator
 * lives, and a DST jump therefore shifts the wall-clock run — which is what
 * everyone actually expects from cron.
 *
 * Returns null when nothing matches within a year (e.g. `0 0 30 2 *`).
 */
export function nextRun(expression: string, from: number): number | null {
  const cron = parseCron(expression);
  const start = new Date(from);
  // Start at the next whole minute: a schedule never fires twice in one minute.
  const cursor = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
    start.getHours(),
    start.getMinutes() + 1,
    0,
    0,
  );

  const limit = from + 366 * 24 * 3600_000;
  while (cursor.getTime() <= limit) {
    if (!dateMatches(cron, cursor)) {
      // Skip to midnight of the next day rather than crawling 1440 minutes.
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.includes(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.includes(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor.getTime();
  }
  return null;
}

function list(values: number[], names?: string[], total?: number): string {
  if (total !== undefined && values.length === total) return "every";
  const render = (v: number): string => (names ? names[v] : String(v));
  if (values.length === 1) return render(values[0]);
  if (values.length === 2) return `${render(values[0])} and ${render(values[1])}`;
  return `${values.slice(0, -1).map(render).join(", ")} and ${render(values[values.length - 1])}`;
}

/** Is this an evenly-spaced step set covering the whole range (e.g. every 15)? */
function stride(values: number[], min: number, max: number): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1] - values[0];
  if (step < 2) return null;
  for (let i = 1; i < values.length; i++) {
    if (values[i] - values[i - 1] !== step) return null;
  }
  return values[values.length - 1] + step > max ? step : null;
}

/**
 * Plain-English rendering of a cron expression.
 *
 * A small touch that removes a whole class of misconfiguration: `0 3 * * 1` and
 * `3 0 * * 1` differ by two characters and by twenty-one hours, and a human
 * reading "every Monday at 03:00" catches the mistake immediately.
 */
export function describeCron(expression: string): string {
  let cron: CronFields;
  try {
    cron = parseCron(expression);
  } catch (e) {
    return `invalid schedule (${e instanceof Error ? e.message : String(e)})`;
  }

  const pad = (n: number): string => String(n).padStart(2, "0");
  const minuteStride = stride(cron.minutes, 0, 59);
  const hourStride = stride(cron.hours, 0, 23);

  // Time of day.
  let time: string;
  if (minuteStride !== null && cron.hours.length === 24) {
    time = `every ${minuteStride} minutes`;
  } else if (cron.minutes.length === 60 && cron.hours.length === 24) {
    time = "every minute";
  } else if (cron.minutes.length === 60) {
    time = `every minute of ${list(cron.hours)}:00`;
  } else if (hourStride !== null && cron.minutes.length === 1) {
    time = `every ${hourStride} hours at :${pad(cron.minutes[0])}`;
  } else if (cron.hours.length === 24 && cron.minutes.length === 1) {
    time = `hourly at :${pad(cron.minutes[0])}`;
  } else {
    const times = cron.hours.flatMap((h) => cron.minutes.map((m) => `${pad(h)}:${pad(m)}`));
    time = `at ${list(
      times.map((_, i) => i),
      times,
    )}`;
  }

  // Which days.
  const parts: string[] = [];
  if (cron.dowRestricted) {
    parts.push(`on ${list(cron.daysOfWeek, DAY_NAMES)}`);
  }
  if (cron.domRestricted) {
    parts.push(`on day ${list(cron.daysOfMonth)} of the month`);
  }
  if (cron.months.length !== 12) {
    parts.push(
      `in ${list(
        cron.months.map((m) => m - 1),
        MONTH_NAMES,
      )}`,
    );
  }
  if (parts.length === 0) {
    // Only say "every day" when the time is a specific moment, not a frequency.
    if (!time.startsWith("every")) parts.push("every day");
  }

  return [time, ...parts].join(" ").trim();
}

// ── Finding diff ────────────────────────────────────────────────────────────

/** The shape every auditor's findings are reduced to for comparison. */
export interface AuditFinding {
  /**
   * Stable, content-derived identity. NOT a row index: a reordered config would
   * otherwise read as a completely new set of findings, and the whole feature
   * would emit noise on every run.
   */
  id: string;
  severity: string;
  title: string;
  device?: string;
  detail?: string;
}

export interface FindingDiff {
  added: AuditFinding[];
  resolved: AuditFinding[];
  /** Findings still present whose severity got worse, with both severities. */
  worsened: { finding: AuditFinding; from: string; to: string }[];
  /** Still present and no worse — deliberately silent. */
  unchanged: AuditFinding[];
  /** Still present and less severe than before — a quiet win. */
  improved: { finding: AuditFinding; from: string; to: string }[];
}

/**
 * Compare two runs.
 *
 * Identity is the `id` alone. A finding whose text changed but whose id did not
 * is the SAME finding — that is the point of a content-derived id, and it is why
 * a reordered config produces an all-unchanged diff.
 */
export function diffFindings(previous: AuditFinding[], next: AuditFinding[]): FindingDiff {
  const before = new Map(previous.map((f) => [f.id, f]));
  const after = new Map(next.map((f) => [f.id, f]));

  const added: AuditFinding[] = [];
  const unchanged: AuditFinding[] = [];
  const worsened: { finding: AuditFinding; from: string; to: string }[] = [];
  const improved: { finding: AuditFinding; from: string; to: string }[] = [];

  for (const [id, finding] of after) {
    const old = before.get(id);
    if (!old) {
      added.push(finding);
      continue;
    }
    const delta = rank(finding.severity) - rank(old.severity);
    if (delta < 0) worsened.push({ finding, from: old.severity, to: finding.severity });
    else if (delta > 0) improved.push({ finding, from: old.severity, to: finding.severity });
    else unchanged.push(finding);
  }

  const resolved = previous.filter((f) => !after.has(f.id));
  return { added, resolved, worsened, unchanged, improved };
}

export type NotifyOn = "new" | "worsened" | "resolved" | "improved";

/**
 * Is this diff worth telling someone about, given what the job asked for?
 *
 * `unchanged` is never notifiable. A finding that has been there for a month is
 * not news, and reporting it is how an alerting system gets muted.
 */
export function shouldNotify(diff: FindingDiff, notifyOn: NotifyOn[]): boolean {
  if (notifyOn.includes("new") && diff.added.length > 0) return true;
  if (notifyOn.includes("worsened") && diff.worsened.length > 0) return true;
  if (notifyOn.includes("resolved") && diff.resolved.length > 0) return true;
  if (notifyOn.includes("improved") && diff.improved.length > 0) return true;
  return false;
}

/** One-line summary of a diff, for a notification subject. */
export function describeDiff(diff: FindingDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${diff.added.length} new`);
  if (diff.worsened.length > 0) parts.push(`${diff.worsened.length} worsened`);
  if (diff.resolved.length > 0) parts.push(`${diff.resolved.length} resolved`);
  if (diff.improved.length > 0) parts.push(`${diff.improved.length} improved`);
  if (parts.length === 0) {
    return `no change (${diff.unchanged.length} finding(s) still open)`;
  }
  return `${parts.join(", ")} (${diff.unchanged.length} unchanged)`;
}

/** The worst severity present, for a posture headline. */
export function worstSeverity(findings: AuditFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  return findings.reduce(
    (worst, f) => (rank(f.severity) < rank(worst) ? f.severity : worst),
    findings[0].severity,
  );
}

/** Count findings by severity — the posture timeline's y-axis. */
export function severityCounts(findings: AuditFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

// ── Job definition ──────────────────────────────────────────────────────────

/**
 * A job definition, as written in the `schedules` config block or passed to
 * `add_schedule`.
 *
 * The cron expression is validated HERE rather than at first fire: a typo in a
 * config file must fail loudly at load, not become a job that silently never
 * runs and is discovered weeks later when someone asks why nothing was audited.
 */
export const JobSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/i, "use letters, digits and hyphens"),
  cron: z.string().refine(isValidCron, "not a valid 5-field cron expression"),
  tool: z.string().min(1),
  devices: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]).default("all"),
  notifyOn: z
    .array(z.enum(["new", "worsened", "resolved", "improved"]))
    .default(["new", "worsened"]),
  args: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
  retainDays: z.coerce.number().int().positive().default(90),
});
export type JobDefinition = z.infer<typeof JobSchema>;
