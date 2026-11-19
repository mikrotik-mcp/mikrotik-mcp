/**
 * Container lifecycle — the steps around the basic container tools: read the
 * logs, upgrade an image without losing data, and deploy a set of containers
 * from one description (as a compose file does).
 *
 * RouterOS renamed two container settings between releases (`envlist` to
 * `envlists`, `mounts` to `mountlists`). These tools ask the router's own
 * parser which names it knows before they write anything.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError, quoted } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { checkSyntax, describeProblem } from "../core/syntax-check";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
const read = (ctx: ToolContext): ToolContext => ({ ...ctx, risk: "READ" });

const serviceSchema = z.object({
  name: z.string().regex(NAME).describe("Container name; also names its env list and mounts"),
  image: z.string().min(1).describe("Image to pull, e.g. 'pihole/pihole:latest'"),
  veth: z
    .object({
      name: z.string().regex(NAME),
      address: z.string().describe("Address with prefix, e.g. '172.20.0.2/24'"),
      gateway: z.string().describe("Gateway, e.g. '172.20.0.1'"),
      bridge: z.string().optional().describe("Add the veth as a port of this existing bridge"),
    })
    .describe("The container's network interface, created when it does not exist"),
  env: z.record(z.string().regex(ENV_KEY), z.string()).default({}),
  mounts: z
    .array(
      z.object({
        name: z.string().regex(NAME).describe("Mount name (used by older RouterOS versions)"),
        src: z.string().min(1).describe("Path on the router, e.g. '/usb1/pihole/etc'"),
        dst: z.string().min(1).describe("Path in the container, e.g. '/etc/pihole'"),
      }),
    )
    .default([]),
  root_dir: z.string().optional().describe("Where the image is unpacked, e.g. 'usb1/pihole/root'"),
  cmd: z.string().optional(),
  logging: z.boolean().default(true),
  start_on_boot: z.boolean().default(true),
});
export type StackService = z.infer<typeof serviceSchema>;

/** The commands for one service. `legacy` uses the setting names of older RouterOS. */
export function serviceCommands(service: StackService, legacy: boolean): string[] {
  const commands = [
    new Cmd("/interface veth add")
      .set("name", service.veth.name)
      .set("address", service.veth.address)
      .set("gateway", service.veth.gateway)
      .set("comment", `stack: ${service.name}`)
      .build(),
  ];
  if (service.veth.bridge)
    commands.push(
      new Cmd("/interface bridge port add")
        .set("bridge", service.veth.bridge)
        .set("interface", service.veth.name)
        .set("comment", `stack: ${service.name}`)
        .build(),
    );
  for (const [key, value] of Object.entries(service.env))
    commands.push(
      new Cmd("/container envs add")
        .set(legacy ? "name" : "list", service.name)
        .set("key", key)
        .set("value", value)
        .build(),
    );
  for (const mount of service.mounts)
    commands.push(
      // Newer RouterOS groups mounts in a list named after the service; older names each mount.
      new Cmd("/container mounts add")
        .set(legacy ? "name" : "list", legacy ? mount.name : service.name)
        .set("src", mount.src)
        .set("dst", mount.dst)
        .build(),
    );
  const add = new Cmd("/container add")
    .set("name", service.name)
    .set("remote-image", service.image)
    .set("interface", service.veth.name);
  if (Object.keys(service.env).length > 0) add.set(legacy ? "envlist" : "envlists", service.name);
  if (service.mounts.length > 0)
    add.set(
      legacy ? "mounts" : "mountlists",
      legacy ? service.mounts.map((m) => m.name).join(",") : service.name,
    );
  add.opt("root-dir", service.root_dir).opt("cmd", service.cmd);
  commands.push(
    add
      .bool("logging", service.logging)
      .bool("start-on-boot", service.start_on_boot)
      .set("comment", `stack: ${service.name}`)
      .build(),
  );
  return commands;
}

/** A command for a person to read: an environment value may be a secret. */
export const hideEnvValue = (command: string): string =>
  command.startsWith("/container envs add")
    ? command.replace(/ value=(?:"(?:[^"\\]|\\.)*"|\S+)/, " value=«hidden»")
    : command;

