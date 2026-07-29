/**
 * Container management — `/container` (RouterOS 7 OCI container subsystem).
 *
 * Covers every part of the container surface:
 *   • `/container`         — the containers: add, list, get, start, stop, set, remove.
 *   • `/container config`  — global settings: registry, tmpdir, RAM, layer dir.
 *   • `/container envs`    — named environment-variable lists.
 *   • `/container mounts`  — named volume mounts.
 *
 * Containers are matched by their `name` (when set) or by `tag~` (the image tag),
 * so every lifecycle tool accepts either. Requires the `container` package and
 * device-mode `container=yes`; every tool guards with `commandUnsupported` so a
 * device without container support degrades to a friendly message.
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
import {
  whereClause,
  looksLikeError,
  isEmpty,
  commandUnsupported,
  quoteValue,
  Cmd,
} from "../core/routeros";
import { redactSecrets } from "../utils";

const NOT_AVAILABLE =
  "Container support is not available on this device. Install the `container` package and enable " +
  "device-mode (`/system/device-mode/update container=yes`, then physically confirm).";

/** A `name="X"` / `tag~"X"` match fragment for `where` and `[find …]`, or null. */
function containerMatch(name?: string, tag?: string): string | null {
  if (name) return `name=${quoteValue(name)}`;
  if (tag) return `tag~${quoteValue(tag)}`;
  return null;
}

/** The id field shared by every lifecycle tool. */
const IDENTITY = {
  name: z.string().optional().describe("Container name (set via add_container)"),
  tag: z.string().optional().describe("Image tag to match (e.g. 'pihole') if no name"),
};

