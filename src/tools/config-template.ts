/**
 * Configuration templates and provisioning — keep a reviewed RouterOS
 * configuration with `{{variable}}` places on the MCP host, and apply it to a
 * router (a new one, or many) with that router's values.
 *
 * Applying is careful: every rendered command is parsed on the target router
 * first, a config snapshot is taken, and the commands are written in Safe Mode.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  checkTemplate,
  renderTemplate,
  templateCommands,
  templateVariables,
} from "../core/config-template";
import { createContext } from "../core/context";
import { DESTRUCTIVE, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { checkSyntax, describeProblem } from "../core/syntax-check";
import { captureSnapshot } from "../snapshots/capture";
import { applyWritesSafely } from "../utils/safe-mode-apply";

/** Where templates live: `MIKROTIK_TEMPLATE_DIR`, or `~/.mikrotik-mcp/templates`. */
export function templateDir(): string {
  return process.env.MIKROTIK_TEMPLATE_DIR || join(homedir(), ".mikrotik-mcp", "templates");
}

const NAME = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/, "Use letters, digits, '_' and '-'.")
  .describe("Template name");
const fileOf = (name: string): string => join(templateDir(), `${name}.rsc`);

function load(name: string): string | null {
  try {
    return readFileSync(fileOf(name), "utf8");
  } catch {
    return null;
  }
}

const describeVariables = (text: string): string => {
  const variables = templateVariables(text);
  return variables.length === 0
    ? "no variables"
    : variables
        .map((v) => (v.default === undefined ? v.name : `${v.name} (default ${v.default})`))
        .join(", ");
};

