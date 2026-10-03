/**
 * Container tools: exact, bounded target resolution; no implicit package/network
 * changes. Current CLI fields and explicit legacy aliases, never write-and-retry.
 */
import { z } from "zod";
import { Cmd, quoteValue } from "../core/routeros";
import {
  READ,
  WRITE,
  WRITE_IDEMPOTENT,
  DESTRUCTIVE,
  defineTool,
  withRequires,
} from "../core/registry";
import type { ToolModule } from "../core/registry";
import { CONTAINER_GUIDE_TOPICS, getRouterosContainerGuide } from "../core/container-guidance";
import { redactContainerText } from "../utils/container-redaction";
import {
  containerRead,
  containerReadBack,
  containerWrite,
  requireStopped,
  resolveContainerItem,
} from "./_container-safety";
import type { ToolContext } from "../core/context";

const textValue = z.string().trim().min(1);
const IDENTITY = {
  id: z
    .string()
    .regex(/^\*[\da-fA-F]+$/)
    .optional()
    .describe("Stable .id from fresh discovery; never a row number"),
  name: textValue.optional().describe("Exact unique container name"),
  tag: textValue
    .optional()
    .describe("Exact unique image tag, not a regex; prefer id when images are shared"),
};
type Identity = { id?: string; name?: string; tag?: string };
async function target(a: Identity, ctx: ToolContext): Promise<string> {
  if ([a.id, a.name, a.tag].filter((v) => v !== undefined).length !== 1)
    throw new Error("Provide exactly one of id, name or tag.");
  return resolveContainerItem(
    "/container",
    a.id ? { ".id": a.id } : a.name ? { name: a.name } : { tag: a.tag },
    ctx,
  );
}

const SETTINGS = {
  interface: textValue
    .optional()
    .describe("VETH interface(s); verify target syntax and image interface names"),
  root_dir: textValue
    .optional()
    .describe("Dedicated root path on appropriate storage, not internal flash"),
  env: z.string().optional().describe("Sensitive inline environment; verify support on the target"),
  envlists: z.string().optional().describe("Current CLI named environment lists"),
  envlist: z.string().optional().describe("Legacy singular envlist; exclusive with envlists"),
  mount: z
    .string()
    .optional()
    .describe("Inline mount expression supported by the target; not Docker syntax"),
  mountlists: z.string().optional().describe("Current CLI named mount lists"),
  mounts: z.string().optional().describe("Legacy mounts reference; exclusive with mountlists"),
  cmd: z.string().optional().describe("Command override; may contain secrets"),
  entrypoint: z.string().optional().describe("Entrypoint override; may contain secrets"),
  workdir: z.string().optional(),
  hostname: z.string().optional(),
  dns: z.string().optional(),
  user: z.string().optional(),
  stop_signal: z.string().optional(),
  devices: z
    .string()
    .optional()
    .describe("Device passthrough; extra privilege requires explicit review"),
  cpu_list: z.string().optional(),
  memory_high: z.string().optional().describe("Soft memory pressure threshold, not a hard cap"),
  memory_max: z
    .string()
    .optional()
    .describe("Hard memory limit only where supported; can terminate processes"),
  logging: z.boolean().optional(),
  start_on_boot: z.boolean().optional(),
  comment: z.string().optional(),
};
const fields = {
  interface: "interface",
  root_dir: "root-dir",
  env: "env",
  envlists: "envlists",
  envlist: "envlist",
  mount: "mount",
  mountlists: "mountlists",
  mounts: "mounts",
  cmd: "cmd",
  entrypoint: "entrypoint",
  workdir: "workdir",
  hostname: "hostname",
  dns: "dns",
  user: "user",
  stop_signal: "stop-signal",
  devices: "devices",
  cpu_list: "cpu-list",
  memory_high: "memory-high",
  memory_max: "memory-max",
  comment: "comment",
} as const;
function validateSettings(a: Record<string, unknown>): void {
  for (const [current, legacy] of [
    ["envlists", "envlist"],
    ["mountlists", "mounts"],
  ]) {
    if (a[current] !== undefined && a[legacy] !== undefined)
      throw new Error(`Choose either ${current} or ${legacy}, not both.`);
  }
}
function settings(cmd: Cmd, a: Record<string, unknown>): string {
  for (const [input, property] of Object.entries(fields))
    if (a[input] !== undefined) cmd.set(property, a[input] as string);
  return cmd
    .bool("logging", a.logging as boolean | undefined)
    .bool("start-on-boot", a.start_on_boot as boolean | undefined)
    .build();
}
const detailCommand = (id: string): string =>
  new Cmd("/container print").raw("detail where").set(".id", id).build();

