/** Native fleet glance: attention first, progressive detail, explicit actions. */
import { useEffect } from "react";
import {
  Color,
  Icon,
  Keyboard,
  MenuBarExtra,
  updateCommandMetadata,
} from "@raycast/api";
import { useApi } from "./lib/hooks";
import { clock, ms, num } from "./lib/format";
import { fleetSummary, fleetTone } from "./lib/fleet-model";
import {
  DeviceMenu,
  FleetItem,
  FleetLink,
  TINT,
  runFeedback,
  openDashboard,
  launch,
  preferences,
  muteAlert,
  runAudit,
} from "./lib/fleet-menu";
import type {
  AlertsPayload,
  AttacksPayload,
  DevicesPayload,
  RolloutRecord,
  ScheduleJobRow,
  ScheduleRegression,
  Stats,
  ToolEvent,
} from "./lib/types";

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
  const queries = [
    devicesQ,
    statsQ,
    eventsQ,
    alertsQ,
    rolloutQ,
    scheduleQ,
    regressionQ,
    attackQ,
  ];
  const labels = [
    "Device health",
    "Activity",
    "Recent calls",
    "Alerts",
    "Rollouts",
    "Audits",
    "Audit changes",
    "Security",
  ];
  const failed = queries.flatMap((query, index) =>
    query.error ? [labels[index]] : [],
  );
  const loading = queries.some((query) => query.isLoading);
  const fleet = fleetSummary(devicesQ.data?.devices ?? []);
  const unavailable = !!devicesQ.error && !devicesQ.data;
  const stale = !!devicesQ.error && !!devicesQ.data;
  const firing = alertsQ.data?.active ?? [];
  const rollouts = (rolloutQ.data?.rollouts ?? []).filter(
    (r) => !r.outcome || ["halted", "needs-attention"].includes(r.outcome),
  );
  const jobs = scheduleQ.data?.jobs ?? [];
  const criticalFindings = jobs.reduce(
    (n, job) => n + (job.posture.bySeverity.critical ?? 0),
    0,
  );
  const incidents = (attackQ.data?.incidents ?? []).filter((i) =>
    ["confirmed", "high"].includes(i.confidence),
  );
  const stats = statsQ.data;
  const events = eventsQ.data?.events ?? [];
  const tone = fleetTone({
    ...fleet,
    unavailable,
    stale,
    partial: failed.length > 0 || queries.some((query) => !query.data),
    critical:
      incidents.some((i) => i.confidence === "confirmed") ||
      criticalFindings > 0 ||
      firing.some((a) => a.severity === "critical") ||
      rollouts.some((r) => r.outcome === "needs-attention"),
    warning:
      incidents.length > 0 ||
      firing.length > 0 ||
      rollouts.some((r) => r.outcome === "halted") ||
      (stats?.errorRate ?? 0) >= 0.2,
  });
  const heading = unavailable
    ? "Dashboard unavailable"
    : stale
      ? "Showing saved observations"
      : failed.length
        ? "Some observations unavailable"
        : tone === "critical"
          ? "Fleet needs attention"
          : tone === "warning"
            ? "Review fleet warnings"
            : tone === "unknown"
              ? "Waiting for health observations"
              : "Fleet is connected";
  const summary = `${fleet.online} online · ${fleet.offline} offline${fleet.unknown ? ` · ${fleet.unknown} unknown` : ""}`;
  const title = unavailable
    ? "MCP offline"
    : !devicesQ.data
      ? "MCP …"
      : `${fleet.online}/${fleet.total}${stale ? " · stale" : ""}`;
  useEffect(() => {
    void updateCommandMetadata({ subtitle: `${heading} · ${summary}` }).catch(
      () => {},
    );
  }, [heading, summary]);
  const refresh = () =>
    runFeedback("Refresh fleet", async () => {
      const results = await Promise.allSettled(
        queries.map((query) => query.revalidate()),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error(
          "Some sources could not refresh. Check dashboard connectivity.",
        );
    });

  return (
    <MenuBarExtra
      title={title}
      icon={{
        source: tone === "critical" ? Icon.ExclamationMark : Icon.Network,
        tintColor: TINT[tone],
      }}
      tooltip={`${heading}\n${summary}\nBackground refresh every minute`}
      isLoading={loading}
    >
      <MenuBarExtra.Section title="MIKROTIK · FLEET">
        <FleetItem
          title={heading}
          subtitle={unavailable ? "Check URL and access token" : summary}
          icon={Icon.Network}
          tone={tone}
          onAction={unavailable ? preferences : () => launch("devices")}
        />
        <FleetItem
          title={
            loading
              ? "Refreshing observations…"
              : "Background refresh · every minute"
          }
          icon={Icon.Clock}
        />
        {!!failed.length && (
          <MenuBarExtra.Submenu
            title={`${failed.length} unavailable data source${failed.length === 1 ? "" : "s"}`}
            icon={{ source: Icon.Warning, tintColor: Color.Orange }}
          >
            {failed.map((label) => (
              <FleetItem
                key={label}
                title={label}
                subtitle="Cached data may be outdated"
                icon={Icon.Warning}
                tone="warning"
              />
            ))}
            <FleetItem
              title="Check connection settings…"
              icon={Icon.Gear}
              onAction={preferences}
            />
          </MenuBarExtra.Submenu>
        )}
      </MenuBarExtra.Section>

      {(firing.length > 0 ||
        incidents.length > 0 ||
        rollouts.length > 0 ||
        criticalFindings > 0) && (
        <MenuBarExtra.Section title="NEEDS ATTENTION">
          {incidents.length > 0 && (
            <MenuBarExtra.Submenu
              title={`${incidents.length} security incidents · last 24h`}
              icon={{ source: Icon.Shield, tintColor: Color.Red }}
            >
              {incidents.slice(0, 5).map((incident) => (
                <FleetItem
                  key={incident.id}
                  title={incident.source || "Configuration incident"}
                  subtitle={`${incident.confidence} · ${incident.devices.join(", ")}`}
                  tooltip={incident.narrative}
                  icon={Icon.Warning}
                  tone={
                    incident.confidence === "confirmed" ? "critical" : "warning"
                  }
                  onAction={() => openDashboard("attacks")}
                />
              ))}
              <FleetItem
                title={
                  attackQ.data?.posture.mode === "detect"
                    ? "Detection only · review responses…"
                    : "Review all incidents…"
                }
                icon={Icon.ArrowRight}
                onAction={() => openDashboard("attacks")}
              />
            </MenuBarExtra.Submenu>
          )}
          {firing.length > 0 && (
            <MenuBarExtra.Submenu
              title={`${firing.length} firing alerts`}
              icon={{ source: Icon.Bell, tintColor: Color.Orange }}
            >
              {firing.slice(0, 8).map((alert) => (
                <MenuBarExtra.Submenu
                  key={`${alert.id}:${alert.subject}`}
                  title={`${alert.subject === "*" ? "Fleet" : alert.subject} · ${alert.description ?? alert.id}`}
                  icon={{
                    source: Icon.Bell,
                    tintColor:
                      alert.severity === "critical" ? Color.Red : Color.Orange,
                  }}
                >
                  <FleetItem title={`Severity · ${alert.severity}`} />
                  <FleetItem
                    title="Review alert…"
                    icon={Icon.Eye}
                    onAction={() => openDashboard("alerts")}
                  />
                  <FleetItem
                    title="Mute for 1 hour"
                    icon={Icon.Bell}
                    onAction={() =>
                      runFeedback("Mute alert for 1 hour", async () => {
                        await muteAlert(alert.id);
                        await alertsQ.revalidate();
                      })
                    }
                  />
                </MenuBarExtra.Submenu>
              ))}
              <FleetItem
                title="View all alerts…"
                icon={Icon.ArrowRight}
                onAction={() => openDashboard("alerts")}
              />
            </MenuBarExtra.Submenu>
          )}
          {rollouts.map((rollout) => (
            <FleetItem
              key={rollout.id}
              title={rollout.label || rollout.id}
              subtitle={
                rollout.outcome ||
                `Wave ${rollout.phase} · ${rollout.devices.filter((d) => d.stage === "applied").length}/${rollout.devices.length} applied`
              }
              icon={rollout.outcome ? Icon.Warning : Icon.Clock}
              tone={
                rollout.outcome === "needs-attention" ? "critical" : "warning"
              }
              onAction={() => launch("change-plan")}
            />
          ))}
          {criticalFindings > 0 && (
            <FleetItem
              title={`${criticalFindings} critical audit findings`}
              icon={Icon.Shield}
              tone="critical"
              onAction={() => openDashboard("schedules")}
            />
          )}
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section title={`ROUTERS · ${fleet.total}`}>
        {fleet.sorted.slice(0, 8).map((device) => (
          <DeviceMenu key={device.name} device={device} stale={stale} />
        ))}
        {!fleet.total && (
          <FleetItem
            title={
              unavailable
                ? "Device list unavailable"
                : loading
                  ? "Loading routers…"
                  : "No enabled routers"
            }
            subtitle="Manage devices in the dashboard"
            icon={Icon.HardDrive}
            onAction={() => openDashboard("devices")}
          />
        )}
        {(fleet.total > 8 || fleet.disabled > 0) && (
          <FleetItem
            title={`View all routers…${fleet.disabled ? ` (${fleet.disabled} disabled)` : ""}`}
            icon={Icon.ArrowRight}
            onAction={() => launch("devices")}
          />
        )}
      </MenuBarExtra.Section>

      <MenuBarExtra.Section title="ACTIVITY · LAST HOUR">
        <MenuBarExtra.Submenu
          title={
            stats
              ? `${num(stats.total)} calls · ${(stats.errorRate * 100).toFixed(1)}% errors`
              : "Activity not available"
          }
          icon={Icon.BarChart}
        >
          {stats && (
            <>
              <FleetItem
                title="Throughput"
                subtitle={`${stats.callsPerMin.toFixed(1)} calls/min`}
                icon={Icon.BarChart}
              />
              <FleetItem
                title="Response time"
                subtitle={`${ms(stats.latency.avg)} avg · ${ms(stats.latency.p95)} p95`}
                icon={Icon.Clock}
              />
              <FleetItem
                title="Failed calls"
                subtitle={num(stats.errors)}
                icon={Icon.Warning}
                tone={stats.errors ? "warning" : "healthy"}
              />
            </>
          )}
          <FleetLink
            title="Open analytics…"
            command="overview"
            icon={Icon.BarChart}
          />
        </MenuBarExtra.Submenu>
        <MenuBarExtra.Submenu
          title={`Recent calls${events.length ? ` · ${events.length}` : ""}`}
          icon={Icon.Livestream}
        >
          {events.map((event) => (
            <FleetItem
              key={event.id}
              title={`${event.tool} · ${clock(event.ts)}`}
              subtitle={`${event.device || "Server"} · ${event.isError ? "Failed" : "OK"} · ${ms(event.durationMs)}`}
              tooltip={`${clock(event.ts)} · ${event.risk}`}
              icon={event.isError ? Icon.XMarkCircle : Icon.CheckCircle}
              tone={event.isError ? "critical" : "healthy"}
              onAction={() => launch("feed")}
            />
          ))}
          {!events.length && (
            <FleetItem
              title={
                eventsQ.error
                  ? "Recent calls unavailable"
                  : "No calls recorded yet"
              }
            />
          )}
          <FleetLink
            title="Open Live Feed…"
            command="feed"
            icon={Icon.ArrowRight}
          />
        </MenuBarExtra.Submenu>
        <MenuBarExtra.Submenu
          title={`Scheduled audits · ${jobs.length}`}
          icon={Icon.Shield}
        >
          {(regressionQ.data?.regressions ?? [])
            .slice(0, 1)
            .map((regression) => (
              <FleetItem
                key={`${regression.jobId}:${regression.at}`}
                title={regression.summary}
                subtitle={`${regression.device} · ${clock(regression.at)}`}
                icon={Icon.Warning}
                onAction={() => openDashboard("schedules")}
              />
            ))}
          {jobs.slice(0, 5).map((job) => (
            <MenuBarExtra.Submenu key={job.id} title={job.id} icon={Icon.Clock}>
              <FleetItem
                title={job.enabled ? job.cronText : "Schedule paused"}
                subtitle={`${job.posture.total} open findings`}
              />
              <FleetItem
                title="Review audit history…"
                icon={Icon.Eye}
                onAction={() => openDashboard("schedules")}
              />
              <FleetItem
                title="Run audit now (read-only)"
                icon={Icon.ArrowClockwise}
                onAction={() =>
                  runFeedback("Run audit", async () => {
                    await runAudit(job.id);
                    await Promise.all([
                      scheduleQ.revalidate(),
                      regressionQ.revalidate(),
                    ]);
                  })
                }
              />
            </MenuBarExtra.Submenu>
          ))}
          <FleetItem
            title="Manage all schedules…"
            icon={Icon.ArrowRight}
            onAction={() => openDashboard("schedules")}
          />
        </MenuBarExtra.Submenu>
      </MenuBarExtra.Section>

      <MenuBarExtra.Section title="WORKSPACE">
        <FleetItem
          title="Open dashboard"
          icon={Icon.Globe}
          onAction={() => openDashboard("overview")}
          shortcut={Keyboard.Shortcut.Common.Open}
        />
        <MenuBarExtra.Submenu title="Quick access" icon={Icon.AppWindow}>
          <FleetLink title="Devices" command="devices" icon={Icon.HardDrive} />
          <FleetLink
            title="Connected clients"
            command="clients"
            icon={Icon.Person}
          />
          <FleetLink title="Live Feed" command="feed" icon={Icon.Livestream} />
          <FleetLink title="Snapshots" command="snapshots" icon={Icon.Clock} />
          <FleetLink title="Drift Guard" command="drift" icon={Icon.Shield} />
          <FleetLink
            title="Transactions"
            command="transactions"
            icon={Icon.Network}
          />
        </MenuBarExtra.Submenu>
        <FleetItem
          title="Refresh all observations"
          icon={Icon.ArrowClockwise}
          onAction={refresh}
          shortcut={Keyboard.Shortcut.Common.Refresh}
        />
        <FleetItem
          title="Connection settings…"
          icon={Icon.Gear}
          onAction={preferences}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