export const configTemplateTools: ToolModule = [
  defineTool({
    name: "list_config_templates",
    title: "List Configuration Templates",
    annotations: READ,
    noDevice: true,
    description:
      "Lists the configuration templates kept on the MCP host, each with the variables it needs. " +
      "A template is RouterOS script text with `{{variable}}` places, applied to routers with " +
      "apply_config_template. It contacts no router. Use it to see which templates exist before " +
      "you provision a router. Returns one line per template.",
    inputSchema: {},
    handler() {
      let names: string[];
      try {
        names = readdirSync(templateDir()).filter((file) => file.endsWith(".rsc"));
      } catch {
        names = [];
      }
      if (names.length === 0)
        return `No template yet (${templateDir()}). Add one with save_config_template.`;
      return names
        .sort()
        .map((file) => {
          const name = file.slice(0, -4);
          return `${name}: ${describeVariables(load(name) ?? "")}`;
        })
        .join("\n");
    },
  }),

  defineTool({
    name: "save_config_template",
    title: "Save a Configuration Template",
    annotations: WRITE,
    noDevice: true,
    description:
      "Saves a configuration template on the MCP host. `content` is RouterOS script text: full " +
      "commands, or export style with a menu line (`/ip address`) and `add …` lines under it. " +
      "Write `{{name}}` where a value differs between routers, and `{{name|default}}` to give a " +
      "default. A place stands for one whole value (`name={{identity}}`) and must NOT be inside " +
      "quotes: the value is quoted for you when it is applied, which is also what stops a value " +
      "from adding commands. A template with a place inside quotes is refused. Saving a name that " +
      "exists replaces it. It changes no router. Returns the variables the template needs.",
    inputSchema: {
      name: NAME,
      content: z
        .string()
        .min(1)
        .max(200_000)
        .describe("RouterOS script text with {{variable}} places"),
    },
    handler(a) {
      const problems = checkTemplate(a.content);
      if (problems.length > 0)
        return {
          text: `Not saved:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
          isError: true,
        };
      mkdirSync(templateDir(), { recursive: true });
      writeFileSync(fileOf(a.name), a.content.replace(/\r\n?/g, "\n"));
      return `Saved template '${a.name}' (${templateCommands(a.content).length} command(s)). Variables: ${describeVariables(a.content)}.`;
    },
  }),

  defineTool({
    name: "remove_config_template",
    title: "Remove a Configuration Template",
    annotations: DESTRUCTIVE,
    noDevice: true,
    description:
      "Deletes one configuration template from the MCP host. It changes no router: a router that " +
      "the template was applied to keeps its configuration. Returns whether a template was removed.",
    inputSchema: { name: NAME },
    handler(a) {
      if (load(a.name) === null) return `No template named '${a.name}'.`;
      rmSync(fileOf(a.name));
      return `Removed template '${a.name}'.`;
    },
  }),

  defineTool({
    name: "apply_config_template",
    title: "Apply a Configuration Template to Routers",
    annotations: WRITE,
    noDevice: true,
    description:
      "Applies a saved configuration template to one or more routers, each with its own values: " +
      "the way to provision a new router, or to give many routers the same reviewed " +
      "configuration. `variables` holds the values for every router; `per_device` holds values " +
      "for one router and wins. Two variables are always set for you: `device` (the name in this " +
      "server's device list) and `host` (its address). DEFAULTS TO A DRY RUN (`apply=false`) that " +
      "returns the rendered commands for each router. Before anything is written, every command " +
      "is parsed on that router; a command that is not valid there stops that router with the " +
      "place of the problem, and nothing is written to it. Applying takes a config snapshot and " +
      "writes in Safe Mode, so a change that cuts the connection is rolled back. Routers are done " +
      "one at a time, and the run stops at the first router that fails. To provision a factory-" +
      "default router, first add it to the device list (by its MAC address for MAC-Telnet, or its " +
      "default address); Safe Mode needs SSH, so a MAC-Telnet router is written directly.",
    inputSchema: {
      name: NAME,
      devices: z.array(z.string()).min(1).max(50).describe("Routers to apply the template to"),
      variables: z.record(z.string(), z.string()).default({}).describe("Values for every router"),
      per_device: z
        .record(z.string(), z.record(z.string(), z.string()))
        .default({})
        .describe("Values for one router: { router: { variable: value } }"),
      apply: z.boolean().default(false).describe("false = show the commands; true = apply"),
    },
    async handler(a) {
      const template = load(a.name);
      if (template === null) return `No template named '${a.name}'. See list_config_templates.`;
      const config = getConfig();
      const report: string[] = [];
      for (const requested of a.devices as string[]) {
        const device = resolveDeviceName(requested);
        const head = `── ${device} ──`;
        try {
          assertDeviceAccess([device], "apply_config_template", "WRITE");
        } catch (error) {
          report.push(
            head,
            `Not allowed: ${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
        const dc = config.devices[device]!;
        let rendered: string;
        try {
          rendered = renderTemplate(template, {
            device,
            host: dc.host ?? "",
            ...(a.variables as Record<string, string>),
            ...(a.per_device as Record<string, Record<string, string>>)[requested],
          });
        } catch (error) {
          report.push(
            head,
            `Not rendered. ${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
        const commands = templateCommands(rendered);
        const ctx = createContext(undefined, device);
        ctx.risk = "WRITE";
        let invalid = "";
        for (const command of commands) {
          const problem = await checkSyntax(command, ctx);
          if (problem) {
            invalid = `"${command}": ${describeProblem(problem)}`;
            break;
          }
        }
        if (invalid) {
          report.push(head, `Nothing was written: this router does not accept ${invalid}.`);
          break;
        }
        if (!a.apply) {
          report.push(head, ...commands.map((command) => `  ${command}`));
          continue;
        }
        const snapshotId = await captureSnapshot(ctx, `pre-template-${a.name}`);
        // A MAC-Telnet router has no Safe Mode: provisioning it must still be possible.
        const outcome = await applyWritesSafely(ctx, device, commands, {
          allowDirectFallback: Boolean(dc.mac),
        });
        report.push(
          head,
          `snapshot=${snapshotId}  safe-mode=${outcome.safeMode}`,
          `Applied ${outcome.applied}/${outcome.total} command(s).`,
        );
        if (outcome.error || !outcome.committed) {
          report.push(
            `FAILED: ${outcome.error ?? outcome.safeMode}`,
            "Stopped here. The routers after this one were not touched.",
          );
          break;
        }
      }
      return [
        a.apply
          ? `Template '${a.name}'`
          : `DRY RUN — template '${a.name}'. Every command shown was parsed on its router. Set apply=true to apply.`,
        "",
        ...report,
      ].join("\n");
    },
  }),
];