const deviceTools: ToolModule = [
  defineTool({
    name: "list_containers",
    title: "List Containers",
    annotations: READ,
    description:
      "Discover container .ids, exact names/tags and lifecycle status/flags. Pull/start/stop are asynchronous; running is not application health. Sensitive env/command/config fields are masked. Use get_routeros_container_guide before changes.",
    inputSchema: {
      name_filter: z
        .string()
        .optional()
        .describe("RouterOS name regex, escaped as a command value"),
      tag_filter: z.string().optional(),
      status_filter: z
        .string()
        .optional()
        .describe("Legacy status regex; newer releases may expose flags instead"),
      detail: z.boolean().default(false),
    },
    async handler(a, ctx) {
      const cmd = new Cmd("/container print");
      if (a.detail) cmd.raw("detail");
      const filters = Object.entries({
        name: a.name_filter,
        tag: a.tag_filter,
        status: a.status_filter,
      }).filter(([, v]) => v !== undefined);
      if (filters.length) cmd.raw("where");
      for (const [key, value] of filters) cmd.raw(`${key}~${quoteValue(value as string)}`);
      const result = await containerRead(cmd.build(), ctx);
      return result.trim()
        ? `CONTAINERS:\n\n${redactContainerText(result)}`
        : "No containers found.";
    },
  }),
  defineTool({
    name: "get_container",
    title: "Get Container Detail",
    annotations: READ,
    description:
      "Read one exact, unique container by stable id, name or exact tag; rejects ambiguity. Sensitive env, command and image-config fields are masked. Missing state is unknown, not stopped.",
    inputSchema: IDENTITY,
    async handler(a, ctx) {
      const id = await target(a, ctx);
      return `CONTAINER ${id}:\n\n${redactContainerText(await containerRead(detailCommand(id), ctx))}`;
    },
  }),
  defineTool({
    name: "add_container",
    title: "Add Container",
    annotations: WRITE,
    description:
      "Create one container after approved prerequisite, image/storage and network review. Requires exactly one image source, a unique name, VETH and dedicated root_dir. No package installation, device-mode, NAT or firewall changes are implicit. Use supported image-save archives; no blanket single-layer restriction. Explicit legacy envlist/mounts aliases are available; inspect target syntax before writing. Returns a pending extraction request, not a healthy deployment; poll before starting.",
    inputSchema: {
      ...SETTINGS,
      name: textValue.describe("Unique name for read-back and ambiguous-write recovery"),
      interface: textValue.describe("Previously configured VETH"),
      root_dir: textValue.describe("Dedicated root path on verified storage"),
      remote_image: textValue
        .optional()
        .describe("Reviewed architecture-compatible image with pinned version/digest"),
      file: textValue
        .optional()
        .describe("Uploaded Docker/Podman saved image archive supported by the target"),
    },
    async handler(a, ctx) {
      if (Boolean(a.remote_image) === Boolean(a.file))
        throw new Error("Provide exactly one image source: remote_image OR file.");
      if (!a.name || !a.interface || !a.root_dir)
        throw new Error("Provide name, interface and root_dir.");
      validateSettings(a);
      const count = await containerRead(
        new Cmd("/container print count-only where").set("name", a.name).build(),
        ctx,
      );
      if (count.trim() !== "0")
        throw new Error(
          "Container name already exists or uniqueness could not be verified; no mutation performed.",
        );
      const cmd = new Cmd("/container add")
        .set("name", a.name)
        .opt("remote-image", a.remote_image)
        .opt("file", a.file);
      await containerWrite(settings(cmd, a), ctx);
      const readback = await containerReadBack(
        new Cmd("/container print detail where").set("name", a.name).build(),
        ctx,
      );
      return `Container add accepted; extraction is asynchronous. Inspect the observed state before start; do not repeat add.\n\n${readback}`;
    },
  }),
  defineTool({
    name: "update_container",
    title: "Update Container",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update exactly one container. Runtime settings require positive fully-stopped evidence; logging, comment and start_on_boot can change without stopping. Named env/mount lists can affect other consumers. Inspect target syntax; no automatic compatibility retries.",
    inputSchema: { ...IDENTITY, ...SETTINGS },
    async handler(a, ctx) {
      validateSettings(a);
      const changes = Object.keys(SETTINGS).filter((key) => a[key] !== undefined);
      if (!changes.length) return "No updates specified.";
      const id = await target(a, ctx);
      if (changes.some((key) => !["logging", "comment", "start_on_boot"].includes(key)))
        await requireStopped(id, ctx);
      await containerWrite(settings(new Cmd("/container set").set("numbers", id), a), ctx);
      return `Container update accepted. Observed read-back:\n\n${await containerReadBack(detailCommand(id), ctx)}`;
    },
  }),
  ...(["start", "stop", "remove"] as const).map((operation) =>
    defineTool({
      name: `${operation}_container`,
      title: `${operation[0].toUpperCase()}${operation.slice(1)} Container`,
      annotations: operation === "remove" ? DESTRUCTIVE : WRITE,
      description:
        operation === "remove"
          ? "Remove exactly one container after a positive stopped check. Back up application data first; do not assume root-dir survives removal. Does not separately delete volumes/layers. Verify absence; never blindly retry an ambiguous write."
          : `${operation} exactly one container by stable id, exact unique name or tag. Start requires positive stopped evidence. Asynchronous: inspect state with bounded polling; accepted does not mean healthy/completed.`,
      inputSchema: IDENTITY,
      async handler(a, ctx) {
        const id = await target(a, ctx);
        if (operation !== "stop") await requireStopped(id, ctx);
        await containerWrite(new Cmd(`/container ${operation}`).set("numbers", id).build(), ctx);
        if (operation === "remove") {
          const count = await containerReadBack(
            new Cmd("/container print count-only where").set(".id", id).build(),
            ctx,
          );
          return count.trim() === "0"
            ? `Container ${id} removal verified. Application-volume contents were not inspected.`
            : "Removal accepted but absence is UNVERIFIED/pending; inspect before retrying.";
        }
        return `Container ${operation} accepted; lifecycle may still be pending.\n\n${await containerReadBack(detailCommand(id), ctx)}`;
      },
    }),
  ),
  defineTool({
    name: "get_container_config",
    title: "Get Container Global Config",
    annotations: READ,
    description:
      "Read registry, extraction storage and memory settings. Registry credentials are masked. Settings are router-wide and may affect every container.",
    async handler(_a, ctx) {
      return `CONTAINER CONFIG:\n\n${redactContainerText(await containerRead("/container config print", ctx))}`;
    },
  }),
  defineTool({
    name: "set_container_config",
    title: "Set Container Global Config",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update router-wide registry/extraction/storage/memory settings and read back. Use verified storage and HTTPS registry; may affect other workloads. memory_high is a soft threshold. ram_high is a compatibility input alias for the same RouterOS memory-high property.",
    inputSchema: {
      registry_url: z.string().optional(),
      tmpdir: z.string().optional(),
      layer_dir: z.string().optional(),
      memory_high: z.string().optional(),
      ram_high: z
        .string()
        .optional()
        .describe("Deprecated alias of memory_high; never sent as ram-high"),
      username: z.string().optional(),
      password: z.string().optional(),
    },
    async handler(a, ctx) {
      if (a.memory_high !== undefined && a.ram_high !== undefined)
        throw new Error("Choose memory_high or its ram_high alias, not both.");
      const cmd = new Cmd("/container config set")
        .opt("registry-url", a.registry_url)
        .opt("tmpdir", a.tmpdir)
        .opt("layer-dir", a.layer_dir)
        .opt("memory-high", a.memory_high ?? a.ram_high)
        .opt("username", a.username)
        .opt("password", a.password)
        .build();
      if (cmd === "/container config set") return "No updates specified.";
      await containerWrite(cmd, ctx);
      return `Container config update accepted.\n\n${await containerReadBack("/container config print", ctx)}`;
    },
  }),
  defineTool({
    name: "list_container_envs",
    title: "List Container Env Metadata",
    annotations: READ,
    description:
      "List environment .ids, list names and keys WITHOUT retrieving values. Treat every value as potentially secret. Shared lists may have multiple container consumers.",
    inputSchema: { list_filter: z.string().optional().describe("Exact list name") },
    async handler(a, ctx) {
      const cmd = new Cmd("/container envs print")
        .raw("detail")
        .set("proplist", ".id,list,key,disabled");
      if (a.list_filter !== undefined) cmd.raw("where").set("list", a.list_filter);
      return `CONTAINER ENV METADATA (values omitted):\n\n${redactContainerText(await containerRead(cmd.build(), ctx))}`;
    },
  }),
  defineTool({
    name: "add_container_env",
    title: "Add Container Env Variable",
    annotations: WRITE,
    description:
      "Add a sensitive value to a named env list. Current CLI groups by list; check target syntax. Review all consumers before changing a shared list. Existing running containers may need an approved stop/start; no implicit restart.",
    inputSchema: { list: textValue, key: textValue, value: z.string() },
    async handler(a, ctx) {
      const count = await containerRead(
        new Cmd("/container envs print count-only where")
          .set("list", a.list)
          .set("key", a.key)
          .build(),
        ctx,
      );
      if (count.trim() !== "0")
        throw new Error("Env entry exists or uniqueness is unknown; no mutation performed.");
      await containerWrite(
        new Cmd("/container envs add")
          .set("list", a.list)
          .set("key", a.key)
          .set("value", a.value)
          .build(),
        ctx,
      );
      const countAfter = await containerReadBack(
        new Cmd("/container envs print count-only where")
          .set("list", a.list)
          .set("key", a.key)
          .build(),
        ctx,
      );
      return countAfter.trim() === "1"
        ? "Env entry creation verified; value omitted."
        : "Env add accepted; read-back UNVERIFIED. Inspect before retrying.";
    },
  }),
  defineTool({
    name: "remove_container_env",
    title: "Remove Container Env Variable",
    annotations: DESTRUCTIVE,
    description:
      "Remove one env entry by stable id OR exact list+key. Reject duplicates/unreadable selection. Review containers consuming this list first; no implicit restart.",
    inputSchema: { id: IDENTITY.id, list: textValue.optional(), key: textValue.optional() },
    async handler(a, ctx) {
      if (a.id ? a.list !== undefined || a.key !== undefined : !a.list || !a.key)
        throw new Error("Provide id OR both list and key.");
      const id = await resolveContainerItem(
        "/container envs",
        a.id ? { ".id": a.id } : { list: a.list, key: a.key },
        ctx,
      );
      await containerWrite(new Cmd("/container envs remove").set("numbers", id).build(), ctx);
      const count = await containerReadBack(
        new Cmd("/container envs print count-only where").set(".id", id).build(),
        ctx,
      );
      return count.trim() === "0"
        ? "Env removal verified."
        : "Env removal accepted; absence UNVERIFIED. Inspect before retrying.";
    },
  }),
  defineTool({
    name: "list_container_mounts",
    title: "List Container Mounts",
    annotations: READ,
    description:
      "Read mount metadata. Current CLI groups by list; legacy CLI may use name. No application files are read. A list can contain several mounts.",
    inputSchema: {
      list_filter: textValue.optional(),
      name_filter: textValue.optional().describe("Legacy exact name filter"),
    },
    async handler(a, ctx) {
      if (a.list_filter !== undefined && a.name_filter !== undefined)
        throw new Error("Choose list_filter or legacy name_filter.");
      const cmd = new Cmd("/container mounts print detail");
      if (a.list_filter !== undefined) cmd.raw("where").set("list", a.list_filter);
      if (a.name_filter !== undefined) cmd.raw("where").set("name", a.name_filter);
      return `CONTAINER MOUNTS:\n\n${redactContainerText(await containerRead(cmd.build(), ctx))}`;
    },
  }),
  defineTool({
    name: "add_container_mount",
    title: "Add Container Mount",
    annotations: WRITE,
    description:
      "Add a persistent mount using current list= OR legacy name=, never both. Verify target syntax first. Use appropriate storage; a missing source may be populated from the image. Review consumers; this neither formats storage nor restarts containers.",
    inputSchema: {
      list: textValue.optional().describe("Current CLI mount-list name"),
      name: textValue
        .optional()
        .describe("Legacy CLI mount name; do not use for current list syntax"),
      src: textValue,
      dst: textValue,
    },
    async handler(a, ctx) {
      if (Boolean(a.list) === Boolean(a.name)) throw new Error("Provide list OR legacy name.");
      const selector = new Cmd("")
        .opt("list", a.list)
        .opt("name", a.name)
        .set("src", a.src)
        .set("dst", a.dst)
        .build()
        .trim();
      const count = await containerRead(
        `/container mounts print count-only where ${selector}`,
        ctx,
      );
      if (count.trim() !== "0")
        throw new Error("Mount exists or uniqueness is unknown; no mutation performed.");
      await containerWrite(
        new Cmd("/container mounts add")
          .opt("list", a.list)
          .opt("name", a.name)
          .set("src", a.src)
          .set("dst", a.dst)
          .build(),
        ctx,
      );
      const countAfter = await containerReadBack(
        `/container mounts print count-only where ${selector}`,
        ctx,
      );
      return countAfter.trim() === "1"
        ? "Mount creation verified; inspect application data separately."
        : "Mount add accepted; read-back UNVERIFIED. Inspect before retrying.";
    },
  }),
  defineTool({
    name: "remove_container_mount",
    title: "Remove Container Mount",
    annotations: DESTRUCTIVE,
    description:
      "Remove one mount definition by stable id or unique list/name, optionally narrowed by src/dst. Rejects multi-entry lists. Review shared consumers first; no host files are deleted by this tool.",
    inputSchema: {
      id: IDENTITY.id,
      list: textValue.optional(),
      name: textValue.optional(),
      src: textValue.optional(),
      dst: textValue.optional(),
    },
    async handler(a, ctx) {
      if (
        [a.id, a.list, a.name].filter((v) => v !== undefined).length !== 1 ||
        (a.id && (a.src || a.dst))
      )
        throw new Error("Provide id OR list/name with optional src/dst.");
      const id = await resolveContainerItem(
        "/container mounts",
        a.id ? { ".id": a.id } : { list: a.list, name: a.name, src: a.src, dst: a.dst },
        ctx,
      );
      await containerWrite(new Cmd("/container mounts remove").set("numbers", id).build(), ctx);
      const count = await containerReadBack(
        new Cmd("/container mounts print count-only where").set(".id", id).build(),
        ctx,
      );
      return count.trim() === "0"
        ? "Mount definition removal verified; host files were not touched."
        : "Mount removal accepted; absence UNVERIFIED. Inspect before retrying.";
    },
  }),
];

export const containerTools: ToolModule = [
  defineTool({
    name: "get_routeros_container_guide",
    title: "Get RouterOS Container Guide",
    description:
      "Read shared version-aware container knowledge: prerequisites, image compatibility, VETH isolation, lifecycle, secrets and troubleshooting. No device access. Use before auditing, deploying or changing containers.",
    annotations: READ,
    noDevice: true,
    inputSchema: { topic: z.enum(["all", ...CONTAINER_GUIDE_TOPICS]).default("all") },
    async handler(a) {
      return getRouterosContainerGuide(a.topic);
    },
  }),
  ...withRequires(
    { packages: ["container"], deviceMode: "container", minVersion: "7.0" },
    deviceTools,
  ),
];
