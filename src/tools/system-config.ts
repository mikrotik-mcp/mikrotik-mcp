/**
 * System configuration menus — `/system` (console, leds, license, note,
 * ntp server, special-login, watchdog), `/port`, `/password`, the wireless
 * regulatory/country domain, and the factory `reset-configuration` guard.
 *
 * Companion to system.ts: this module covers the lower-traffic `/system`
 * sub-menus plus serial ports and password/reset lifecycle tools. Several
 * menus are hardware/version dependent, so reads fall back to a friendly
 * message when `commandUnsupported(result)`.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, defineTool, DANGEROUS } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  whereClause,
  looksLikeError,
  isEmpty,
  commandUnsupported,
  Cmd,
  quoted,
} from "../core/routeros";

export const systemConfigTools: ToolModule = [
  // ── Console `/system console` ───────────────────────────────────────────
  defineTool({
    name: "list_system_console",
    title: "List System Console Sessions",
    annotations: READ,
    description:
      "Lists console sessions and virtual terminal entries (`/system console`). " +
      "Use to see which physical or virtual consoles are registered on the device. " +
      "For auto-login rules tied to a console port use `list_special_login`; " +
      "for physical serial port line settings use `list_ports`. " +
      "Returns all console entries or a message when none are configured.",
    async handler(_a, ctx) {
      ctx.info("Listing system console");
      const result = await executeMikrotikCommand("/system console print", ctx);
      return isEmpty(result) ? "No system console entries found." : `SYSTEM CONSOLE:\n\n${result}`;
    },
  }),

  // ── LEDs `/system leds` ─────────────────────────────────────────────────
  defineTool({
    name: "list_leds",
    title: "List LED Triggers",
    annotations: READ,
    description:
      "Lists all hardware LED entries and their configured trigger types (`/system leds`). " +
      "Use to see per-LED assignments (interface-activity, wireless-signal, etc.). " +
      "For the global all-LEDs-off (dark-mode) schedule use `get_leds_settings`. " +
      "Returns each LED's name, type, and trigger settings.",
    async handler(_a, ctx) {
      ctx.info("Listing LEDs");
      const result = await executeMikrotikCommand("/system leds print", ctx);
      return isEmpty(result) ? "No LEDs found on this device." : `LEDS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_leds_settings",
    title: "Get Global LED Settings",
    annotations: READ,
    description:
      "Reads the global LED behaviour settings (`/system leds settings`). " +
      "Use to check the dark-mode schedule (all-leds-off). " +
      "For per-LED trigger assignments use `list_leds`; to change this setting use `set_leds_settings`. " +
      "Returns the current all-leds-off value.",
    async handler(_a, ctx) {
      ctx.info("Getting LED settings");
      const result = await executeMikrotikCommand("/system leds settings print", ctx);
      return isEmpty(result) ? "No LED settings found." : `LED SETTINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_leds_settings",
    title: "Set Global LED Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Writes the global LED behaviour settings (`/system leds settings set`). " +
      "Use to enable dark mode by scheduling all LEDs off. " +
      "For per-LED trigger assignments use `list_leds`; to read current settings use `get_leds_settings`. " +
      "Accepts `all_leds_off`: `never` | `immediate` | `after-1h` | `after-1min`. " +
      "Returns the updated settings on success.",
    inputSchema: {
      all_leds_off: z
        .enum(["never", "immediate", "after-1h", "after-1min"])
        .optional()
        .describe("When to turn all LEDs off (dark mode)"),
    },
    async handler(a, ctx) {
      ctx.info("Setting LED settings");
      if (a.all_leds_off === undefined) return "No updates specified.";

      const cmd = new Cmd("/system leds settings set").opt("all-leds-off", a.all_leds_off).build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to set LED settings: ${result}`;

      const details = await executeMikrotikCommand("/system leds settings print", ctx);
      return `LED settings updated successfully:\n\n${details}`;
    },
  }),

  // ── License `/system license` ───────────────────────────────────────────
  defineTool({
    name: "get_license",
    title: "Get RouterOS License",
    annotations: READ,
    description:
      "Reads the RouterOS software license details (`/system license`). " +
      "Use to check the license level and expiry — on CHR shows the level (free/P1/P10/etc.) and deadline; " +
      "on RouterBOARD hardware the menu may be absent. " +
      "For general system identity or resource info use the system identity/resource tools. " +
      "Returns license info, or a friendly unavailable message on unsupported hardware.",
    async handler(_a, ctx) {
      ctx.info("Getting system license");
      const result = await executeMikrotikCommand("/system license print", ctx);
      if (commandUnsupported(result)) return "License info not available on this device.";
      return isEmpty(result) ? "No license information found." : `LICENSE:\n\n${result}`;
    },
  }),

  // ── Note `/system note` ─────────────────────────────────────────────────
  defineTool({
    name: "get_note",
    title: "Get System Login Note",
    annotations: READ,
    description:
      "Reads the system-wide login banner text (`/system note`). " +
      "Use to retrieve the message shown to all users at login. " +
      "To change the note use `set_note`. " +
      "Returns the note text and the show-at-login flag.",
    async handler(_a, ctx) {
      ctx.info("Getting system note");
      const result = await executeMikrotikCommand("/system note print", ctx);
      return isEmpty(result) ? "No system note found." : `SYSTEM NOTE:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_note",
    title: "Set System Login Note",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Writes the system-wide login banner text (`/system note set`). " +
      "Use to set or clear the message displayed to users at login. " +
      "To read the current note use `get_note`. " +
      "Accepts optional `note` (text string) and `show_at_login` (boolean). " +
      "Returns the updated note on success.",
    inputSchema: {
      note: z.string().optional().describe("The note text to display"),
      show_at_login: z.boolean().optional().describe("Show the note on login"),
    },
    async handler(a, ctx) {
      ctx.info("Setting system note");
      if (a.note === undefined && a.show_at_login === undefined) return "No updates specified.";

      const cmd = new Cmd("/system note set")
        .opt("note", a.note)
        .bool("show-at-login", a.show_at_login)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to set system note: ${result}`;

      const details = await executeMikrotikCommand("/system note print", ctx);
      return `System note updated successfully:\n\n${details}`;
    },
  }),

  // ── NTP server `/system ntp server` (RouterOS 7) ────────────────────────
  defineTool({
    name: "get_ntp_server",
    title: "Get Built-In NTP Server Configuration",
    annotations: READ,
    description:
      "Reads the device's built-in NTP *server* configuration (`/system ntp server`, RouterOS 7+). " +
      "Use to check whether the router is advertising time to LAN clients via broadcast/multicast/manycast. " +
      "This tool reads the local NTP *server* role; for the NTP *client* (upstream time sources) " +
      "use the NTP client tools in the system module. " +
      "Falls back with a friendly message on RouterOS 6 where this menu is absent. " +
      "Returns server enabled state and mode flags.",
    async handler(_a, ctx) {
      ctx.info("Getting NTP server configuration");
      const result = await executeMikrotikCommand("/system ntp server print", ctx);
      if (commandUnsupported(result))
        return "NTP server is not available on this RouterOS version.";
      return isEmpty(result) ? "No NTP server information found." : `NTP SERVER:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_ntp_server",
    title: "Configure Built-In NTP Server",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Writes the device's built-in NTP *server* settings (`/system ntp server set`, RouterOS 7+). " +
      "Use to enable the router as a time server for LAN clients via broadcast, multicast, or manycast. " +
      "This tool configures the local NTP *server* role; to set upstream NTP *client* sources " +
      "use the NTP client tools in the system module. " +
      "Accepts `enabled`, `broadcast`, `multicast`, `manycast` (booleans) and `broadcast_address` (string). " +
      "Returns the updated server configuration on success.",
    inputSchema: {
      enabled: z.boolean().optional().describe("Enable or disable the NTP server"),
      broadcast: z.boolean().optional(),
      multicast: z.boolean().optional(),
      manycast: z.boolean().optional(),
      broadcast_address: z.string().optional().describe("Broadcast address for NTP broadcasts"),
      use_local_clock: z
        .boolean()
        .optional()
        .describe("Serve time from the device's local clock as reference"),
      local_clock_stratum: z
        .number()
        .int()
        .optional()
        .describe("Stratum advertised when using the local clock (1-15)"),
    },
    async handler(a, ctx) {
      ctx.info("Setting NTP server configuration");
      if (
        a.enabled === undefined &&
        a.broadcast === undefined &&
        a.multicast === undefined &&
        a.manycast === undefined &&
        a.broadcast_address === undefined &&
        a.use_local_clock === undefined &&
        a.local_clock_stratum === undefined
      ) {
        return "No updates specified.";
      }

      const cmd = new Cmd("/system ntp server set")
        .bool("enabled", a.enabled)
        .bool("broadcast", a.broadcast)
        .bool("multicast", a.multicast)
        .bool("manycast", a.manycast)
        .opt("broadcast-address", a.broadcast_address)
        .bool("use-local-clock", a.use_local_clock)
        .opt("local-clock-stratum", a.local_clock_stratum)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to set NTP server: ${result}`;

      const details = await executeMikrotikCommand("/system ntp server print", ctx);
      return `NTP server updated successfully:\n\n${details}`;
    },
  }),

  // ── Passwords `/password` ───────────────────────────────────────────────
  defineTool({
    name: "change_password",
    title: "Change Current User Password",
    annotations: WRITE,
    description:
      "Changes the password of the currently authenticated user (`/password`). " +
      "Use to rotate the login credential without touching other user accounts; " +
      "passwords are never echoed in the response. " +
      "To manage other users' accounts or create new users use `add_user`. " +
      "Requires `old_password` and `new_password`; returns success or a rejection message (no credentials logged).",
    inputSchema: {
      old_password: z.string().describe("The current password"),
      new_password: z.string().describe("The new password to set"),
    },
    async handler(a, ctx) {
      ctx.info("Changing device password"); // never log the secrets
      const cmd = new Cmd("/password")
        .set("old-password", a.old_password)
        .set("new-password", a.new_password)
        .set("confirm-new-password", a.new_password)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      // Never echo the passwords back, even in the error path.
      if (looksLikeError(result))
        return "Failed to change password: the device rejected the request (check the old password and password policy).";
      return "Password changed successfully.";
    },
  }),

  // ── Serial ports `/port` ────────────────────────────────────────────────
  defineTool({
    name: "list_ports",
    title: "List Serial Ports",
    annotations: READ,
    description:
      "Lists the physical serial ports registered on the device (`/port print`). " +
      "Use to discover available serial ports and their current line settings before reconfiguring. " +
      "For auto-login rules tied to a serial port use `list_special_login`; " +
      "for console session entries use `list_system_console`. " +
      "Accepts optional `name_filter` for partial name match. " +
      "Returns port entries or an empty message when none match.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial port name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing serial ports");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(`/port print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No serial ports found matching the criteria."
        : `SERIAL PORTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_port",
    title: "Get Serial Port Details",
    annotations: READ,
    description:
      "Reads detailed settings for a named serial port (`/port print detail where name=...`). " +
      "Use to inspect baud rate, parity, data/stop bits, and flow control for a specific port. " +
      "For an overview of all ports use `list_ports`; to change settings use `set_port`. " +
      "Requires `name` (e.g. `serial0`). Returns full detail for the named port.",
    inputSchema: {
      name: z.string().describe("Serial port name, e.g. 'serial0'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting serial port details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/port print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Serial port '${a.name}' not found.`
        : `SERIAL PORT DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_port",
    title: "Configure Serial Port Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Writes line settings for a named serial port (`/port set [find name=...]`). " +
      "Use to change baud rate, data bits, parity, stop bits, or flow control on a serial port. " +
      "To read current settings first use `get_port`; for a list of all ports use `list_ports`. " +
      "Requires `name` (e.g. `serial0`), plus optional `baud_rate` (e.g. `115200` or `auto`), " +
      "`data_bits`, `parity` (`none`|`odd`|`even`), `stop_bits`, " +
      "`flow_control` (`none`|`hardware`|`xon-xoff`). " +
      "Returns the updated port detail on success.",
    inputSchema: {
      name: z.string().describe("Serial port name to update"),
      baud_rate: z.string().optional().describe("e.g. '115200' or 'auto'"),
      data_bits: z.number().int().optional(),
      parity: z.enum(["none", "odd", "even"]).optional(),
      stop_bits: z.number().int().optional(),
      flow_control: z.enum(["none", "hardware", "xon-xoff"]).optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Setting serial port: name=${a.name}`);
      if (
        a.baud_rate === undefined &&
        a.data_bits === undefined &&
        a.parity === undefined &&
        a.stop_bits === undefined &&
        a.flow_control === undefined
      ) {
        return "No updates specified.";
      }

      const cmd = new Cmd(`/port set [find name=${quoted(a.name)}]`)
        .opt("baud-rate", a.baud_rate)
        .opt("data-bits", a.data_bits)
        .opt("parity", a.parity)
        .opt("stop-bits", a.stop_bits)
        .opt("flow-control", a.flow_control)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to set serial port: ${result}`;

      const details = await executeMikrotikCommand(
        `/port print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `Serial port updated successfully:\n\n${details}`;
    },
  }),

  // ── Regulatory / country (wireless) ─────────────────────────────────────
  defineTool({
    name: "get_regulatory",
    title: "Get Wireless Regulatory / Country Settings",
    annotations: READ,
    description:
      "Reads wireless radio country and regulatory domain settings (`/interface wifi radio print`). " +
      "Use to check which country code and regulatory profile the Wi-Fi radios are operating under " +
      "(requires the wifiwave2 package — RouterOS 7). " +
      "RouterOS has no `/system regulatory` menu; the country/regulatory data lives on the radio interface. " +
      "Returns regulatory/country info per radio, or a not-available message when no wifiwave2 " +
      "interface is present or a legacy wireless package is installed.",
    async handler(_a, ctx) {
      ctx.info("Getting wireless regulatory / country information");
      const result = await executeMikrotikCommand("/interface wifi radio print", ctx);
      if (commandUnsupported(result)) {
        return "No wireless regulatory/country information is available on this device (no Wi-Fi interface, or a different wireless package).";
      }
      return isEmpty(result)
        ? "No wireless regulatory/country information is available on this device (no Wi-Fi interface, or a different wireless package)."
        : `WIRELESS REGULATORY / COUNTRY:\n\n${result}`;
    },
  }),

  // ── Reset configuration `/system reset-configuration` ───────────────────
  defineTool({
    name: "reset_configuration",
    title: "Factory Reset Device Configuration",
    annotations: DANGEROUS,
    description:
      "Sends a factory-reset command to the device (`/system reset-configuration`). " +
      "Use ONLY to wipe the entire configuration and reboot into defaults — " +
      "the SSH connection will drop immediately after and all config will be lost. " +
      "Requires `confirm=true`; without it the command is blocked. " +
      "Optional: `keep_users` (preserve user accounts), `no_defaults` (skip loading default config), " +
      "`skip_backup` (skip automatic pre-reset backup), `caps_mode` (reset into CAPsMAN-managed CAP mode), " +
      "`run_after_reset` (script to execute post-reboot). " +
      "This operation is irreversible — there is no undo.",
    inputSchema: {
      confirm: z.boolean().describe("Must be true to actually ERASE the configuration"),
      keep_users: z.boolean().optional().describe("Keep existing user accounts after reset"),
      no_defaults: z.boolean().optional().describe("Do not load the default configuration"),
      skip_backup: z.boolean().optional().describe("Skip the automatic backup before reset"),
      caps_mode: z
        .boolean()
        .optional()
        .describe("Reset into CAPsMAN-managed CAP mode instead of standalone"),
      run_after_reset: z.string().optional().describe("Script file to run after reset"),
    },
    async handler(a, ctx) {
      if (!a.confirm) return "Reset not confirmed. Pass confirm=true to ERASE the configuration.";
      ctx.info("Resetting device configuration");
      const cmd = new Cmd("/system reset-configuration")
        .flag("keep-users", a.keep_users)
        .flag("no-defaults", a.no_defaults)
        .flag("skip-backup", a.skip_backup)
        .flag("caps-mode", a.caps_mode)
        .opt("run-after-reset", a.run_after_reset)
        .build();
      await executeMikrotikCommand(cmd, ctx);
      return "Reset command sent — the device will reboot to a default configuration and the connection will drop.";
    },
  }),

  // ── Special login `/system special-login` ───────────────────────────────
  defineTool({
    name: "list_special_login",
    title: "List Special Login Entries",
    annotations: READ,
    description:
      "Lists special-login entries (`/system special-login`). " +
      "Use to see auto-login rules that map a serial/console port to a user account " +
      "(e.g. serial-console auto-login without a password prompt). " +
      "For general console session entries use `list_system_console`; " +
      "for serial port line settings use `list_ports`. " +
      "Returns entries or a not-available message on hardware that lacks this feature.",
    async handler(_a, ctx) {
      ctx.info("Listing special login");
      const result = await executeMikrotikCommand("/system special-login print", ctx);
      if (commandUnsupported(result)) return "Special login is not available on this device.";
      return isEmpty(result) ? "No special-login entries found." : `SPECIAL LOGIN:\n\n${result}`;
    },
  }),

  // ── Watchdog `/system watchdog` ─────────────────────────────────────────
  defineTool({
    name: "get_watchdog",
    title: "Get Watchdog Configuration",
    annotations: READ,
    description:
      "Reads the hardware/software watchdog timer settings (`/system watchdog`). " +
      "Use to check whether the watchdog is enabled, which address it pings to detect hangs, " +
      "and how the supout diagnostic report is configured. " +
      "To change watchdog settings use `set_watchdog`. " +
      "Returns the current watchdog configuration.",
    async handler(_a, ctx) {
      ctx.info("Getting watchdog configuration");
      const result = await executeMikrotikCommand("/system watchdog print", ctx);
      return isEmpty(result) ? "No watchdog information found." : `WATCHDOG:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_watchdog",
    title: "Configure Watchdog Timer",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Writes the hardware/software watchdog timer settings (`/system watchdog set`). " +
      "Use to enable automatic reboots when the device becomes unresponsive " +
      "(triggered when pings to `watch_address` fail). " +
      "To read current settings use `get_watchdog`. " +
      "Accepts `watchdog_timer` (enable HW watchdog), `watch_address` (IP to ping), " +
      "`ping_timeout` (e.g. `1m`), `no_ping_delay` (e.g. `5m`), " +
      "`automatic_supout` (generate diagnostic file on crash), " +
      "`auto_send_supout` (email the diagnostic). " +
      "Returns the updated watchdog configuration on success.",
    inputSchema: {
      watchdog_timer: z.boolean().optional().describe("Enable the hardware watchdog timer"),
      watch_address: z.string().optional().describe("Address to ping; reboot if unreachable"),
      ping_timeout: z.string().optional().describe("e.g. '1m'"),
      no_ping_delay: z.string().optional().describe("e.g. '5m'"),
      automatic_supout: z
        .boolean()
        .optional()
        .describe("Generate a supout.rif on software failure"),
      auto_send_supout: z.boolean().optional().describe("Email the generated supout.rif"),
    },
    async handler(a, ctx) {
      ctx.info("Setting watchdog configuration");
      if (
        a.watchdog_timer === undefined &&
        a.watch_address === undefined &&
        a.ping_timeout === undefined &&
        a.no_ping_delay === undefined &&
        a.automatic_supout === undefined &&
        a.auto_send_supout === undefined
      ) {
        return "No updates specified.";
      }

      const cmd = new Cmd("/system watchdog set")
        .bool("watchdog-timer", a.watchdog_timer)
        .opt("watch-address", a.watch_address)
        .opt("ping-timeout", a.ping_timeout)
        .opt("no-ping-delay", a.no_ping_delay)
        .bool("automatic-supout", a.automatic_supout)
        .bool("auto-send-supout", a.auto_send_supout)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to set watchdog: ${result}`;

      const details = await executeMikrotikCommand("/system watchdog print", ctx);
      return `Watchdog updated successfully:\n\n${details}`;
    },
  }),
];
