/**
 * Menu-bar cockpit — a live at-a-glance MikroTik fleet status that lives in the
 * macOS menu bar. The bar title encodes fleet health (online/total + an alert
 * badge, tinted green/amber/red); the dropdown shows per-device health, live
 * activity metrics, the most recent tool calls, alerts, and quick jumps into the
 * other commands or the web dashboard. Refreshes in the background on `interval`.
 */
import { useEffect } from "react";
import {
  Clipboard,
  Color,
  Icon,
  Keyboard,
  LaunchType,
  MenuBarExtra,
  launchCommand,
  open,
  openExtensionPreferences,
  updateCommandMetadata,
} from "@raycast/api";
import { withToken } from "./lib/api";
import { RISK_COLOR, clock, ms, num, riskLabel } from "./lib/format";
import { useApi } from "./lib/hooks";
import type {
  AlertSeverity,
  AlertsPayload,
  DeviceInfo,
  DevicesPayload,
  AttackIncidentRow,
  AttacksPayload,
  RolloutRecord,
  ScheduleJobRow,
  ScheduleRegression,
  Stats,
  ToolEvent,
} from "./lib/types";

/** Severity → menu-bar tint. Only the worst live severity is ever shown. */
const ALERT_TINT: Record<AlertSeverity, Color> = {
  low: Color.SecondaryText,
  medium: Color.Yellow,
  high: Color.Orange,
  critical: Color.Red,
};

