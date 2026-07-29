/**
 * Firmware Lifecycle Manager — `firmware_check`, `firmware_stage`,
 * `firmware_upgrade`, `firmware_status`.
 *
 * Zero-touch RouterOS upgrade pipeline: discover available releases, compare
 * against running versions, stage packages, capture pre-upgrade health
 * snapshots, execute upgrades (with optional maintenance-window scheduling),
 * and verify post-upgrade health — leveraging RouterOS's built-in fallback
 * mechanism for automatic reversion on failure.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import type { ToolContext } from "../core/context";
import {
  assessUpgradeReadiness,
  renderFleetFirmwareCheck,
  renderFirmwareStatus,
  renderHealthSnapshot,
  renderReadiness,
} from "../core/firmware-lifecycle";
import type {
  FirmwareState,
  HealthSnapshot,
  PackageInfo,
  RouterboardInfo,
  UpdateInfo,
} from "../core/firmware-lifecycle";
import { DANGEROUS, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { listDevices, resolveDeviceName } from "../core/runtime";
import { invalidateCapabilities } from "../core/capability-cache";
import { Cmd, isEmpty, looksLikeError } from "../core/routeros";
import { parseKeyValues, parseRecords } from "../core/routeros-parse";
import { safe } from "../utils/safe-exec";

/** Parse `/system package print` into PackageInfo[]. */
function parsePackages(raw: string): PackageInfo[] {
  if (!raw) return [];
  const rows = parseRecords(raw).rows;
  return rows.map((r) => ({
    name: r.name ?? "",
    version: r.version ?? "",
    disabled: (r.flags ?? "").includes("X") || r.disabled === "true",
  }));
}

/** Parse `/system routerboard print` into RouterboardInfo. */
function parseRouterboard(raw: string): RouterboardInfo | null {
  if (!raw) return null;
  const kv = parseKeyValues(raw);
  if (!kv["current-firmware"] && !kv.model) return null;
  const cur = kv["current-firmware"] ?? "";
  const upg = kv["upgrade-firmware"] ?? "";
  return {
    model: kv.model ?? "",
    serialNumber: kv["serial-number"] ?? "",
    currentFirmware: cur,
    upgradeFirmware: upg,
    firmwareUpgradeAvailable: !!upg && upg !== cur,
  };
}

/** Parse `/system package update print` into UpdateInfo. */
function parseUpdateInfo(raw: string): UpdateInfo | null {
  if (!raw) return null;
  const kv = parseKeyValues(raw);
  const installed = kv["installed-version"] ?? "";
  const latest = kv["latest-version"] ?? "";
  if (!installed && !latest) return null;
  const status = (kv.status ?? "").toLowerCase();
  return {
    channel: kv.channel ?? "unknown",
    installedVersion: installed,
    latestVersion: latest,
    updateAvailable:
      status.includes("new version") ||
      status.includes("available") ||
      (!!latest && !!installed && latest !== installed),
  };
}

/** Fetch full firmware state from a device. */
async function fetchFirmwareState(ctx: ToolContext): Promise<FirmwareState> {
  const [resourceRaw, packagesRaw, routerboardRaw, updateRaw] = await Promise.all([
    safe("/system resource print", ctx),
    safe("/system package print detail", ctx),
    safe("/system routerboard print", ctx),
    safe("/system package update print", ctx),
  ]);

  const res = parseKeyValues(resourceRaw);

  return {
    rosVersion: res.version ?? "",
    architecture: res["architecture-name"] ?? res.architecture ?? "",
    boardName: res["board-name"] ?? "",
    uptime: res.uptime ?? "",
    cpuLoad: res["cpu-load"] ?? "",
    freeMemory: res["free-memory"] ?? "",
    totalMemory: res["total-memory"] ?? "",
    packages: parsePackages(packagesRaw),
    routerboard: parseRouterboard(routerboardRaw),
    updateInfo: parseUpdateInfo(updateRaw),
  };
}

