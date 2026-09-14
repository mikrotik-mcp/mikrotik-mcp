/**
 * Prompt loader. MCP *prompts* are reusable, parameterized workflows the user
 * can invoke by name (e.g. "harden this router"). We author them as markdown
 * files in `prompts/` with a small YAML-ish frontmatter block, so prompt
 * content is editable data rather than compiled code.
 *
 * Frontmatter shape:
 *   ---
 *   name: harden-router
 *   title: Harden a RouterOS device
 *   description: One-line summary shown in the prompt picker.
 *   arguments:
 *     - name: wan_interface
 *       description: The WAN-facing interface.
 *       required: true
 *   ---
 *   Body text. Reference arguments with {{wan_interface}}.
 *
 * Implementation note: pattern matching below uses `String.prototype.match`
 * (not `RegExp.exec`) deliberately — no OS shell or `child_process` is involved.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeviceDirectoryEntry } from "../core/runtime";
import { logger } from "../logger";
import { PROMPTS_DIR } from "../paths";
import { transactionPromptGuidance } from "../txn/guidance";

export interface PromptArg {
  name: string;
  description?: string;
  required?: boolean;
}
interface ParsedPrompt {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  body: string;
}

/** Minimal frontmatter parser — handles the small subset of YAML we author. */
function parseFrontmatter(raw: string): ParsedPrompt | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, fm, body] = match;

  const meta: Record<string, string> = {};
  const args: PromptArg[] = [];
  let cur: PromptArg | null = null;
  let inArgs = false;

  for (const line of fm.split("\n")) {
    if (/^arguments:\s*$/.test(line)) {
      inArgs = true;
      continue;
    }
    if (inArgs) {
      const item = line.match(/^[ \t]*-[ \t]*name:[ \t]*(\S.*)$/);
      if (item) {
        if (cur) args.push(cur);
        cur = { name: item[1].trim() };
        continue;
      }
      const prop = line.match(/^[ \t]+(description|required):[ \t]*(\S.*)$/);
      if (prop && cur) {
        if (prop[1] === "required") cur.required = /^(true|yes)$/i.test(prop[2].trim());
        else cur.description = prop[2].trim().replace(/^["']|["']$/g, "");
        continue;
      }
      if (/^\S/.test(line)) inArgs = false; // a non-indented key ends the list
    }
    const kv = line.match(/^(\w+):[ \t]*(\S.*)?$/);
    if (kv && !inArgs) meta[kv[1]] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  if (cur) args.push(cur);

  if (!meta.name) return null;
  return {
    name: meta.name,
    title: meta.title ?? meta.name,
    description: meta.description ?? "",
    arguments: args,
    body: transactionPromptGuidance(meta.name, body.trim()),
  };
}

function substitute(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => {
    const v = vars[key];
    if (v === undefined || v === null || v === "") return whole;
    return typeof v === "object"
      ? JSON.stringify(v)
      : String(v as string | number | boolean | bigint | symbol);
  });
}

/** Options for multi-device prompt injection. */
export interface PromptRegisterOptions {
  deviceNames?: string[];
  deviceAliases?: string[];
  deviceDirectory?: DeviceDirectoryEntry[];
}

/** Build the `device` argument description for prompts. */
function deviceArgDescription(directory?: DeviceDirectoryEntry[]): string {
  if (directory && directory.length > 0) {
    const rows = directory
      .map(
        (d) =>
          `• ${d.key}${d.label && d.label !== d.key ? ` ("${d.label}")` : ""} → ${d.target}${
            d.isDefault ? " [default]" : ""
          }`,
      )
      .join("\n");
    return (
      "Which configured MikroTik device to run this workflow on. " +
      "Pass the EXACT config key or its label. Configured devices:\n" +
      `${rows}\n` +
      "Omit to use the default device."
    );
  }
  return "Which configured MikroTik device to run this workflow on. Omit to use the default device.";
}

/** One prompt's metadata + body, for listing/browsing (no device injection). */
export interface PromptInfo {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  /** The workflow body (markdown), for preview. */
  body: string;
}

/**
 * Parse every prompt in `prompts/` into its metadata + body — the read-only
 * catalog the dashboard/Raycast browse. Never throws; a bad file is skipped.
 */
export function listPrompts(): PromptInfo[] {
  let files: string[];
  try {
    files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: PromptInfo[] = [];
  for (const file of files) {
    try {
      const parsed = parseFrontmatter(readFileSync(join(PROMPTS_DIR, file), "utf8"));
      if (parsed) {
        out.push({
          name: parsed.name,
          title: parsed.title,
          description: parsed.description,
          arguments: parsed.arguments,
          body: parsed.body,
        });
      }
    } catch {
      /* skip unreadable/invalid prompt files */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Register every prompt found in `prompts/`. Returns the number registered. */
export function registerPrompts(server: McpServer, opts: PromptRegisterOptions = {}): number {
  let files: string[];
  try {
    files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return 0; // no prompts directory shipped — fine
  }

  const multiDevice = opts.deviceNames && opts.deviceNames.length > 1;
  const selectorNames = multiDevice
    ? [...new Set([...opts.deviceNames!, ...(opts.deviceAliases ?? [])])]
    : [];

  let count = 0;
  for (const file of files) {
    let parsed: ParsedPrompt | null;
    try {
      parsed = parseFrontmatter(readFileSync(join(PROMPTS_DIR, file), "utf8"));
    } catch (e) {
      logger.warn(`Skipping prompt ${file}: ${String(e)}`);
      continue;
    }
    if (!parsed) {
      logger.warn(`Skipping prompt ${file}: missing or invalid frontmatter`);
      continue;
    }

    const argsSchema: Record<string, z.ZodType> = {};
    for (const arg of parsed.arguments) {
      const s = z.string().describe(arg.description ?? "");
      argsSchema[arg.name] = arg.required ? s : s.optional();
    }

    // In multi-device setups, inject an optional `device` argument so the user
    // can target a specific router — mirroring the tool-level device selector.
    // Skip if the prompt already defines its own device-like arguments.
    const hasOwnDevice = parsed.arguments.some((a) => a.name === "device" || a.name === "device_a");
    if (multiDevice && !hasOwnDevice) {
      argsSchema.device = z
        .enum(selectorNames as [string, ...string[]])
        .optional()
        .describe(deviceArgDescription(opts.deviceDirectory));
    }

    server.registerPrompt(
      parsed.name,
      { title: parsed.title, description: parsed.description, argsSchema },
      (args: Record<string, unknown>) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: substitute(parsed.body, args),
            },
          },
        ],
      }),
    );
    count++;
  }
  return count;
}
