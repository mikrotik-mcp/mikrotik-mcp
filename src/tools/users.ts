/** Users, user groups, active sessions, and SSH keys — `/user`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";
import { redactSecrets } from "../utils";

const VALID_POLICIES = [
  "local",
  "telnet",
  "ssh",
  "ftp",
  "reboot",
  "read",
  "write",
  "policy",
  "test",
  "winbox",
  "password",
  "web",
  "sniff",
  "sensitive",
  "api",
  "romon",
  "dude",
  "tikapp",
  "rest-api",
];

const BUILTIN_GROUPS = ["read", "write", "full"];

interface UpdateUserArgs {
  name: string;
  new_name?: string;
  password?: string;
  group?: string;
  address?: string;
  comment?: string;
  disabled?: boolean;
}

/** Shared by update_user / enable_user / disable_user. */
async function runUpdateUser(
  a: UpdateUserArgs,
  ctx: Parameters<typeof executeMikrotikCommand>[1],
): Promise<string> {
  ctx.info(`Updating user: name=${a.name}`);

  const updates: string[] = [];
  if (a.new_name) updates.push(`name=${quoteValue(a.new_name)}`);
  if (a.password) updates.push(`password=${quoteValue(a.password)}`);
  if (a.group) updates.push(`group=${a.group}`);
  if (a.address !== undefined) updates.push(a.address === "" ? "!address" : `address=${a.address}`);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${a.disabled ? "yes" : "no"}`);

  if (updates.length === 0) return "No updates specified.";

  const cmd = `/user set [find name=${quoted(a.name)}] ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update user: ${result}`;

  const detailsName = a.new_name ?? a.name;
  const details = await executeMikrotikCommand(
    `/user print detail where name=${quoted(detailsName)}`,
    ctx,
  );
  return `User updated successfully:\n\n${redactSecrets(details)}`;
}

export const userTools: ToolModule = [
  defineTool({
    name: "add_user",
    title: "Add Local User Account",
    annotations: WRITE,
    description:
      "Create a local user account (`/user add`) — grants interactive access to the router via SSH, Winbox, web, telnet, or API. " +
      "The `group` parameter (default: `read`) sets permissions; built-in groups are `read`, `write`, `full`; use `add_user_group` to create custom groups. " +
      "Use `address` to restrict login to a specific IP/subnet. For PPP/dial-in credentials use `create_ppp_secret` instead. " +
      "Returns the created account's full detail including its `.id`.",
    inputSchema: {
      name: z.string(),
      password: z.string(),
      group: z.string().default("read"),
      address: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding user: name=${a.name}, group=${a.group}`);
      const cmd = new Cmd("/user add")
        .set("name", a.name)
        .set("password", a.password)
        .set("group", a.group)
        .opt("address", a.address)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);

      if (result.trim()) {
        if (result.includes("*") || /^\d+$/.test(result.trim())) {
          const userId = result.trim();
          const details = await executeMikrotikCommand(
            `/user print detail where .id=${userId}`,
            ctx,
          );
          if (details.trim()) return `User created successfully:\n\n${redactSecrets(details)}`;
          return `User created with ID: ${result}`;
        }
        return `Failed to create user: ${result}`;
      }

      const details = await executeMikrotikCommand(
        `/user print detail where name=${quoted(a.name)}`,
        ctx,
      );
      if (details.trim()) return `User created successfully:\n\n${redactSecrets(details)}`;
      return "User creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_users",
    title: "List Local User Accounts",
    annotations: READ,
    description:
      "List local router user accounts (`/user print`) — shows each account's group, address restriction, and enabled/disabled state. " +
      "Supports optional filters: `name_filter` (name substring match), `group_filter` (exact group name), `disabled_only`. " +
      "Note: `active_only` is accepted by the schema but is not applied as a filter — it has no effect on the output. " +
      "Passwords are redacted from output. For currently logged-in sessions use `get_active_users`. For PPP dial-in secrets use `create_ppp_secret`.",
    inputSchema: {
      name_filter: z.string().optional(),
      group_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      active_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Listing users with filters: name=${a.name_filter}, group=${a.group_filter}`);
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.group_filter) filters.push(`group=${quoted(a.group_filter)}`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(`/user print${whereClause(filters)}`, ctx);
      if (isEmpty(result)) return "No users found matching the criteria.";
      return `USERS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_user",
    title: "Get Local User Account Details",
    annotations: READ,
    description:
      "Fetch full detail for a single local user account (`/user print detail where name=...`). " +
      "Identified by login `name`. Passwords are redacted from output. " +
      "For all accounts use `list_users`; for currently active sessions use `get_active_users`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting user details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/user print detail where name=${quoted(a.name)}`,
        ctx,
      );
      if (isEmpty(result)) return `User '${a.name}' not found.`;
      return `USER DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "update_user",
    title: "Update Local User Account",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify a local user account (`/user set [find name=...]`). " +
      "Can change login name (`new_name`), `password`, `group`, allowed source `address` (pass empty string to remove address restriction), `comment`, or `disabled` state. " +
      "For toggling enabled/disabled state only, prefer `enable_user` or `disable_user`. " +
      "Returns the updated user detail with passwords redacted.",
    inputSchema: {
      name: z.string(),
      new_name: z.string().optional(),
      password: z.string().optional(),
      group: z.string().optional(),
      address: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      return runUpdateUser(a, ctx);
    },
  }),

  defineTool({
    name: "remove_user",
    title: "Remove Local User Account",
    annotations: DESTRUCTIVE,
    description:
      "Permanently delete a local user account (`/user remove [find name=...]`). " +
      "Refuses to remove the built-in `admin` account. Verifies the user exists before removing. " +
      "To temporarily block access without deleting use `disable_user`. To end a live session without deleting the account use `disconnect_user`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing user: name=${a.name}`);

      // Don't allow removal of admin user
      if (a.name.toLowerCase() === "admin") return "Cannot remove the admin user.";

      const count = await executeMikrotikCommand(
        `/user print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `User '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/user remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove user: ${result}`;
      return `User '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "disable_user",
    title: "Disable Local User Account",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disable a local user account (`/user set [find name=...] disabled=yes`), preventing new logins without deleting the account. " +
      "To re-enable use `enable_user`. For a full attribute update use `update_user`. To permanently delete the account use `remove_user`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      return runUpdateUser({ name: a.name, disabled: true }, ctx);
    },
  }),

  defineTool({
    name: "enable_user",
    title: "Enable Local User Account",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-enable a previously disabled local user account (`/user set [find name=...] disabled=no`). " +
      "To disable use `disable_user`. For a full attribute update use `update_user`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      return runUpdateUser({ name: a.name, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "add_user_group",
    title: "Add User Group",
    annotations: WRITE,
    description:
      "Create a custom user group (`/user group add`) that defines a named permission policy for router access. " +
      "`policy` is a list of permissions to grant from: local, telnet, ssh, ftp, reboot, read, write, policy, test, winbox, password, web, sniff, sensitive, api, romon, dude, tikapp, rest-api. " +
      "The built-in groups (`read`, `write`, `full`) already exist on the device; this tool does not guard against those names — attempting to create a group with a duplicate name will be rejected by the device. Assign users to the new group via `add_user` or `update_user`. " +
      "Returns the created group's full detail.",
    inputSchema: {
      name: z.string(),
      policy: z.array(z.string()),
      skin: z.string().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding user group: name=${a.name}`);

      // Validate policies
      for (const p of a.policy) {
        if (!VALID_POLICIES.includes(p)) {
          return `Invalid policy: ${p}. Valid policies: ${VALID_POLICIES.join(", ")}`;
        }
      }

      const cmd = new Cmd("/user group add")
        .set("name", a.name)
        .set("policy", a.policy.join(","))
        .opt("skin", a.skin)
        .opt("comment", a.comment)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);

      if (result.trim()) {
        if (result.includes("*") || /^\d+$/.test(result.trim())) {
          const groupId = result.trim();
          const details = await executeMikrotikCommand(
            `/user group print detail where .id=${groupId}`,
            ctx,
          );
          if (details.trim()) return `User group created successfully:\n\n${details}`;
          return `User group created with ID: ${result}`;
        }
        return `Failed to create user group: ${result}`;
      }

      const details = await executeMikrotikCommand(
        `/user group print detail where name=${quoted(a.name)}`,
        ctx,
      );
      if (details.trim()) return `User group created successfully:\n\n${details}`;
      return "User group creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "list_user_groups",
    title: "List User Groups",
    annotations: READ,
    description:
      "List all user groups (`/user group print`), including built-in groups (`read`, `write`, `full`) and custom ones, showing their policy sets. " +
      "Supports optional filters: `name_filter` (name substring), `policy_filter` (policy substring). " +
      "To see individual user accounts use `list_users`; to see which users belong to a specific group use `list_users` with `group_filter`.",
    inputSchema: {
      name_filter: z.string().optional(),
      policy_filter: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Listing user groups with filters: name=${a.name_filter}`);
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);
      if (a.policy_filter) filters.push(`policy~${quoted(a.policy_filter)}`);

      const result = await executeMikrotikCommand(`/user group print${whereClause(filters)}`, ctx);
      if (isEmpty(result)) return "No user groups found matching the criteria.";
      return `USER GROUPS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_user_group",
    title: "Get User Group Details",
    annotations: READ,
    description:
      "Fetch full detail for a single user group (`/user group print detail where name=...`), showing its complete policy list and skin setting. " +
      "For all groups use `list_user_groups`. To see which users belong to this group use `list_users` with `group_filter`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting user group details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/user group print detail where name=${quoted(a.name)}`,
        ctx,
      );
      if (isEmpty(result)) return `User group '${a.name}' not found.`;
      return `USER GROUP DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_user_group",
    title: "Update User Group",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify a custom user group (`/user group set [find name=...]`). " +
      "Can change group name (`new_name`), `policy` list, `skin`, or `comment`. " +
      "Refuses to modify built-in groups (`read`, `write`, `full`). " +
      "Valid policies: local, telnet, ssh, ftp, reboot, read, write, policy, test, winbox, password, web, sniff, sensitive, api, romon, dude, tikapp, rest-api. " +
      "Returns the updated group detail.",
    inputSchema: {
      name: z.string(),
      new_name: z.string().optional(),
      policy: z.array(z.string()).optional(),
      skin: z.string().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating user group: name=${a.name}`);

      // Don't allow modification of built-in groups
      if (BUILTIN_GROUPS.includes(a.name)) return `Cannot modify built-in group '${a.name}'.`;

      const updates: string[] = [];
      if (a.new_name) updates.push(`name=${quoteValue(a.new_name)}`);
      if (a.policy && a.policy.length) updates.push(`policy=${a.policy.join(",")}`);
      if (a.skin !== undefined)
        updates.push(a.skin === "" ? "!skin" : `skin=${quoteValue(a.skin)}`);
      if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);

      if (updates.length === 0) return "No updates specified.";

      const cmd = `/user group set [find name=${quoted(a.name)}] ${updates.join(" ")}`;
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update user group: ${result}`;

      const detailsName = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/user group print detail where name=${quoted(detailsName)}`,
        ctx,
      );
      return `User group updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_user_group",
    title: "Remove User Group",
    annotations: DESTRUCTIVE,
    description:
      "Delete a custom user group (`/user group remove [find name=...]`). " +
      "Refuses to remove built-in groups (`read`, `write`, `full`). " +
      "Checks that no users are currently assigned to the group — reassign or remove those users first via `update_user` or `remove_user`. " +
      "To remove individual user accounts use `remove_user`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing user group: name=${a.name}`);

      // Don't allow removal of built-in groups
      if (BUILTIN_GROUPS.includes(a.name)) return `Cannot remove built-in group '${a.name}'.`;

      const count = await executeMikrotikCommand(
        `/user group print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `User group '${a.name}' not found.`;

      // Check if group is in use
      const usersCount = await executeMikrotikCommand(
        `/user print count-only where group=${quoted(a.name)}`,
        ctx,
      );
      if (usersCount.trim() !== "0") {
        return `Cannot remove group '${a.name}': ${usersCount.trim()} users are using this group.`;
      }

      const result = await executeMikrotikCommand(
        `/user group remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove user group: ${result}`;
      return `User group '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "get_active_users",
    title: "List Active User Sessions",
    annotations: READ,
    description:
      "List currently logged-in user sessions (`/user active print`), showing who is connected right now via SSH, Winbox, web, telnet, or API, with source address and session start time. " +
      "For the full account list use `list_users`. To forcibly end a session use `disconnect_user` with the `.id` from this output.",
    async handler(_a, ctx) {
      ctx.info("Getting active users");
      const result = await executeMikrotikCommand("/user active print", ctx);
      if (isEmpty(result)) return "No active users found.";
      return `ACTIVE USERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "disconnect_user",
    title: "Disconnect Active User Session",
    annotations: DESTRUCTIVE,
    description:
      "Forcibly terminate an active user session (`/user active remove <user_id>`). " +
      "`user_id` is the `.id` from `get_active_users`. " +
      "Does NOT delete the user account — to delete the account use `remove_user`. To prevent future logins without deleting use `disable_user`.",
    inputSchema: { user_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Disconnecting user: user_id=${a.user_id}`);
      const result = await executeMikrotikCommand(`/user active remove ${a.user_id}`, ctx);
      if (looksLikeError(result)) return `Failed to disconnect user: ${result}`;
      return `User session ${a.user_id} disconnected successfully.`;
    },
  }),

  defineTool({
    name: "export_user_config",
    title: "Export User Configuration to File",
    annotations: READ,
    description:
      "Export the router's user accounts and user-group configuration as a RouterOS script (`/user export file=<filename>`). " +
      "The file is saved on the router's flash storage as `<filename>.rsc`. If `filename` is omitted, defaults to `user_config`. " +
      "The exported script can be used to restore user accounts on another device.",
    inputSchema: { filename: z.string().optional() },
    async handler(a, ctx) {
      ctx.info("Exporting user configuration");
      const filename = a.filename || "user_config";
      const result = await executeMikrotikCommand(`/user export file=${filename}`, ctx);
      if (!result.trim()) return `User configuration exported to ${filename}.rsc`;
      return `Export result: ${result}`;
    },
  }),

  defineTool({
    name: "set_user_ssh_keys",
    title: "Import SSH Public Key for User",
    annotations: WRITE,
    description:
      "Import an SSH public key for a user (`/user ssh-keys import user=... public-key-file=...`), enabling key-based SSH authentication in addition to password login. " +
      "`key_file` must be the path to a public key file already present on the router's filesystem. " +
      "To list a user's existing keys use `list_user_ssh_keys`; to remove a key use `remove_user_ssh_key`.",
    inputSchema: {
      username: z.string(),
      key_file: z.string(),
    },
    async handler(a, ctx) {
      ctx.info(`Setting SSH keys for user: ${a.username}`);
      const cmd = `/user ssh-keys import user=${quoted(a.username)} public-key-file=${quoted(a.key_file)}`;
      const result = await executeMikrotikCommand(cmd, ctx);
      if (!result.trim() || result.toLowerCase().includes("imported")) {
        return `SSH key imported successfully for user '${a.username}'.`;
      }
      return `Failed to import SSH key: ${result}`;
    },
  }),

  defineTool({
    name: "list_user_ssh_keys",
    title: "List User SSH Keys",
    annotations: READ,
    description:
      "List SSH public keys registered for a specific user (`/user ssh-keys print where user=...`). " +
      "Returns each key's `.id`, which is required by `remove_user_ssh_key`. To add a key use `set_user_ssh_keys`.",
    inputSchema: { username: z.string() },
    async handler(a, ctx) {
      ctx.info(`Listing SSH keys for user: ${a.username}`);
      const result = await executeMikrotikCommand(
        `/user ssh-keys print where user=${quoted(a.username)}`,
        ctx,
      );
      if (isEmpty(result)) return `No SSH keys found for user '${a.username}'.`;
      return `SSH KEYS for ${a.username}:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_user_ssh_key",
    title: "Remove User SSH Key",
    annotations: DESTRUCTIVE,
    description:
      "Delete a specific SSH public key (`/user ssh-keys remove <key_id>`). " +
      "`key_id` is the `.id` from `list_user_ssh_keys`. " +
      "Does NOT disable the user's password-based login — to block all logins use `disable_user`; to delete the account use `remove_user`.",
    inputSchema: { key_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing SSH key: key_id=${a.key_id}`);
      const result = await executeMikrotikCommand(`/user ssh-keys remove ${a.key_id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove SSH key: ${result}`;
      return `SSH key ${a.key_id} removed successfully.`;
    },
  }),
];