/** Block an attacker from the menu bar. Always a dry run first — see below. */
async function blockAttacker(id: string, confirm: boolean): Promise<Response> {
  return fetch(withToken(`/api/attacks/${encodeURIComponent(id)}/respond`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
}

/** Trigger a scheduled audit off-schedule. Read-only — it runs a READ auditor. */
async function runSchedule(id: string): Promise<void> {
  await fetch(withToken(`/api/schedules/${encodeURIComponent(id)}/run`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/** Mute a rule for an hour from the menu bar — the one action worth one click. */
async function muteAlert(id: string): Promise<void> {
  await fetch(withToken(`/api/alerts/rules/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mute: "1h" }),
  });
}

type Health = "good" | "warn" | "bad" | "unknown";
const HEALTH_TINT: Record<Health, Color> = {
  good: Color.Green,
  warn: Color.Yellow,
  bad: Color.Red,
  unknown: Color.SecondaryText,
};

function open_(cmd: string) {
  return () => {
    launchCommand({ name: cmd, type: LaunchType.UserInitiated }).catch(
      () => {},
    );
  };
}

function pct(n: number | undefined): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}

export default function Command() {
  const devicesQ = useApi<DevicesPayload>("/api/devices");
  const statsQ = useApi<Stats>("/api/stats?window=3600000&buckets=1");
  const eventsQ = useApi<{ events: ToolEvent[] }>("/api/events?limit=6");
  const alertsQ = useApi<AlertsPayload>("/api/alerts");
  const rolloutQ = useApi<{ rollouts: RolloutRecord[] }>(
    "/api/rollout?limit=10",
  );
  const scheduleQ = useApi<{ jobs: ScheduleJobRow[] }>("/api/schedules");
  const regressionQ = useApi<{ regressions: ScheduleRegression[] }>(
    "/api/schedules/regressions?limit=3",
  );
  const attackQ = useApi<AttacksPayload>("/api/attacks?hours=24");

  const devices = devicesQ.data?.devices ?? [];
  const enabled = devices.filter((d) => !d.disabled);
  const online = enabled.filter((d) => d.status.reachable === true);
  const offline = enabled.filter((d) => d.status.reachable === false);
  const hot = enabled.filter(
    (d) => (d.status.cpuLoad ?? 0) >= 85 || (d.status.memUsedPct ?? 0) >= 85,
  );
  const total = enabled.length;
  const stats = statsQ.data;
  const events = eventsQ.data?.events ?? [];
  const firing = alertsQ.data?.active ?? [];
  // A fleet rollout in flight is worth a glyph of its own: it is the one thing
  // running unattended that changes routers, and knowing it is mid-flight (and
  // which wave) is the difference between watching it and finding out later.
  const rollouts = rolloutQ.data?.rollouts ?? [];
  const activeRollouts = rollouts.filter((r) => r.outcome === undefined);
  const stoppedRollouts = rollouts.filter(
    (r) => r.outcome === "halted" || r.outcome === "needs-attention",
  );
  // The menu-bar icon reports the WORST live severity. A menu bar has one glyph;
  // spending it on anything less than the most urgent thing wastes it.
  const worst: AlertSeverity | null =
    (["critical", "high", "medium", "low"] as const).find((s) =>
      firing.some((a) => a.severity === s),
    ) ?? null;
  const unreachable = !!devicesQ.error && !devicesQ.data;

  // Posture: open CRITICAL findings across every scheduled audit's latest run.
  // One number, because the menu bar has room for one — and if it is not zero,
  // nothing else on this list matters more.
  const jobs = scheduleQ.data?.jobs ?? [];
  const critical = jobs.reduce(
    (n, j) => n + (j.posture.bySeverity.critical ?? 0),
    0,
  );
  const regressions = regressionQ.data?.regressions ?? [];
  const lastRegression = regressions[0];

  // An attack in progress outranks everything else on this list. `confirmed`
  // means someone actually got in, so it gets the glyph and the tint.
  const incidents = attackQ.data?.incidents ?? [];
  const liveAttacks = incidents.filter(
    (i) => i.confidence === "confirmed" || i.confidence === "high",
  );
  const breached = incidents.some((i) => i.confidence === "confirmed");
  const detectOnly =
    attackQ.data?.posture.enabled === true &&
    attackQ.data.posture.mode === "detect";

  const alerts = offline.length + hot.length;
  const health: Health = unreachable
    ? "bad"
    : offline.length > 0
      ? "bad"
      : hot.length > 0 || (stats ? stats.errorRate >= 0.2 : false)
        ? "warn"
        : total > 0
          ? "good"
          : "unknown";

  const title = unreachable
    ? "offline"
    : total === 0
      ? "MikroTik"
      : `${online.length}/${total}${alerts > 0 ? ` ⚠${alerts}` : ""}${
          activeRollouts.length > 0 ? " ⟳" : ""
        }${critical > 0 ? ` ⚑${critical}` : ""}${
          liveAttacks.length > 0 ? ` ☣${liveAttacks.length}` : ""
        }`;

  // Keep the root-search subtitle in sync for background glances.
  useEffect(() => {
    if (unreachable) {
      updateCommandMetadata({ subtitle: "Dashboard unreachable" }).catch(
        () => {},
      );
    } else if (total > 0) {
      const rate = stats ? ` · ${stats.callsPerMin.toFixed(0)}/min` : "";
      updateCommandMetadata({
        subtitle: `${online.length}/${total} online${rate}`,
      }).catch(() => {});
    }
  }, [online.length, total, stats?.callsPerMin, unreachable]);

  function deviceDot(d: DeviceInfo): { source: Icon; tintColor: Color } {
    const r = d.status.reachable;
    const hotDev =
      (d.status.cpuLoad ?? 0) >= 85 || (d.status.memUsedPct ?? 0) >= 85;
    return {
      source: Icon.Dot,
      tintColor:
        r === false
          ? Color.Red
          : hotDev
            ? Color.Yellow
            : r === true
              ? Color.Green
              : Color.SecondaryText,
    };
  }

  return (
    <MenuBarExtra
      // Report loading whenever any query is revalidating — even with cached data
      // present. Raycast keeps a background (interval) run alive only while
      // `isLoading` is true; gating it on `!data` made the very first render (which
      // already has the disk-cached value) report "done", so Raycast snapshotted the
      // STALE title and killed the process before the refetch landed — the bar then
      // only updated when the dropdown was opened interactively. Keep-previous-data
      // means the title stays stable during the refresh, so there is no flicker.
      isLoading={devicesQ.isLoading || statsQ.isLoading || eventsQ.isLoading}
      icon={
        breached
          ? { source: Icon.ExclamationMark, tintColor: Color.Red }
          : worst
            ? { source: Icon.Bell, tintColor: ALERT_TINT[worst] }
            : { source: Icon.Wifi, tintColor: HEALTH_TINT[health] }
      }
      title={title}
      tooltip={
        unreachable
          ? "MikroTik MCP — dashboard unreachable"
          : worst
            ? `MikroTik MCP — ${firing.length} alert${firing.length === 1 ? "" : "s"} firing (${worst})`
            : `MikroTik MCP — ${online.length}/${total} online`
      }
    >
      {firing.length > 0 && (
        <MenuBarExtra.Section title={`Firing (${firing.length})`}>
          {firing.map((a) => (
            <MenuBarExtra.Item
              // A rule tracking several devices yields one row per device.
              key={`${a.id}:${a.subject}`}
              icon={{ source: Icon.Bell, tintColor: ALERT_TINT[a.severity] }}
              title={a.description ?? a.id}
              subtitle={
                a.subject === "*" ? a.severity : `${a.subject} · ${a.severity}`
              }
              onAction={() => void muteAlert(a.id)}
              tooltip="Mute this alert for 1 hour"
            />
          ))}
        </MenuBarExtra.Section>
      )}
      {activeRollouts.length > 0 || stoppedRollouts.length > 0 ? (
        <MenuBarExtra.Section title="Rollouts">
          {activeRollouts.map((r) => {
            const applied = r.devices.filter(
              (d) => d.stage === "applied",
            ).length;
            return (
              <MenuBarExtra.Item
                key={r.id}
                icon={{ source: Icon.Clock, tintColor: Color.Blue }}
                title={r.label ?? r.id}
                subtitle={`wave ${r.phase} · ${applied}/${r.devices.length} applied`}
                onAction={open_("change-plan")}
                tooltip="In flight — open Change Plan to hold or abort"
              />
            );
          })}
          {stoppedRollouts.map((r) => (
            <MenuBarExtra.Item
              key={r.id}
              icon={{
                source: Icon.Warning,
                tintColor:
                  r.outcome === "needs-attention" ? Color.Red : Color.Orange,
              }}
              title={r.label ?? r.id}
              subtitle={r.outcome}
              onAction={open_("change-plan")}
              tooltip={
                r.outcome === "needs-attention"
                  ? "A revert failed — restore the flagged device by hand"
                  : "Halted at a failed gate"
              }
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      {liveAttacks.length > 0 ? (
        <MenuBarExtra.Section title={`Attacks (${liveAttacks.length})`}>
          {liveAttacks.slice(0, 4).map((incident: AttackIncidentRow) => (
            <MenuBarExtra.Item
              key={incident.id}
              icon={{
                source:
                  incident.confidence === "confirmed"
                    ? Icon.ExclamationMark
                    : Icon.Warning,
                tintColor:
                  incident.confidence === "confirmed"
                    ? Color.Red
                    : Color.Orange,
              }}
              title={incident.source || "(config change)"}
              subtitle={`${incident.stage} · ${incident.confidence} · ${incident.devices.join(", ")}`}
              // First press is a DRY RUN: the dashboard answers with the plan and
              // nothing is changed. Blocking from a menu bar on one press is how
              // an operator locks themselves out at a glance.
              onAction={() => void blockAttacker(incident.id, false)}
              tooltip={`${incident.narrative}\n\nPress to prepare a block (dry run — confirm in the dashboard)`}
              alternate={
                <MenuBarExtra.Item
                  icon={Icon.Globe}
                  title="Open in Dashboard"
                  onAction={() => open(withToken("/#attacks"))}
                />
              }
            />
          ))}
          {detectOnly ? (
            <MenuBarExtra.Item
              icon={{ source: Icon.Eye, tintColor: Color.Yellow }}
              title="Detect-only — nothing is being blocked"
              onAction={() => open(withToken("/#attacks"))}
            />
          ) : null}
        </MenuBarExtra.Section>
      ) : null}

      {jobs.length > 0 ? (
        <MenuBarExtra.Section title="Audits">
          {lastRegression ? (
            <MenuBarExtra.Item
              icon={{
                source: Icon.ExclamationMark,
                tintColor:
                  lastRegression.added.length + lastRegression.worsened.length >
                  0
                    ? Color.Red
                    : Color.Green,
              }}
              title={lastRegression.summary}
              subtitle={`${lastRegression.device} · ${clock(lastRegression.at)}`}
              onAction={() => open(withToken("/#schedules"))}
              tooltip="The most recent change between two audit runs"
            />
          ) : null}
          {jobs.slice(0, 3).map((job) => (
            <MenuBarExtra.Item
              key={job.id}
              icon={{
                source: Icon.Clock,
                tintColor:
                  (job.posture.bySeverity.critical ?? 0) > 0
                    ? Color.Red
                    : job.lastRun && job.lastRun.outcome !== "ok"
                      ? Color.Orange
                      : Color.Green,
              }}
              title={job.id}
              subtitle={`${job.posture.total} open · ${job.cronText}`}
              onAction={() => void runSchedule(job.id)}
              tooltip="Run this audit now — read-only"
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      {unreachable ? (
        <MenuBarExtra.Section title="Dashboard">
          <MenuBarExtra.Item
            icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
            title="Dashboard unreachable"
            subtitle="check URL / token"
            onAction={openExtensionPreferences}
          />
        </MenuBarExtra.Section>
      ) : null}

      {!unreachable ? (
        <MenuBarExtra.Section title="Fleet">
          {enabled.slice(0, 10).map((d) => (
            <MenuBarExtra.Item
              key={d.name}
              icon={deviceDot(d)}
              title={d.name}
              subtitle={
                d.status.reachable === true
                  ? `${pct(d.status.cpuLoad)} cpu · ${pct(d.status.memUsedPct)} mem`
                  : d.status.reachable === false
                    ? "offline"
                    : "checking…"
              }
              onAction={open_("devices")}
              alternate={
                <MenuBarExtra.Item
                  icon={Icon.Clipboard}
                  title={`Copy ${d.address ?? `${d.host}:${d.port}`}`}
                  onAction={() =>
                    Clipboard.copy(d.address ?? `${d.host}:${d.port}`)
                  }
                />
              }
            />
          ))}
          {enabled.length === 0 ? (
            <MenuBarExtra.Item title="No devices configured" />
          ) : null}
        </MenuBarExtra.Section>
      ) : null}

      {stats ? (
        <MenuBarExtra.Section title="Activity (1h)">
          <MenuBarExtra.Item
            icon={Icon.BarChart}
            title="Calls"
            subtitle={`${num(stats.total)} · ${stats.callsPerMin.toFixed(1)}/min`}
            onAction={open_("overview")}
          />
          <MenuBarExtra.Item
            icon={{
              source: Icon.Dot,
              tintColor:
                stats.errorRate >= 0.2
                  ? Color.Red
                  : stats.errorRate >= 0.05
                    ? Color.Yellow
                    : Color.Green,
            }}
            title="Error rate"
            subtitle={`${(stats.errorRate * 100).toFixed(1)}% (${stats.errors})`}
            onAction={open_("overview")}
          />
          <MenuBarExtra.Item
            icon={Icon.Clock}
            title="Latency"
            subtitle={`avg ${ms(stats.latency.avg)} · p95 ${ms(stats.latency.p95)}`}
            onAction={open_("overview")}
          />
        </MenuBarExtra.Section>
      ) : null}

      {events.length ? (
        <MenuBarExtra.Section title="Recent calls">
          {events.slice(0, 5).map((e) => (
            <MenuBarExtra.Item
              key={e.id}
              icon={{ source: Icon.Dot, tintColor: RISK_COLOR[e.risk] }}
              title={e.tool}
              subtitle={`${riskLabel(e.risk)} · ${e.isError ? "error" : "ok"} · ${ms(e.durationMs)} · ${clock(e.ts)}`}
              onAction={open_("feed")}
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      {alerts > 0 ? (
        <MenuBarExtra.Section title={`Alerts (${alerts})`}>
          {offline.map((d) => (
            <MenuBarExtra.Item
              key={`off-${d.name}`}
              icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
              title={d.name}
              subtitle="offline"
              onAction={open_("devices")}
            />
          ))}
          {hot.map((d) => (
            <MenuBarExtra.Item
              key={`hot-${d.name}`}
              icon={{ source: Icon.Warning, tintColor: Color.Yellow }}
              title={d.name}
              subtitle={`${pct(d.status.cpuLoad)} cpu · ${pct(d.status.memUsedPct)} mem`}
              onAction={open_("devices")}
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      <MenuBarExtra.Section title="Open">
        <MenuBarExtra.Item
          icon={Icon.BarChart}
          title="Overview"
          onAction={open_("overview")}
        />
        <MenuBarExtra.Item
          icon={Icon.Livestream}
          title="Live Feed"
          onAction={open_("feed")}
        />
        <MenuBarExtra.Item
          icon={Icon.HardDrive}
          title="Devices"
          onAction={open_("devices")}
        />
        <MenuBarExtra.Item
          icon={Icon.Globe}
          title="Dashboard in Browser"
          onAction={() => open(withToken("/"))}
        />
      </MenuBarExtra.Section>

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          icon={Icon.ArrowClockwise}
          title="Refresh"
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={() => {
            devicesQ.revalidate();
            statsQ.revalidate();
            eventsQ.revalidate();
            scheduleQ.revalidate();
            attackQ.revalidate();
            regressionQ.revalidate();
          }}
        />
        <MenuBarExtra.Item
          icon={Icon.Gear}
          title="Configure…"
          onAction={openExtensionPreferences}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