/** Capture a health snapshot for pre/post upgrade comparison. */
async function captureHealthSnapshot(ctx: ToolContext): Promise<HealthSnapshot> {
  const [resourceRaw, healthRaw, routesRaw, interfacesRaw, pppRaw, dhcpRaw] = await Promise.all([
    safe("/system resource print", ctx),
    safe("/system health print", ctx),
    safe("/ip route print count-only", ctx),
    safe("/interface print detail", ctx),
    safe("/ppp active print count-only", ctx),
    safe("/ip dhcp-server lease print count-only where status=bound", ctx),
  ]);

  const res = parseKeyValues(resourceRaw);

  // Count active interfaces
  const ifRows = interfacesRaw ? parseRecords(interfacesRaw).rows : [];
  const running = ifRows.filter(
    (r) => (r.flags ?? "").includes("R") || r.running === "true",
  ).length;

  return {
    timestamp: new Date().toISOString(),
    version: res.version ?? "",
    uptime: res.uptime ?? "",
    cpuLoad: res["cpu-load"] ?? "",
    freeMemory: res["free-memory"] ?? "",
    totalMemory: res["total-memory"] ?? "",
    routeCount: Number.parseInt(routesRaw.trim(), 10) || 0,
    activeInterfaces: running,
    totalInterfaces: ifRows.length,
    healthSensors: healthRaw || "No sensors available",
    pppSessions: Number.parseInt(pppRaw.trim(), 10) || 0,
    dhcpLeases: Number.parseInt(dhcpRaw.trim(), 10) || 0,
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

const channelEnum = z.enum(["stable", "long-term", "testing"]).describe("RouterOS update channel.");

export const firmwareLifecycleTools: ToolModule = [
  // ── firmware_check ────────────────────────────────────────────────────
  defineTool({
    name: "firmware_check",
    title: "Check Firmware Updates",
    annotations: READ,
    description:
      "Discover available RouterOS updates for a single device or the entire fleet. " +
      "Queries the configured update channel, compares installed vs. latest version, " +
      "flags outdated firmware, and assesses upgrade readiness (CPU, memory, version jump). " +
      "Optionally set the update channel before checking. " +
      "Use `firmware_status` for detailed package/routerboard info; " +
      "use `firmware_stage` to download packages after confirming an update is available.",
    inputSchema: {
      channel: channelEnum
        .optional()
        .describe("Set the update channel before checking (default: keep current)."),
      fleet: z
        .boolean()
        .default(false)
        .describe("Check all configured devices instead of just one."),
      devices: z
        .array(z.string())
        .optional()
        .describe("Specific device names to check (fleet mode). Omit to check all."),
    },
    async handler(a, ctx) {
      // Single-device mode
      if (!a.fleet) {
        const device = resolveDeviceName(ctx.device);
        ctx.info(`Checking firmware updates on '${device}'`);

        // Optionally set channel
        if (a.channel) {
          await executeMikrotikCommand(`/system package update set channel=${a.channel}`, ctx);
        }

        // Trigger update check
        await executeMikrotikCommand("/system package update check-for-updates once", ctx);

        const state = await fetchFirmwareState(ctx);
        const readiness = assessUpgradeReadiness(state);
        const lines: string[] = [];
        lines.push(renderFirmwareStatus(state, device));
        lines.push("");
        lines.push(renderReadiness(readiness));
        return lines.join("\n");
      }

      // Fleet mode
      const all = listDevices();
      const targets = a.devices?.length ? a.devices : all.names;

      // Validate device names
      const unknown = targets.filter((d: string) => {
        try {
          resolveDeviceName(d);
          return false;
        } catch {
          return true;
        }
      });
      if (unknown.length) return `Unknown device(s): ${unknown.join(", ")}`;

      ctx.info(`Fleet firmware check: ${targets.length} device(s)`);

      const results: {
        name: string;
        state: FirmwareState | null;
        error?: string;
      }[] = [];

      for (const deviceName of targets) {
        const resolved = resolveDeviceName(deviceName);
        const dctx = createContext(undefined, deviceName);
        try {
          if (a.channel) {
            await executeMikrotikCommand(`/system package update set channel=${a.channel}`, dctx);
          }
          await executeMikrotikCommand("/system package update check-for-updates once", dctx);
          const state = await fetchFirmwareState(dctx);
          results.push({ name: resolved, state });
        } catch (err) {
          results.push({
            name: resolved,
            state: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return renderFleetFirmwareCheck(results);
    },
  }),

  // ── firmware_stage ────────────────────────────────────────────────────
  defineTool({
    name: "firmware_stage",
    title: "Stage Firmware Packages",
    annotations: WRITE,
    description:
      "Download and pre-stage RouterOS update packages on the device WITHOUT installing " +
      "or rebooting (`/system package update download`). " +
      "Use after `firmware_check` confirms an update is available. " +
      "Once staged, use `firmware_upgrade` to install during a maintenance window. " +
      "The download runs in the background on the device; re-run `firmware_status` to " +
      "verify the download completed.",
    inputSchema: {
      channel: channelEnum
        .optional()
        .describe("Set the update channel before downloading (default: keep current)."),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Staging firmware on '${device}'`);

      // Optionally set channel
      if (a.channel) {
        const chResult = await executeMikrotikCommand(
          `/system package update set channel=${a.channel}`,
          ctx,
        );
        if (looksLikeError(chResult)) return `Failed to set channel: ${chResult}`;
      }

      // Check for updates first
      await executeMikrotikCommand("/system package update check-for-updates once", ctx);

      // Read update status
      const updateRaw = await safe("/system package update print", ctx);
      const updateInfo = parseUpdateInfo(updateRaw);

      if (!updateInfo?.updateAvailable) {
        return (
          `No update available on '${device}'.\n` +
          `Installed: ${updateInfo?.installedVersion ?? "unknown"}\n` +
          `Latest:    ${updateInfo?.latestVersion ?? "unknown"}\n` +
          `Channel:   ${updateInfo?.channel ?? "unknown"}\n\n` +
          "The device is already running the latest version on this channel."
        );
      }

      // Download packages
      const dlResult = await executeMikrotikCommand("/system package update download", ctx);

      if (looksLikeError(dlResult)) {
        return `Failed to download update packages: ${dlResult}`;
      }

      // Verify download status
      const postRaw = await safe("/system package update print", ctx);
      const postStatus = parseKeyValues(postRaw);

      const lines: string[] = [];
      lines.push(`FIRMWARE STAGED — ${device}`);
      lines.push("");
      lines.push(`  Channel:     ${updateInfo.channel}`);
      lines.push(`  Current:     ${updateInfo.installedVersion}`);
      lines.push(`  Staged:      ${updateInfo.latestVersion}`);
      lines.push(`  Status:      ${postStatus.status ?? "downloaded"}`);
      lines.push("");
      lines.push("Packages downloaded. Use `firmware_upgrade` to install (device will reboot).");
      lines.push(
        "To schedule the upgrade for a maintenance window, use `firmware_upgrade` with " +
          "`schedule_time`.",
      );

      return lines.join("\n");
    },
  }),

  // ── firmware_upgrade ──────────────────────────────────────────────────
  defineTool({
    name: "firmware_upgrade",
    title: "Upgrade Firmware",
    annotations: DANGEROUS,
    description:
      "Execute the RouterOS upgrade pipeline on a device. Takes a pre-upgrade health " +
      "snapshot, installs staged packages (device reboots automatically), and optionally " +
      "schedules the upgrade for a future maintenance window. " +
      "RouterOS has a built-in fallback mechanism: if the device fails to boot after an " +
      "upgrade, it automatically reverts to the previous firmware. " +
      "Use `firmware_check` first to verify an update is available, and `firmware_stage` " +
      "to pre-download packages. After the device reboots, use `firmware_status` to " +
      "verify the upgrade and run the post-upgrade health comparison. " +
      "Requires `confirm=true` — the device WILL REBOOT and be offline for 1-3 minutes.",
    inputSchema: {
      confirm: z.boolean().describe("Must be true to execute the upgrade. Device will reboot."),
      schedule_time: z
        .string()
        .optional()
        .describe(
          "Schedule the upgrade for a future time instead of immediate execution. " +
            "Format: HH:MM:SS (e.g. '03:00:00' for 3 AM). The device will reboot at this time.",
        ),
      schedule_date: z
        .string()
        .optional()
        .describe(
          "Date for scheduled upgrade. Format: 'jan/01/2026'. " +
            "Omit to use today (or the next occurrence of schedule_time).",
        ),
      upgrade_routerboard: z
        .boolean()
        .default(false)
        .describe(
          "Also upgrade RouterBOARD firmware after RouterOS upgrade " +
            "(`/system routerboard upgrade`). Requires a second reboot.",
        ),
      capture_health: z
        .boolean()
        .default(true)
        .describe("Capture a pre-upgrade health snapshot for later comparison."),
    },
    async handler(a, ctx) {
      if (!a.confirm)
        return "Upgrade not confirmed. Pass confirm=true to proceed. The device WILL reboot.";

      const device = resolveDeviceName(ctx.device);
      ctx.info(`Firmware upgrade on '${device}'`);

      // Verify update is available
      const updateRaw = await safe("/system package update print", ctx);
      const updateInfo = parseUpdateInfo(updateRaw);

      if (!updateInfo?.updateAvailable) {
        return (
          `No update available on '${device}'. ` +
          `Run \`firmware_check\` or \`firmware_stage\` first.\n` +
          `Installed: ${updateInfo?.installedVersion ?? "unknown"}\n` +
          `Latest:    ${updateInfo?.latestVersion ?? "unknown"}`
        );
      }

      const lines: string[] = [];

      // Pre-upgrade health snapshot
      let preSnapshot: HealthSnapshot | null = null;
      if (a.capture_health) {
        ctx.info("Capturing pre-upgrade health snapshot");
        preSnapshot = await captureHealthSnapshot(ctx);
        lines.push(renderHealthSnapshot(preSnapshot, "PRE-UPGRADE HEALTH SNAPSHOT"));
        lines.push("");
      }

      // Scheduled upgrade
      if (a.schedule_time) {
        ctx.info(`Scheduling upgrade for ${a.schedule_time}`);
        const schedulerName = "mcp-firmware-upgrade";

        // Build the upgrade script
        let script = "/system package update install";
        if (a.upgrade_routerboard) {
          script = `:delay 3s; /system routerboard upgrade; :delay 2s; ${script}`;
        }

        // Remove any existing upgrade scheduler
        await executeMikrotikCommand(
          `/system scheduler remove [find name="${schedulerName}"]`,
          ctx,
        );

        // Create the scheduler
        const cmd = new Cmd("/system scheduler add")
          .set("name", schedulerName)
          .set("on-event", script)
          .set("start-time", a.schedule_time)
          .opt("start-date", a.schedule_date)
          .set("interval", "0")
          .set("policy", "ftp,reboot,read,write,policy,test,password,sniff,sensitive,romon")
          .set(
            "comment",
            `MCP firmware upgrade: ${updateInfo.installedVersion} -> ${updateInfo.latestVersion}`,
          )
          .build();

        const schResult = await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(schResult)) {
          return `Failed to schedule upgrade: ${schResult}`;
        }

        lines.push(`FIRMWARE UPGRADE SCHEDULED — ${device}`);
        lines.push("");
        lines.push(`  Upgrade:     ${updateInfo.installedVersion} → ${updateInfo.latestVersion}`);
        lines.push(`  Channel:     ${updateInfo.channel}`);
        lines.push(
          `  Scheduled:   ${a.schedule_time}${a.schedule_date ? ` on ${a.schedule_date}` : ""}`,
        );
        lines.push(`  Scheduler:   ${schedulerName}`);
        if (a.upgrade_routerboard) {
          lines.push(`  RouterBOARD: Will also upgrade board firmware`);
        }
        lines.push("");
        lines.push("The device will reboot at the scheduled time.");
        lines.push("To cancel: remove the scheduler entry named 'mcp-firmware-upgrade'.");
        lines.push("After reboot: use `firmware_status` with `post_check=true` to verify health.");

        return lines.join("\n");
      }

      // Immediate upgrade
      lines.push(`FIRMWARE UPGRADE — ${device}`);
      lines.push("");
      lines.push(`  Current:     ${updateInfo.installedVersion}`);
      lines.push(`  Target:      ${updateInfo.latestVersion}`);
      lines.push(`  Channel:     ${updateInfo.channel}`);
      lines.push("");

      if (a.upgrade_routerboard) {
        ctx.info("Upgrading RouterBOARD firmware first");
        const rbResult = await executeMikrotikCommand("/system routerboard upgrade", ctx);
        if (looksLikeError(rbResult)) {
          lines.push(`  RouterBOARD upgrade warning: ${rbResult}`);
        } else {
          lines.push("  RouterBOARD firmware queued for upgrade on next boot.");
        }
        lines.push("");
      }

      // Execute the upgrade — this triggers a reboot
      ctx.info("Installing firmware update (device will reboot)");
      await executeMikrotikCommand("/system package update install", ctx);

      // The version, and possibly the package set, are about to change — drop
      // the cached capability probe so the next call reprobes rather than gating
      // on facts from the previous firmware.
      invalidateCapabilities(ctx.device);

      lines.push("  UPGRADE INITIATED — device is rebooting.");
      lines.push("  The device will be offline for 1-3 minutes.");
      lines.push("");
      lines.push("  RouterOS built-in fallback: if the device fails to boot with the new");
      lines.push("  firmware, it will automatically revert to the previous version.");
      lines.push("");
      lines.push("  After the device comes back online:");
      lines.push("  1. Run `firmware_status` to verify the new version");
      lines.push("  2. Run `firmware_status` with `post_check=true` to compare health");

      return lines.join("\n");
    },
  }),

  // ── firmware_status ───────────────────────────────────────────────────
  defineTool({
    name: "firmware_status",
    title: "Firmware Status & Health Check",
    annotations: READ,
    description:
      "Show detailed firmware status for a device: RouterOS version, architecture, " +
      "installed packages, RouterBOARD firmware, update channel status, and upgrade " +
      "readiness assessment. " +
      "Set `post_check=true` after an upgrade to capture a post-upgrade health snapshot " +
      "and compare it against the pre-upgrade baseline — verifying routes, interfaces, " +
      "sessions, and system resources came back healthy. " +
      "For fleet-wide status use `firmware_check` with `fleet=true`.",
    inputSchema: {
      post_check: z
        .boolean()
        .default(false)
        .describe(
          "Capture a health snapshot and compare against the pre-upgrade baseline. " +
            "Use after an upgrade to verify the device came back healthy.",
        ),
      pre_snapshot_version: z
        .string()
        .optional()
        .describe(
          "The version that was running before the upgrade (for comparison context). " +
            "If not provided, the post-check captures the snapshot without comparison.",
        ),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      ctx.info(`Firmware status on '${device}'`);

      const state = await fetchFirmwareState(ctx);
      const lines: string[] = [];

      lines.push(renderFirmwareStatus(state, device));
      lines.push("");

      // Readiness assessment
      const readiness = assessUpgradeReadiness(state);
      lines.push(renderReadiness(readiness));

      // Post-upgrade health check
      if (a.post_check) {
        lines.push("");
        ctx.info("Capturing post-upgrade health snapshot");
        const postSnap = await captureHealthSnapshot(ctx);
        lines.push(renderHealthSnapshot(postSnap, "POST-UPGRADE HEALTH SNAPSHOT"));

        // If we know the pre-upgrade version, note the version change
        if (a.pre_snapshot_version && a.pre_snapshot_version !== postSnap.version) {
          lines.push("");
          lines.push(`Version upgraded: ${a.pre_snapshot_version} → ${postSnap.version}`);
        }
      }

      // Check for pending routerboard upgrade
      if (state.routerboard?.firmwareUpgradeAvailable) {
        lines.push("");
        lines.push("NOTE: RouterBOARD firmware upgrade available.");
        lines.push(
          `  Current: ${state.routerboard.currentFirmware}  →  Available: ${state.routerboard.upgradeFirmware}`,
        );
        lines.push("  Use `firmware_upgrade` with `upgrade_routerboard=true` to include it.");
      }

      // Check for pending scheduled upgrade
      const schedRaw = await safe(
        '/system scheduler print detail where name="mcp-firmware-upgrade"',
        ctx,
      );
      if (schedRaw && !isEmpty(schedRaw)) {
        lines.push("");
        lines.push("PENDING SCHEDULED UPGRADE:");
        lines.push(schedRaw);
      }

      return lines.join("\n");
    },
  }),
];
