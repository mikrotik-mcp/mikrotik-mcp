/** RouterOS device-mode capabilities; updates require physical confirmation. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { DANGEROUS, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, isEmpty, looksLikeError } from "../core/routeros";

export const deviceModeTools: ToolModule = [
  defineTool({
    name: "get_device_mode",
    title: "Get RouterOS Device Mode",
    annotations: READ,
    description:
      "Read `/system device-mode print` to see which restricted RouterOS features are available and whether physical confirmation is pending.",
    async handler(_a, ctx) {
      const result = await executeMikrotikCommand("/system device-mode print", ctx);
      return isEmpty(result) ? "Device mode unavailable on this RouterOS version." : result;
    },
  }),
  defineTool({
    name: "update_device_mode_features",
    title: "Request Device Mode Feature Update",
    annotations: DANGEROUS,
    description:
      "Request any RouterOS device-mode feature or mode setting. Changing mode replaces existing per-feature overrides; inspect get_device_mode first. Clearing flagged requires a security audit. Every update needs physical confirmation and a reboot; the command response only confirms a pending request. Read back after confirmation. Unsupported properties depend on RouterOS version and hardware.",
    inputSchema: {
      mode: z
        .enum(["home", "basic", "advanced", "rose"])
        .optional()
        .describe(
          "Changes the entire mode and resets prior per-feature overrides; include any overrides to keep in this request.",
        ),
      scheduler: z.boolean().optional(),
      socks: z.boolean().optional(),
      fetch: z.boolean().optional(),
      pptp: z.boolean().optional(),
      l2tp: z.boolean().optional(),
      bandwidth_test: z.boolean().optional(),
      traffic_gen: z.boolean().optional(),
      sniffer: z.boolean().optional(),
      ipsec: z.boolean().optional(),
      romon: z.boolean().optional(),
      proxy: z.boolean().optional(),
      hotspot: z.boolean().optional(),
      smb: z.boolean().optional(),
      email: z.boolean().optional(),
      zerotier: z.boolean().optional(),
      container: z.boolean().optional(),
      install_any_version: z.boolean().optional(),
      partitions: z.boolean().optional(),
      routerboard: z.boolean().optional(),
      activation_timeout: z
        .string()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Physical confirmation window, 10 seconds to 1 day (RouterOS duration, e.g. 5m or 00:05:00).",
        ),
      flagging_enabled: z.boolean().optional(),
      flagged: z
        .boolean()
        .optional()
        .describe("Set false only after a security audit of the router configuration."),
      confirm_mode_resets_overrides: z
        .literal(true)
        .optional()
        .describe(
          "Required with mode: existing per-feature overrides will be reset unless included in this request.",
        ),
      confirm_flagged_audit_complete: z
        .literal(true)
        .optional()
        .describe(
          "Required to clear flagged after auditing configuration, passwords, and RouterOS version.",
        ),
      physical_confirmation_available: z
        .literal(true)
        .describe("Operator is physically present and has authorized the device-mode change."),
    },
    async handler(a, ctx) {
      if (a.mode && !a.confirm_mode_resets_overrides)
        return "Refusing mode change: confirm_mode_resets_overrides=true is required because mode resets prior per-feature overrides.";
      if (a.flagged === false && !a.confirm_flagged_audit_complete)
        return "Refusing to clear flagged: confirm_flagged_audit_complete=true is required after a security audit.";
      const cmd = new Cmd("/system device-mode update")
        .opt("mode", a.mode)
        .bool("scheduler", a.scheduler)
        .bool("socks", a.socks)
        .bool("fetch", a.fetch)
        .bool("pptp", a.pptp)
        .bool("l2tp", a.l2tp)
        .bool("bandwidth-test", a.bandwidth_test)
        .bool("traffic-gen", a.traffic_gen)
        .bool("sniffer", a.sniffer)
        .bool("ipsec", a.ipsec)
        .bool("romon", a.romon)
        .bool("proxy", a.proxy)
        .bool("hotspot", a.hotspot)
        .bool("smb", a.smb)
        .bool("email", a.email)
        .bool("zerotier", a.zerotier)
        .bool("container", a.container)
        .bool("install-any-version", a.install_any_version)
        .bool("partitions", a.partitions)
        .bool("routerboard", a.routerboard)
        .opt("activation-timeout", a.activation_timeout)
        .bool("flagging-enabled", a.flagging_enabled)
        .bool("flagged", a.flagged);
      if (cmd.build() === "/system device-mode update") return "No feature changes specified.";
      const result = await executeMikrotikCommand(cmd.build(), ctx);
      if (looksLikeError(result)) return `Failed to request device-mode update: ${result}`;
      return `Device-mode update requested; physical confirmation is required before treating it as active. Router response:\n${result}`;
    },
  }),
];