const containerToolsDefs: ToolModule = [
  // ── Containers ─────────────────────────────────────────────────────────────
  defineTool({
    name: "list_containers",
    title: "List Containers",
    annotations: READ,
    description:
      "List every OCI container on the device (`/container print`) with its status, image tag, name, VETH " +
      "interface and root-dir — the starting point for any container work and the way to POLL the lifecycle, " +
      "which is asynchronous: status moves extracting → stopped (ready to start) → running. Use this to find " +
      "the `name`/`tag` the other tools take, to confirm an add has finished extracting before start_container, " +
      "and to confirm a stop has completed before remove_container. Filter by partial `name_filter`, " +
      "`tag_filter`, or `status_filter` (e.g. 'running', 'stopped'); set `detail=true` for the full property " +
      "block. For one container use get_container. A container's stdout/stderr is in the system log " +
      '(`/log print where topics~"container"`) when it was created with logging=yes.',
    inputSchema: {
      name_filter: z.string().optional().describe("Partial container name match"),
      tag_filter: z.string().optional().describe("Partial image tag match"),
      status_filter: z.string().optional().describe("e.g. 'running', 'stopped'"),
      detail: z.boolean().default(false).describe("Show the full per-container property block"),
    },
    async handler(a, ctx) {
      ctx.info("Listing containers");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      if (a.tag_filter) filters.push(`tag~"${a.tag_filter}"`);
      if (a.status_filter) filters.push(`status~"${a.status_filter}"`);
      const result = await executeMikrotikCommand(
        `/container print${a.detail ? " detail" : ""}${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No containers found matching the criteria."
        : `CONTAINERS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "get_container",
    title: "Get Container Detail",
    annotations: READ,
    description:
      "Full detail for one container (`/container print detail`) — status, image tag, interface, root-dir, " +
      "env/mounts, cmd/entrypoint, hostname/dns, logging and start-on-boot. Identify by `name` (preferred) or " +
      "`tag`. Use list_containers to discover identifiers.",
    inputSchema: { ...IDENTITY },
    async handler(a, ctx) {
      const match = containerMatch(a.name, a.tag);
      if (!match) return "Provide a container name or tag.";
      ctx.info(`Getting container detail: ${match}`);
      const result = await executeMikrotikCommand(`/container print detail where ${match}`, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? `Container (${match}) not found.`
        : `CONTAINER DETAILS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "add_container",
    title: "Add Container",
    annotations: WRITE,
    description:
      "Create an OCI container (`/container add`). " +
      "PREREQUISITES, in order: (1) the `container` package installed + device-mode `container=yes`; " +
      "(2) an external disk for storage (containers should never run on internal flash); " +
      "(3) for `remote_image`, a registry URL + on-disk `tmpdir` set via set_container_config; " +
      "(4) a VETH for networking — create it first with `/interface veth add name=veth1 " +
      "address=172.17.0.2/24 gateway=172.17.0.1`, then bridge it and add a srcnat masquerade rule for " +
      "internet (and a dst-nat to publish a port). " +
      "Then create the container: supply EITHER `remote_image` (registry pull, e.g. 'library/alpine:latest') " +
      "OR `file` (a local image tar on the device — must be a SINGLE-LAYER, UNCOMPRESSED Docker-v1 tar). " +
      "Set `interface` to the VETH and `root_dir` to a path on the external disk (e.g. 'disk1/myapp'). " +
      "Attach config via inline `env` ('K=v,K2=v2') / `mount` ('src=disk1/data,dst=/data'), or reference " +
      "named lists with `envlists`/`mountlists` (add_container_env / add_container_mount). Override " +
      "`cmd`/`entrypoint`/`workdir`; set `hostname`/`dns`; enable `logging`/`start_on_boot`; cap " +
      "`memory_high`/`cpu_list`. ALWAYS set `name` so the lifecycle tools can find it. " +
      "The image pull/extract is ASYNCHRONOUS: this returns immediately, then poll list_containers until " +
      "status becomes 'stopped' (extraction done) before calling start_container.",
    inputSchema: {
      name: z.string().optional().describe("Container name (recommended for management)"),
      remote_image: z.string().optional().describe("Registry image, e.g. 'library/alpine:latest'"),
      file: z
        .string()
        .optional()
        .describe("Local Docker-v1 tar on the device (alternative to remote_image)"),
      interface: z.string().optional().describe("VETH interface name"),
      root_dir: z.string().optional().describe("Filesystem root, e.g. 'disk1/myapp'"),
      env: z.string().optional().describe("Inline env vars: 'K=v,K2=v2' (7.21+)"),
      envlists: z.string().optional().describe("Named env list name(s) (add_container_env)"),
      mount: z.string().optional().describe("Inline mount: 'src=disk1/data,dst=/data' (7.21+)"),
      mountlists: z.string().optional().describe("Named mount name(s) (add_container_mount)"),
      cmd: z.string().optional().describe("Override container CMD"),
      entrypoint: z.string().optional().describe("Override container ENTRYPOINT"),
      workdir: z.string().optional().describe("Override working directory"),
      hostname: z.string().optional(),
      dns: z.string().optional().describe("DNS server for the container"),
      user: z.string().optional(),
      stop_signal: z.string().optional().describe("Signal used to stop the container"),
      devices: z.string().optional().describe("Pass-through physical devices (7.20+)"),
      cpu_list: z.string().optional().describe("CPU core affinity"),
      memory_high: z.string().optional().describe("RAM limit, e.g. '256M'"),
      logging: z.boolean().optional().describe("Send stdout/stderr to the RouterOS log"),
      start_on_boot: z.boolean().optional().describe("Auto-start on device boot"),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      if (!a.remote_image && !a.file)
        return "Provide remote_image (registry pull) or file (local tar).";
      ctx.info(`Adding container: ${a.name ?? a.remote_image ?? a.file}`);
      const cmd = new Cmd("/container add")
        .opt("name", a.name)
        .opt("remote-image", a.remote_image)
        .opt("file", a.file)
        .opt("interface", a.interface)
        .opt("root-dir", a.root_dir)
        .opt("env", a.env)
        .opt("envlists", a.envlists)
        .opt("mount", a.mount)
        .opt("mountlists", a.mountlists)
        .opt("cmd", a.cmd)
        .opt("entrypoint", a.entrypoint)
        .opt("workdir", a.workdir)
        .opt("hostname", a.hostname)
        .opt("dns", a.dns)
        .opt("user", a.user)
        .opt("stop-signal", a.stop_signal)
        .opt("devices", a.devices)
        .opt("cpu-list", a.cpu_list)
        .opt("memory-high", a.memory_high)
        .bool("logging", a.logging)
        .bool("start-on-boot", a.start_on_boot)
        .opt("comment", a.comment)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add container: ${redactSecrets(result)}`;
      return (
        `Container added (image is pulling/extracting asynchronously — poll list_containers until status is ` +
        `'stopped', then start_container).\n\n${redactSecrets(result)}`
      );
    },
  }),

  defineTool({
    name: "update_container",
    title: "Update Container",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modify an existing container's properties in place (`/container set [find …]`) without recreating it — " +
      "change `start_on_boot`, `logging`, `cmd`/`entrypoint`/`workdir`, `hostname`/`dns`, `interface`, " +
      "`root_dir`, inline `env`/`mount` or `envlists`/`mountlists`, resource caps, or `comment`. Identify by " +
      "`name` or `tag`. Best practice: stop the container first (stop_container) before changing runtime " +
      "properties like interface, env, mounts or cmd — they take effect on the next start_container, not " +
      "live. To create a new container use add_container; to change the image, remove and re-add.",
    inputSchema: {
      ...IDENTITY,
      interface: z.string().optional(),
      root_dir: z.string().optional(),
      env: z.string().optional(),
      envlists: z.string().optional(),
      mount: z.string().optional(),
      mountlists: z.string().optional(),
      cmd: z.string().optional(),
      entrypoint: z.string().optional(),
      workdir: z.string().optional(),
      hostname: z.string().optional(),
      dns: z.string().optional(),
      cpu_list: z.string().optional(),
      memory_high: z.string().optional(),
      logging: z.boolean().optional(),
      start_on_boot: z.boolean().optional(),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      const match = containerMatch(a.name, a.tag);
      if (!match) return "Provide a container name or tag.";
      ctx.info(`Updating container: ${match}`);
      const cmd = new Cmd(`/container set [find ${match}]`)
        .opt("interface", a.interface)
        .opt("root-dir", a.root_dir)
        .opt("env", a.env)
        .opt("envlists", a.envlists)
        .opt("mount", a.mount)
        .opt("mountlists", a.mountlists)
        .opt("cmd", a.cmd)
        .opt("entrypoint", a.entrypoint)
        .opt("workdir", a.workdir)
        .opt("hostname", a.hostname)
        .opt("dns", a.dns)
        .opt("cpu-list", a.cpu_list)
        .opt("memory-high", a.memory_high)
        .bool("logging", a.logging)
        .bool("start-on-boot", a.start_on_boot)
        .opt("comment", a.comment)
        .build();
      if (cmd.endsWith("]")) return "No updates specified.";
      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to update container: ${redactSecrets(result)}`;
      return `Container (${match}) updated.`;
    },
  }),

  defineTool({
    name: "start_container",
    title: "Start Container",
    annotations: WRITE,
    description:
      "Start a stopped container (`/container start [find …]`). Identify by `name` or `tag`. The container " +
      "must have finished extracting (status 'stopped') first — check with list_containers. View its output " +
      "in the log when logging=yes. To stop it use stop_container.",
    inputSchema: { ...IDENTITY },
    async handler(a, ctx) {
      const match = containerMatch(a.name, a.tag);
      if (!match) return "Provide a container name or tag.";
      ctx.info(`Starting container: ${match}`);
      const count = await executeMikrotikCommand(`/container print count-only where ${match}`, ctx);
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `Container (${match}) not found.`;
      const result = await executeMikrotikCommand(`/container start [find ${match}]`, ctx);
      if (looksLikeError(result)) return `Failed to start container: ${result}`;
      return `Container (${match}) starting.`;
    },
  }),

  defineTool({
    name: "stop_container",
    title: "Stop Container",
    annotations: WRITE,
    description:
      "Stop a running container (`/container stop [find …]`). Identify by `name` or `tag`. Stopping is " +
      "asynchronous — poll list_containers until status is 'stopped' before removing it. To start it again " +
      "use start_container.",
    inputSchema: { ...IDENTITY },
    async handler(a, ctx) {
      const match = containerMatch(a.name, a.tag);
      if (!match) return "Provide a container name or tag.";
      ctx.info(`Stopping container: ${match}`);
      const count = await executeMikrotikCommand(`/container print count-only where ${match}`, ctx);
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `Container (${match}) not found.`;
      const result = await executeMikrotikCommand(`/container stop [find ${match}]`, ctx);
      if (looksLikeError(result)) return `Failed to stop container: ${result}`;
      return `Container (${match}) stopping (poll list_containers for status 'stopped').`;
    },
  }),

  defineTool({
    name: "remove_container",
    title: "Remove Container",
    annotations: DESTRUCTIVE,
    description:
      "Permanently delete a container (`/container remove [find …]`). The container must be FULLY STOPPED " +
      "first — RouterOS rejects removal while it is running or still stopping. If removal fails for that " +
      "reason, stop it (stop_container), wait until list_containers shows status 'stopped', then retry. " +
      "Identify by `name` or `tag`. This does not delete its root-dir data on disk.",
    inputSchema: { ...IDENTITY },
    async handler(a, ctx) {
      const match = containerMatch(a.name, a.tag);
      if (!match) return "Provide a container name or tag.";
      ctx.info(`Removing container: ${match}`);
      const count = await executeMikrotikCommand(`/container print count-only where ${match}`, ctx);
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `Container (${match}) not found.`;
      const result = await executeMikrotikCommand(`/container remove [find ${match}]`, ctx);
      if (looksLikeError(result)) {
        return (
          `Failed to remove container: ${result}\n\nIf it is still running/stopping, stop it first ` +
          `(stop_container), wait until list_containers shows status 'stopped', then retry.`
        );
      }
      return `Container (${match}) removed.`;
    },
  }),

  // ── Global config `/container config` ──────────────────────────────────────
  defineTool({
    name: "get_container_config",
    title: "Get Container Global Config",
    annotations: READ,
    description:
      "Read the global container configuration (`/container config print`) — the image registry URL, the " +
      "tmpdir used for pulls/extraction, the layer directory, and the RAM-high limit. Use to verify the " +
      "registry/tmpdir are set before pulling images. To change them use set_container_config.",
    async handler(_a, ctx) {
      ctx.info("Getting container config");
      const result = await executeMikrotikCommand("/container config print", ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No container config found."
        : `CONTAINER CONFIG:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "set_container_config",
    title: "Set Container Global Config",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Configure the global container settings (`/container config set`) — the router-wide singleton that " +
      "MUST be set before pulling any `remote_image` with add_container. Set `registry_url` (Docker Hub is " +
      "'https://registry-1.docker.io') and `tmpdir` to a path on an EXTERNAL disk (e.g. 'disk1/pull') — pulls " +
      "and extraction need real space and IOPS, never internal flash. Optionally set `layer_dir`, a `ram_high` " +
      "cap, and `username`/`password` for a private registry (credentials are redacted from output). The " +
      "router also needs working DNS + internet to reach the registry. To read the current values use " +
      "get_container_config.",
    inputSchema: {
      registry_url: z.string().optional().describe("Image registry URL"),
      tmpdir: z.string().optional().describe("Pull/extract temp dir, e.g. 'disk1/pull'"),
      layer_dir: z.string().optional().describe("Directory for extracted image layers"),
      ram_high: z.string().optional().describe("RAM-high limit, e.g. '256M'"),
      username: z.string().optional().describe("Registry username (private registries)"),
      password: z.string().optional().describe("Registry password (private registries)"),
    },
    async handler(a, ctx) {
      ctx.info("Setting container config");
      const cmd = new Cmd("/container config set")
        .opt("registry-url", a.registry_url)
        .opt("tmpdir", a.tmpdir)
        .opt("layer-dir", a.layer_dir)
        .opt("ram-high", a.ram_high)
        .opt("username", a.username)
        .opt("password", a.password)
        .build();
      if (cmd === "/container config set") return "No updates specified.";
      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to set container config: ${redactSecrets(result)}`;
      const detail = await executeMikrotikCommand("/container config print", ctx);
      return `Container config updated.\n\n${redactSecrets(detail)}`;
    },
  }),

  // ── Environment lists `/container envs` ────────────────────────────────────
  defineTool({
    name: "list_container_envs",
    title: "List Container Env Variables",
    annotations: READ,
    description:
      "List named environment-variable entries (`/container envs print`) — each has a `list` (the group name " +
      "referenced by a container's envlists), a `key` and a `value`. Optionally filter by partial `list_filter`. " +
      "To add one use add_container_env; to delete use remove_container_env.",
    inputSchema: {
      list_filter: z.string().optional().describe("Partial env-list (group) name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing container envs");
      const filters: string[] = [];
      if (a.list_filter) filters.push(`list~"${a.list_filter}"`);
      const result = await executeMikrotikCommand(
        `/container envs print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result)
        ? "No container env variables found."
        : `CONTAINER ENVS:\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "add_container_env",
    title: "Add Container Env Variable",
    annotations: WRITE,
    description:
      "Add an environment variable to a named list (`/container envs add list= key= value=`). Group related " +
      "variables under the same `list` name, then point a container at the group with `envlists=<list>` " +
      "(add_container or update_container) — a container that is already running must be restarted to pick up " +
      "env changes. Named lists are reusable across containers; for a one-off, self-contained setup the inline " +
      "`env` on add_container is simpler. The grouping `list=` property requires RouterOS 7.20+. Values may be " +
      "secrets and are redacted from output.",
    inputSchema: {
      list: z.string().describe("Env-list (group) name, e.g. 'MYAPP'"),
      key: z.string().describe("Variable name, e.g. 'TZ'"),
      value: z.string().describe("Variable value"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding container env: list=${a.list} key=${a.key}`);
      const cmd = new Cmd("/container envs add")
        .set("list", a.list)
        .set("key", a.key)
        .set("value", a.value)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add env variable: ${redactSecrets(result)}`;
      return `Env '${a.key}' added to list '${a.list}'.`;
    },
  }),

  defineTool({
    name: "remove_container_env",
    title: "Remove Container Env Variable",
    annotations: DESTRUCTIVE,
    description:
      "Delete an environment variable from a list (`/container envs remove [find list= key=]`). Supply the " +
      "`list` (group) name and the `key`. Verifies it exists first. To browse entries use list_container_envs.",
    inputSchema: {
      list: z.string().describe("Env-list (group) name"),
      key: z.string().describe("Variable name to remove"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing container env: list=${a.list} key=${a.key}`);
      const where = `list=${quoteValue(a.list)} key=${quoteValue(a.key)}`;
      const count = await executeMikrotikCommand(
        `/container envs print count-only where ${where}`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `Env '${a.key}' in list '${a.list}' not found.`;
      const result = await executeMikrotikCommand(`/container envs remove [find ${where}]`, ctx);
      if (looksLikeError(result)) return `Failed to remove env variable: ${result}`;
      return `Env '${a.key}' removed from list '${a.list}'.`;
    },
  }),

  // ── Volume mounts `/container mounts` ──────────────────────────────────────
  defineTool({
    name: "list_container_mounts",
    title: "List Container Mounts",
    annotations: READ,
    description:
      "List named volume mounts (`/container mounts print`) — each has a `name` (referenced by a container's " +
      "mountlists), a host source `src` (e.g. 'disk1/appdata') and a container destination `dst` (e.g. " +
      "'/data'). Optionally filter by partial `name_filter`. To add one use add_container_mount; to delete use " +
      "remove_container_mount.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial mount name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing container mounts");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~"${a.name_filter}"`);
      const result = await executeMikrotikCommand(
        `/container mounts print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result) ? "No container mounts found." : `CONTAINER MOUNTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_container_mount",
    title: "Add Container Mount",
    annotations: WRITE,
    description:
      "Create a named volume mount (`/container mounts add name= src= dst=`) — persists container data on the " +
      "host so it survives restarts/recreation. Maps a host source `src` (put it on an EXTERNAL disk, e.g. " +
      "'disk1/appdata', never internal flash) to a path `dst` inside the container (e.g. '/data'). Point a " +
      "container at it with `mountlists=<name>` (add_container or update_container); a running container must " +
      "be restarted to apply mount changes. For a one-off, the inline `mount` on add_container is simpler. " +
      "Named mounts and `mountlists` require RouterOS 7.21+.",
    inputSchema: {
      name: z.string().describe("Mount name, e.g. 'appdata'"),
      src: z.string().describe("Host source path, e.g. 'disk1/appdata'"),
      dst: z.string().describe("Container destination path, e.g. '/data'"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding container mount: name=${a.name}`);
      const cmd = new Cmd("/container mounts add")
        .set("name", a.name)
        .set("src", a.src)
        .set("dst", a.dst)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add mount: ${result}`;
      return `Mount '${a.name}' (${a.src} → ${a.dst}) added.`;
    },
  }),

  defineTool({
    name: "remove_container_mount",
    title: "Remove Container Mount",
    annotations: DESTRUCTIVE,
    description:
      "Delete a named volume mount (`/container mounts remove [find name=...]`). Verifies it exists first. " +
      "Does not delete the host data at `src`. To browse mounts use list_container_mounts.",
    inputSchema: { name: z.string().describe("Mount name to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing container mount: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/container mounts print count-only where name="${a.name}"`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `Mount '${a.name}' not found.`;
      const result = await executeMikrotikCommand(
        `/container mounts remove [find name="${a.name}"]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove mount: ${result}`;
      return `Mount '${a.name}' removed.`;
    },
  }),
];

// Containers need the `container` package AND device-mode permission; both are
// probed once per device, so an unsupported router says so without a round-trip.
export const containerTools: ToolModule = withRequires(
  { packages: ["container"], deviceMode: "container", minVersion: "7.0" },
  containerToolsDefs,
);