export const containerStackTools: ToolModule = [
  defineTool({
    name: "get_container_logs",
    title: "Read Container Logs",
    annotations: READ,
    description:
      "Reads what containers wrote to the RouterOS log. A container's output reaches the log only " +
      "when it was created or updated with `logging=yes`; the lines carry the `container` topic. " +
      "Use it to see why a container stops, restarts or fails to start. `contains` keeps only the " +
      "lines with that text (for example an error word or a process name), and `lines` limits the " +
      "answer to the newest lines. RouterOS does not tag a line with the container's name, so " +
      "with several logging containers the lines are mixed; filter with `contains`. Returns the " +
      "newest matching lines, or says that there are none and why that may be.",
    inputSchema: {
      contains: z.string().max(80).optional().describe("Keep only lines with this text"),
      lines: z.number().int().min(1).max(500).default(50),
    },
    async handler(a, ctx) {
      const where = [
        'topics~"container"',
        ...(a.contains ? [`message~${quoted(a.contains)}`] : []),
      ];
      const out = await executeMikrotikCommand(`/log print where ${where.join(" ")}`, ctx);
      if (looksLikeError(out)) return `Could not read the log: ${out}`;
      const rows = out.split(/\r?\n/).filter((line) => line.trim() !== "");
      if (rows.length === 0)
        return "No container line is in the log. A container logs only with logging=yes (update_container logging=true), and the log keeps a limited number of lines.";
      return rows.slice(-a.lines).join("\n");
    },
  }),

  defineTool({
    name: "upgrade_container_image",
    title: "Upgrade a Container's Image",
    annotations: WRITE,
    description:
      "Pulls the newest image for an existing container and keeps its settings (`/container " +
      "repull`). The container must be stopped; pass `stop=true` to stop it first. What survives: " +
      "everything in the container's MOUNTS, its env list and its settings. What is LOST: files " +
      "the container wrote inside its own root directory, because the image is unpacked again. " +
      "So a container with no mount is refused unless you pass `accept_data_loss=true`. DEFAULTS " +
      "TO A DRY RUN (`apply=false`) that shows the image, the mounts that protect data, and the " +
      "steps. The pull runs in the background: check `get_container` until the status is " +
      "`stopped`, then `start_container`. On a RouterOS version without `repull`, the tool says " +
      "so and changes nothing.",
    inputSchema: {
      name: z.string().regex(NAME).describe("Container name"),
      stop: z.boolean().default(false).describe("Stop the container first when it runs"),
      accept_data_loss: z
        .boolean()
        .default(false)
        .describe("Allow the upgrade of a container that has no mount"),
      apply: z.boolean().default(false).describe("false = show the plan; true = upgrade"),
    },
    async handler(a, ctx) {
      const find = `[find name=${quoted(a.name)}]`;
      const row = parseRecords(
        await executeMikrotikCommand(
          `/container print detail where name=${quoted(a.name)}`,
          read(ctx),
        ),
      ).rows[0];
      if (!row) return `No container named '${a.name}' is on this router.`;
      const image = row.tag ?? row["remote-image"] ?? "?";
      const mounts = row.mountlists ?? row.mounts ?? "";
      const status = row.status ?? "?";
      const lines = [
        `Container '${a.name}': image ${image}, status ${status}.`,
        mounts
          ? `Mounts that keep data across the upgrade: ${mounts}`
          : "This container has NO mount: every file it wrote is in its root directory and will be lost.",
      ];
      if (!mounts && !a.accept_data_loss)
        return [
          ...lines,
          "Not upgraded. Add a mount for the data first, or pass accept_data_loss=true.",
        ].join("\n");
      const supported = await checkSyntax(`/container repull ${find}`, ctx);
      if (supported)
        return [
          ...lines,
          `Not upgraded: this RouterOS version has no /container repull (${describeProblem(supported)}).`,
          "Upgrade by hand: remove the container and add it again with the same settings (get_container shows them).",
        ].join("\n");
      if (status !== "stopped" && !a.stop)
        return [...lines, "Not upgraded: the container must be stopped. Pass stop=true."].join(
          "\n",
        );
      if (!a.apply)
        return [
          ...lines,
          `DRY RUN — would ${status === "stopped" ? "" : "stop it, then "}pull ${image} again. Set apply=true.`,
        ].join("\n");

      if (status !== "stopped") {
        const stopped = await executeMikrotikCommand(`/container stop ${find}`, ctx);
        if (looksLikeError(stopped)) return [...lines, `Failed to stop: ${stopped}`].join("\n");
        // A container takes a moment to stop; a pull on a running one is refused.
        for (let attempt = 0; attempt < 15; attempt += 1) {
          const now = parseRecords(
            await executeMikrotikCommand(
              `/container print detail where name=${quoted(a.name)}`,
              read(ctx),
            ),
          ).rows[0]?.status;
          if (now === "stopped") break;
          if (attempt === 14)
            return [...lines, `Not upgraded: the container did not stop (status ${now}).`].join(
              "\n",
            );
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      const pulled = await executeMikrotikCommand(`/container repull ${find}`, ctx);
      if (looksLikeError(pulled)) return [...lines, `Failed to pull: ${pulled}`].join("\n");
      return [
        ...lines,
        "The new image is being pulled. Check get_container until the status is 'stopped', then start_container.",
      ].join("\n");
    },
  }),

  defineTool({
    name: "deploy_container_stack",
    title: "Deploy Containers From One Description",
    annotations: WRITE,
    description:
      "Creates one or more containers from a single description, as a compose file does. For " +
      "each service it creates the veth interface (and adds it to a bridge when you name one), " +
      "an env list, the mounts, and the container itself with the image, in the right order. " +
      "DEFAULTS TO A DRY RUN (`apply=false`) that returns every command, with env values hidden. " +
      "Before it writes anything, every command is parsed on the router; if one is not valid for " +
      "that RouterOS version, nothing is written. It picks the setting names the router knows " +
      "(`envlists`/`mountlists`, or the older `envlist`/`mounts`). A service whose container name " +
      "already exists is skipped, so the tool can be run again after a failure. It does NOT start " +
      "the containers: the image is pulled in the background, so wait until `get_container` shows " +
      "`stopped`, then `start_container`. The router must have the container package and " +
      "container mode enabled (`get_routeros_container_guide`). It does not add firewall or NAT " +
      "rules for the containers.",
    inputSchema: {
      services: z.array(serviceSchema).min(1).max(12),
      apply: z.boolean().default(false).describe("false = show the commands; true = create"),
    },
    async handler(a, ctx) {
      const services = a.services as StackService[];
      const existing = new Set(
        parseRecords(await executeMikrotikCommand("/container print detail", read(ctx))).rows.map(
          (row) => row.name,
        ),
      );
      const veths = new Set(
        parseRecords(
          await executeMikrotikCommand("/interface veth print detail", read(ctx)),
        ).rows.map((row) => row.name),
      );
      const todo = services.filter((service) => !existing.has(service.name));
      const skipped = services.filter((service) => existing.has(service.name));
      if (todo.length === 0)
        return `Nothing to do: every container already exists (${skipped.map((s) => s.name).join(", ")}).`;

      // Which generation of setting names does this router take?
      const probe = await checkSyntax(
        "/container add name=x remote-image=x interface=x envlists=x mountlists=x",
        ctx,
      );
      const legacy = probe !== null && probe !== undefined;
      const plan = todo.map((service) => ({
        service,
        // A veth that is already there is used, not created again.
        commands: serviceCommands(service, legacy).filter(
          (command) =>
            !veths.has(service.veth.name) ||
            !(
              command.startsWith("/interface veth add") ||
              command.startsWith("/interface bridge port add")
            ),
        ),
      }));
      const preview = plan
        .map(
          ({ service, commands }) =>
            `# ${service.name}\n${commands.map((c) => `  ${hideEnvValue(c)}`).join("\n")}`,
        )
        .join("\n");
      const head = skipped.length
        ? `Skipped (already exist): ${skipped.map((s) => s.name).join(", ")}\n`
        : "";

      for (const { commands } of plan)
        for (const command of commands) {
          const problem = await checkSyntax(command, ctx);
          if (problem)
            return {
              text: `${head}Nothing was written: this router does not accept "${hideEnvValue(command)}": ${describeProblem(problem)}.`,
              isError: true,
            };
        }
      const count = plan.reduce((sum, item) => sum + item.commands.length, 0);
      if (!a.apply)
        return `${head}DRY RUN — ${count} command(s) for ${todo.length} container(s). Every command is valid on this router. Set apply=true to create.\n\n${preview}`;

      let ran = 0;
      for (const { service, commands } of plan)
        for (const command of commands) {
          const result = await executeMikrotikCommand(command, ctx);
          if (looksLikeError(result))
            return {
              text:
                `${head}Ran ${ran} of ${count} command(s), then FAILED at "${hideEnvValue(command)}" ` +
                `(${service.name}): ${result.trim()}\nFix the cause and run the same call again: finished containers are skipped. ` +
                "Items of the failed service that were already created (veth, envs, mounts) must be removed by hand first.",
              isError: true,
            };
          ran += 1;
        }
      return [
        `${head}Created ${todo.length} container(s) with ${ran} command(s).`,
        "The images are being pulled. Wait until get_container shows 'stopped', then start_container.",
        "",
        preview,
      ].join("\n");
    },
  }),
];
