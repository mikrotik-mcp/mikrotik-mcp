/**
 * RouterOS v7 User Manager — `/user-manager`.
 *
 * The built-in RADIUS server (settings, users, profiles, user-profile
 * assignments, RADIUS clients/routers, limitations and sessions). The
 * `user-manager` package may not be installed; read tools detect that via
 * `commandUnsupported` and return a friendly message instead of a raw error.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import {
  WRITE_IDEMPOTENT,
  WRITE,
  READ,
  DESTRUCTIVE,
  defineTool,
  withRequires,
} from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, commandUnsupported, Cmd } from "../core/routeros";
import { redactSecrets } from "../utils";

const NOT_AVAILABLE = "User Manager is not available on this device (package not installed).";

const userManagerToolsDefs: ToolModule = [
  // ── SETTINGS `/user-manager` ──────────────────────────────────────────────
  defineTool({
    name: "get_user_manager_settings",
    title: "Get User Manager Global Settings",
    annotations: READ,
    description:
      "Reads the global User Manager daemon configuration (`/user-manager print`) — the top-level" +
      " `enabled` flag, TLS certificate, and whether the profile/payment subsystem is active" +
      " (`use-profiles`). Use this to inspect whether the built-in RADIUS server is running before" +
      " calling any other user-manager tools. Returns the current settings block, or a NOT_AVAILABLE" +
      " message if the user-manager package is not installed on the device.",
    async handler(_a, ctx) {
      ctx.info("Getting User Manager settings");
      const result = await executeMikrotikCommand("/user-manager print", ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No User Manager settings found."
        : `USER MANAGER SETTINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "set_user_manager_settings",
    title: "Set User Manager Global Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates the global User Manager daemon configuration (`/user-manager set`) — toggle the" +
      " built-in RADIUS server on/off (`enabled`), set the TLS certificate, or enable the" +
      " profile/payment subsystem (`use_profiles`). Applies changes idempotently to the single" +
      " global settings entry; returns the full updated settings after applying. For per-user" +
      " changes use update_user_manager_user; for profile creation use add_user_manager_profile.",
    inputSchema: {
      enabled: z.boolean().optional().describe("Enable or disable the User Manager server"),
      certificate: z.string().optional().describe("TLS certificate name for RADIUS over TLS"),
      radsec_certificate: z
        .string()
        .optional()
        .describe("Certificate name for RadSec (RADIUS over TLS)"),
      accounting_port: z.number().int().optional().describe("UDP port for RADIUS accounting"),
      authentication_port: z
        .number()
        .int()
        .optional()
        .describe("UDP port for RADIUS authentication"),
      use_profiles: z.boolean().optional().describe("Enable the profile/payment subsystem"),
    },
    async handler(a, ctx) {
      ctx.info("Updating User Manager settings");
      const cmd = new Cmd("/user-manager set")
        .bool("enabled", a.enabled)
        .opt("certificate", a.certificate)
        .opt("radsec-certificate", a.radsec_certificate)
        .opt("accounting-port", a.accounting_port)
        .opt("authentication-port", a.authentication_port)
        .bool("use-profiles", a.use_profiles)
        .build();
      if (cmd === "/user-manager set") return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to update User Manager settings: ${result}`;

      const details = await executeMikrotikCommand("/user-manager print", ctx);
      return `User Manager settings updated successfully:\n\n${details}`;
    },
  }),

  // ── USERS `/user-manager user` ────────────────────────────────────────────
  defineTool({
    name: "add_user_manager_user",
    title: "Add User Manager RADIUS User",
    annotations: WRITE,
    description:
      "Creates a new user in the User Manager RADIUS database (`/user-manager user add`) — for" +
      " hotspot, PPP, or 802.1X authentication managed by the built-in RADIUS server. Not for" +
      " local router login accounts; for those use add_user. Supply `name` and `password`;" +
      " optionally set `group`, `shared_users` (max simultaneous sessions), and custom RADIUS" +
      " `attributes`. Returns the created user's detail with secrets redacted.",
    inputSchema: {
      name: z.string().describe("Login name for the user"),
      password: z.string().describe("Login password for the user"),
      group: z.string().optional(),
      shared_users: z.number().int().optional().describe("Max simultaneous sessions"),
      attributes: z.string().optional().describe("Custom RADIUS attributes"),
      caller_id: z.string().optional().describe("Caller ID the user is restricted to (e.g. MAC)"),
      otp_secret: z.string().optional().describe("Base32 OTP shared secret for two-factor auth"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding User Manager user: name=${a.name}`);
      const cmd = new Cmd("/user-manager user add")
        .set("name", a.name)
        .set("password", a.password)
        .opt("group", a.group)
        .opt("shared-users", a.shared_users)
        .opt("attributes", a.attributes)
        .opt("caller-id", a.caller_id)
        .opt("otp-secret", a.otp_secret)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add User Manager user: ${result}`;

      const details = await executeMikrotikCommand(
        `/user-manager user print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `User Manager user created successfully:\n\n${redactSecrets(details)}`
        : "User Manager user creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_user_manager_users",
    title: "List User Manager RADIUS Users",
    annotations: READ,
    description:
      "Returns all users in the User Manager RADIUS database (`/user-manager user print`) — the" +
      " accounts that authenticate against the built-in RADIUS server for hotspot, PPP, or 802.1X." +
      " Optionally filter by partial `name_filter`. Not for local router login accounts; for those" +
      " use list_users. Returns user list with secrets redacted; for full" +
      " single-user detail use get_user_manager_user.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing User Manager users");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);

      const result = await executeMikrotikCommand(
        `/user-manager user print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No User Manager users found matching the criteria."
        : `USER MANAGER USERS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_user_manager_user",
    title: "Get User Manager RADIUS User Detail",
    annotations: READ,
    description:
      "Returns full detail for a single User Manager RADIUS user" +
      " (`/user-manager user print detail where name=`) — all fields including group," +
      " shared-users limit, RADIUS attributes, and status, with secrets redacted. Use when you" +
      " need the complete record for one user by exact name. To browse all users use" +
      " list_user_manager_users; to modify the record use update_user_manager_user.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting User Manager user details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/user-manager user print detail where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? `User Manager user '${a.name}' not found.`
        : `USER MANAGER USER DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "update_user_manager_user",
    title: "Update User Manager RADIUS User",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing User Manager RADIUS user (`/user-manager user set [find name=...]`)" +
      " — change name, password, group, shared-users limit, RADIUS attributes, comment, or" +
      " enabled/disabled state. Locate the user by its current `name` (from" +
      " list_user_manager_users or get_user_manager_user). Returns the updated record with" +
      " secrets redacted. To permanently delete the user use remove_user_manager_user.",
    inputSchema: {
      name: z.string().describe("Current name of the user to update"),
      new_name: z.string().optional(),
      password: z.string().optional(),
      group: z.string().optional(),
      shared_users: z.number().int().optional(),
      attributes: z.string().optional(),
      caller_id: z.string().optional().describe("Caller ID the user is restricted to (e.g. MAC)"),
      otp_secret: z.string().optional().describe("Base32 OTP shared secret for two-factor auth"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating User Manager user: name=${a.name}`);
      const cmd = new Cmd(`/user-manager user set [find name="${a.name}"]`)
        .opt("name", a.new_name)
        .opt("password", a.password)
        .opt("group", a.group)
        .opt("shared-users", a.shared_users)
        .opt("attributes", a.attributes)
        .opt("caller-id", a.caller_id)
        .opt("otp-secret", a.otp_secret)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .build();
      if (!cmd.includes("=", cmd.indexOf("]"))) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to update User Manager user: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/user-manager user print detail where name="${target}"`,
        ctx,
      );
      return `User Manager user updated successfully:\n\n${redactSecrets(details)}`;
    },
  }),

  defineTool({
    name: "remove_user_manager_user",
    title: "Remove User Manager RADIUS User",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a User Manager RADIUS user (`/user-manager user remove [find name=...]`)" +
      " — verifies the user exists via count-only check first, then removes them. Does NOT" +
      " automatically remove the user's profile assignments; check list_user_manager_user_profiles" +
      " first. To disable without deleting use update_user_manager_user with `disabled=true`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing User Manager user: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/user-manager user print count-only where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `User Manager user '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/user-manager user remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove User Manager user: ${result}`;
      return `User Manager user '${a.name}' removed successfully.`;
    },
  }),

  // ── PROFILES `/user-manager profile` ──────────────────────────────────────
  defineTool({
    name: "add_user_manager_profile",
    title: "Add User Manager Service Profile",
    annotations: WRITE,
    description:
      "Creates a new User Manager service/billing profile (`/user-manager profile add`) — a named" +
      " plan template that defines validity period (e.g. '30d'), price, and session override" +
      " limits (`starts_when`, `override_shared_users`) that can be assigned to users. Profiles are" +
      " templates only; to link a profile to a specific user use assign_user_manager_profile. For" +
      " rate/quota constraints attach a limitation (add_user_manager_limitation). Returns the" +
      " created profile's detail.",
    inputSchema: {
      name: z.string().describe("Profile name"),
      name_for_users: z.string().optional().describe("Display name shown to users"),
      validity: z.string().optional().describe("Validity period, e.g. '30d'"),
      price: z.number().optional(),
      starts_when: z.enum(["assigned", "first-auth"]).optional(),
      override_shared_users: z.string().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding User Manager profile: name=${a.name}`);
      const cmd = new Cmd("/user-manager profile add")
        .set("name", a.name)
        .opt("name-for-users", a.name_for_users)
        .opt("validity", a.validity)
        .opt("price", a.price)
        .opt("starts-when", a.starts_when)
        .opt("override-shared-users", a.override_shared_users)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add User Manager profile: ${result}`;

      const details = await executeMikrotikCommand(
        `/user-manager profile print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `User Manager profile created successfully:\n\n${details}`
        : "User Manager profile creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_user_manager_profiles",
    title: "List User Manager Service Profiles",
    annotations: READ,
    description:
      "Returns all User Manager service/billing profile templates (`/user-manager profile print`)" +
      " — the named plans defining validity, price, and session limits. Optionally filter by" +
      " partial `name_filter`. Not the same as user-profile assignments; to see which profiles" +
      " are linked to which users use list_user_manager_user_profiles. Returns profile list.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing User Manager profiles");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);

      const result = await executeMikrotikCommand(
        `/user-manager profile print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No User Manager profiles found matching the criteria."
        : `USER MANAGER PROFILES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_user_manager_profile",
    title: "Remove User Manager Service Profile",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a User Manager service/billing profile" +
      " (`/user-manager profile remove [find name=...]`) — verifies existence via count-only check" +
      " first, then removes the plan template. Does NOT automatically remove existing user-profile" +
      " assignments that reference this profile; check list_user_manager_user_profiles before" +
      " removing to avoid orphaned assignments. For creating a profile use add_user_manager_profile.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing User Manager profile: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/user-manager profile print count-only where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `User Manager profile '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/user-manager profile remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove User Manager profile: ${result}`;
      return `User Manager profile '${a.name}' removed successfully.`;
    },
  }),

  // ── USER-PROFILE ASSIGNMENT `/user-manager user-profile` ──────────────────
  defineTool({
    name: "assign_user_manager_profile",
    title: "Assign Service Profile to User Manager User",
    annotations: WRITE,
    description:
      "Creates a user-profile assignment in User Manager (`/user-manager user-profile add`) —" +
      " links an existing service profile plan to a specific user so the user inherits the plan's" +
      " limits (rate, transfer, validity). Both `user` and `profile` must already exist; to create" +
      " a user use add_user_manager_user; to create a profile use add_user_manager_profile. To view" +
      " existing assignments use list_user_manager_user_profiles.",
    inputSchema: {
      user: z.string().describe("User to assign the profile to"),
      profile: z.string().describe("Profile to assign"),
    },
    async handler(a, ctx) {
      ctx.info(`Assigning profile '${a.profile}' to user '${a.user}'`);
      const cmd = new Cmd("/user-manager user-profile add")
        .set("user", a.user)
        .set("profile", a.profile)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to assign profile: ${result}`;
      return `Assigned profile '${a.profile}' to user '${a.user}'.\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_user_manager_user_profiles",
    title: "List User Manager User-Profile Assignments",
    annotations: READ,
    description:
      "Returns all User Manager user-to-profile assignment records" +
      " (`/user-manager user-profile print`) — shows which service profile plan is linked to each" +
      " user. Optionally filter by partial `user_filter`. Not the same as listing profile" +
      " definitions; for the plan templates themselves use list_user_manager_profiles. To create an" +
      " assignment use assign_user_manager_profile.",
    inputSchema: {
      user_filter: z.string().optional().describe("Partial user match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing User Manager user-profiles");
      const filters: string[] = [];
      if (a.user_filter) filters.push(`user~"${a.user_filter}"`);

      const result = await executeMikrotikCommand(
        `/user-manager user-profile print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No User Manager user-profiles found matching the criteria."
        : `USER MANAGER USER-PROFILES:\n\n${result}`;
    },
  }),

  // ── ROUTERS (RADIUS clients / NAS) `/user-manager router` ─────────────────
  defineTool({
    name: "add_user_manager_router",
    title: "Add User Manager RADIUS Client (Router/NAS)",
    annotations: WRITE,
    description:
      "Registers a new RADIUS client (router or NAS device) in User Manager" +
      " (`/user-manager router add`) — the network device that forwards authentication requests to" +
      " this built-in RADIUS server. Requires a friendly `name`, the client's IP `address`, and a" +
      " `shared_secret`; optionally set the CoA port. Not related to IP routing; for routing table" +
      " entries use add_route. Returns the created entry with secrets redacted.",
    inputSchema: {
      name: z.string().describe("Friendly name for the RADIUS client"),
      address: z.string().describe("IP address of the RADIUS client"),
      shared_secret: z.string().describe("Shared secret for the RADIUS client"),
      coa_port: z.number().int().optional().describe("Change-of-Authorization port"),
      protocol: z
        .string()
        .optional()
        .describe("RADIUS transport protocol for this client (e.g. radius, radsec)"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding User Manager router: name=${a.name}, address=${a.address}`);
      const cmd = new Cmd("/user-manager router add")
        .set("name", a.name)
        .set("address", a.address)
        .set("shared-secret", a.shared_secret)
        .opt("coa-port", a.coa_port)
        .opt("protocol", a.protocol)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add User Manager router: ${result}`;

      const details = await executeMikrotikCommand(
        `/user-manager router print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `User Manager router created successfully:\n\n${redactSecrets(details)}`
        : "User Manager router creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_user_manager_routers",
    title: "List User Manager RADIUS Clients (Routers/NAS)",
    annotations: READ,
    description:
      "Returns all RADIUS clients (routers/NAS devices) registered in User Manager" +
      " (`/user-manager router print`) — the devices authorized to forward authentication requests" +
      " to this built-in RADIUS server. Optionally filter by partial `name_filter`. Not related to" +
      " IP routing; for routing table entries use list_routes. Returns entries with secrets redacted.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing User Manager routers");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);

      const result = await executeMikrotikCommand(
        `/user-manager router print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No User Manager routers found matching the criteria."
        : `USER MANAGER ROUTERS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "remove_user_manager_router",
    title: "Remove User Manager RADIUS Client (Router/NAS)",
    annotations: DESTRUCTIVE,
    description:
      "Permanently removes a RADIUS client (router/NAS) from User Manager" +
      " (`/user-manager router remove [find name=...]`) — verifies existence via count-only check" +
      " first, then deletes the entry. The device will no longer be able to forward authentication" +
      " requests to this RADIUS server after removal. Not related to IP routing; for routing table" +
      " management use remove_route.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing User Manager router: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/user-manager router print count-only where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `User Manager router '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/user-manager router remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove User Manager router: ${result}`;
      return `User Manager router '${a.name}' removed successfully.`;
    },
  }),

  // ── LIMITATIONS `/user-manager limitation` ────────────────────────────────
  defineTool({
    name: "add_user_manager_limitation",
    title: "Add User Manager Limitation Template",
    annotations: WRITE,
    description:
      "Creates a new User Manager limitation template (`/user-manager limitation add`) — a reusable" +
      " named set of rate and quota constraints: download rate (`rate_limit_rx`, e.g. '10M')," +
      " upload rate (`rate_limit_tx`), total transfer cap (`transfer_limit`, e.g. '10G'), and" +
      " uptime cap (`uptime_limit`, e.g. '1d'). Limitations are templates attached to profiles, not" +
      " users directly; for service plan templates use add_user_manager_profile. Returns the created" +
      " limitation's detail.",
    inputSchema: {
      name: z.string().describe("Limitation name"),
      rate_limit_rx: z.string().optional().describe("Download rate limit, e.g. '10M'"),
      rate_limit_tx: z.string().optional().describe("Upload rate limit, e.g. '10M'"),
      rate_limit_min_rx: z
        .string()
        .optional()
        .describe("Guaranteed (CIR) download rate, e.g. '2M'"),
      rate_limit_min_tx: z.string().optional().describe("Guaranteed (CIR) upload rate, e.g. '2M'"),
      rate_limit_burst_rx: z.string().optional().describe("Download burst rate, e.g. '20M'"),
      rate_limit_burst_tx: z.string().optional().describe("Upload burst rate, e.g. '20M'"),
      rate_limit_burst_threshold_rx: z
        .string()
        .optional()
        .describe("Download burst threshold rate"),
      rate_limit_burst_threshold_tx: z.string().optional().describe("Upload burst threshold rate"),
      rate_limit_burst_time_rx: z.string().optional().describe("Download burst time, e.g. '10s'"),
      rate_limit_burst_time_tx: z.string().optional().describe("Upload burst time, e.g. '10s'"),
      rate_limit_priority: z.number().int().optional().describe("Queue priority (1-8)"),
      download_limit: z.string().optional().describe("Download transfer cap in bytes, e.g. '5G'"),
      upload_limit: z.string().optional().describe("Upload transfer cap in bytes, e.g. '5G'"),
      transfer_limit: z.string().optional().describe("Total transfer cap, e.g. '10G'"),
      uptime_limit: z.string().optional().describe("Uptime cap, e.g. '1d'"),
      reset_counters_interval: z
        .string()
        .optional()
        .describe("Interval to auto-reset usage counters"),
      reset_counters_start_time: z
        .string()
        .optional()
        .describe("Start time for counter reset interval"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding User Manager limitation: name=${a.name}`);
      const cmd = new Cmd("/user-manager limitation add")
        .set("name", a.name)
        .opt("rate-limit-rx", a.rate_limit_rx)
        .opt("rate-limit-tx", a.rate_limit_tx)
        .opt("rate-limit-min-rx", a.rate_limit_min_rx)
        .opt("rate-limit-min-tx", a.rate_limit_min_tx)
        .opt("rate-limit-burst-rx", a.rate_limit_burst_rx)
        .opt("rate-limit-burst-tx", a.rate_limit_burst_tx)
        .opt("rate-limit-burst-threshold-rx", a.rate_limit_burst_threshold_rx)
        .opt("rate-limit-burst-threshold-tx", a.rate_limit_burst_threshold_tx)
        .opt("rate-limit-burst-time-rx", a.rate_limit_burst_time_rx)
        .opt("rate-limit-burst-time-tx", a.rate_limit_burst_time_tx)
        .opt("rate-limit-priority", a.rate_limit_priority)
        .opt("download-limit", a.download_limit)
        .opt("upload-limit", a.upload_limit)
        .opt("transfer-limit", a.transfer_limit)
        .opt("uptime-limit", a.uptime_limit)
        .opt("reset-counters-interval", a.reset_counters_interval)
        .opt("reset-counters-start-time", a.reset_counters_start_time)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add User Manager limitation: ${result}`;

      const details = await executeMikrotikCommand(
        `/user-manager limitation print detail where name="${a.name}"`,
        ctx,
      );
      return details.trim()
        ? `User Manager limitation created successfully:\n\n${details}`
        : "User Manager limitation creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_user_manager_limitations",
    title: "List User Manager Limitation Templates",
    annotations: READ,
    description:
      "Returns all User Manager limitation templates (`/user-manager limitation print`) — the named" +
      " rate/quota constraint definitions (rate-limit-rx/tx, transfer-limit, uptime-limit) that can" +
      " be attached to service profiles. Optionally filter by partial `name_filter`. Limitations are" +
      " distinct from profile plan templates; for those use list_user_manager_profiles.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing User Manager limitations");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);

      const result = await executeMikrotikCommand(
        `/user-manager limitation print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No User Manager limitations found matching the criteria."
        : `USER MANAGER LIMITATIONS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_user_manager_limitation",
    title: "Remove User Manager Limitation Template",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a User Manager limitation template" +
      " (`/user-manager limitation remove [find name=...]`) — verifies existence via count-only" +
      " check first, then removes the constraint definition. Does NOT check whether the limitation" +
      " is still referenced by any profiles; verify with list_user_manager_profiles before removing" +
      " to avoid orphaned references. For listing limitations use list_user_manager_limitations.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing User Manager limitation: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/user-manager limitation print count-only where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `User Manager limitation '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/user-manager limitation remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove User Manager limitation: ${result}`;
      return `User Manager limitation '${a.name}' removed successfully.`;
    },
  }),

  // ── SESSIONS `/user-manager session` ──────────────────────────────────────
  defineTool({
    name: "list_user_manager_sessions",
    title: "List User Manager Accounting Sessions",
    annotations: READ,
    description:
      "Returns User Manager RADIUS accounting session records (`/user-manager session print`) — the" +
      " log of authentication and accounting events for users connecting through registered RADIUS" +
      " clients. Optionally filter by partial `user_filter` or restrict to currently active sessions" +
      " with `active_only=true`. Returns session data including bytes transferred, uptime, and" +
      " status. For the user accounts themselves use list_user_manager_users; for registered RADIUS" +
      " clients use list_user_manager_routers.",
    inputSchema: {
      user_filter: z.string().optional().describe("Partial user match"),
      active_only: z.boolean().default(false).describe("Only show currently active sessions"),
    },
    async handler(a, ctx) {
      ctx.info("Listing User Manager sessions");
      const filters: string[] = [];
      if (a.user_filter) filters.push(`user~"${a.user_filter}"`);
      if (a.active_only) filters.push("active=yes");

      const result = await executeMikrotikCommand(
        `/user-manager session print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No User Manager sessions found matching the criteria."
        : `USER MANAGER SESSIONS:\n\n${result}`;
    },
  }),
];

// User Manager ships as a separate, optional package.
export const userManagerTools: ToolModule = withRequires(
  { packages: ["user-manager"] },
  userManagerToolsDefs,
);
