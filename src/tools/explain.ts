/**
 * Config Narrative — `explain_device`, `explain_section`, `diff_explanations`.
 *
 * For the person who just inherited an undocumented router. `/export` tells you
 * everything and explains nothing; these turn it into the document that should
 * have been in the wiki.
 *
 * The division of labour matters: the analyser decides what is TRUE and what
 * MATTERS, and hands over a compact structured document. The prose in the reply
 * is already written, so the model spends its context reasoning about the
 * network rather than parsing three thousand lines of export text.
 *
 * All three are READ and never write to a device — `/export` is a print.
 */
import { z } from "zod";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError } from "../core/routeros";
import { resolveDeviceName } from "../core/runtime";
import { analyzeDevice } from "../narrative/analyze";
import type { DeviceNarrative } from "../narrative/analyze";
import { diffNarratives, renderDiff } from "../narrative/diff";
import { NARRATIVE_SECTIONS, renderNarrative } from "../narrative/render";
import type { NarrativeSection } from "../narrative/render";
import { openSnapshotStore } from "../snapshots/store";

let storePromise: Promise<Awaited<ReturnType<typeof openSnapshotStore>>> | null = null;
function snapshots(): Promise<Awaited<ReturnType<typeof openSnapshotStore>>> {
  storePromise ??= openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

const sectionEnum = z.enum(NARRATIVE_SECTIONS as [NarrativeSection, ...NarrativeSection[]]);

/**
 * Resolve config text from a snapshot, inline text, or the live device.
 *
 * Returns the text plus the device label to put on the document — a narrative
 * with no name on it is useless the moment someone saves two of them.
 */
async function resolveConfig(
  args: { snapshot_id?: string; config_text?: string },
  ctx: Parameters<Parameters<typeof defineTool>[0]["handler"]>[1],
): Promise<{ text: string; device?: string } | string> {
  if (args.config_text !== undefined) {
    return { text: args.config_text };
  }
  if (args.snapshot_id) {
    const snapshot = (await snapshots()).get(args.snapshot_id);
    if (!snapshot) return `No snapshot '${args.snapshot_id}'. See list_config_snapshots.`;
    return { text: snapshot.body, device: snapshot.device };
  }

  const device = resolveDeviceName(ctx.device);
  ctx.info(`[${device}] Capturing the configuration to explain it`);
  // `/export` is a read-only print: it writes no file and changes nothing.
  const body = await executeMikrotikCommand("/export", ctx);
  if (looksLikeError(body) || body.trim() === "") {
    return `Could not read the configuration from '${device}': ${body.trim() || "empty export"}`;
  }
  return { text: body, device };
}

/** Analyse, stamping the caller-supplied facts the pure core deliberately lacks. */
function analyze(text: string, device?: string): DeviceNarrative {
  return { ...analyzeDevice(text, device), generatedAt: Date.now() };
}

export const explainTools: ToolModule = [
  defineTool({
    name: "explain_device",
    title: "Explain a Device",
    annotations: READ,
    description:
      "Writes a plain-language architecture document for a router: what it is FOR (inferred from " +
      "the configuration, with the signals shown), what VLANs and subnets exist, how it reaches " +
      "the internet, what each firewall chain actually does, WHAT IS EXPOSED TO THE INTERNET, " +
      "every tunnel, and which management services are reachable — plus a Mermaid topology " +
      "diagram. Reads the live device (`/export`, a read-only print that writes nothing), or a " +
      "stored snapshot with `snapshot_id`, or raw text with `config_text`. " +
      "Prefer this over dumping `/export` into the conversation: it is a fraction of the size, " +
      "already analysed, and identical across runs so two dates can be compared. " +
      "Anything the analyser does not recognise is listed rather than silently omitted.",
    inputSchema: {
      snapshot_id: z
        .string()
        .optional()
        .describe("Explain a stored snapshot instead of the live device"),
      config_text: z.string().optional().describe("Explain this raw `/export` text instead"),
      diagram: z.boolean().default(true).describe("Include the Mermaid topology diagram"),
    },
    async handler(a, ctx) {
      const resolved = await resolveConfig(a, ctx);
      if (typeof resolved === "string") return resolved;
      const narrative = analyze(resolved.text, resolved.device);
      return renderNarrative(narrative, { diagram: a.diagram });
    },
  }),

  defineTool({
    name: "explain_section",
    title: "Explain One Area in Depth",
    annotations: READ,
    description:
      "The same analysis as explain_device, narrowed to one area: `firewall`, `addressing`, " +
      "`topology`, `internet`, `exposure`, `vpn`, `services`, `identity`, or `unknowns`. " +
      "Use it when the question is about one part of the router and the whole document would be " +
      "noise — 'what does the forward chain actually do', 'what is exposed', 'which VLANs exist'. " +
      "Reads the live device by default; pass `snapshot_id` or `config_text` to analyse a stored " +
      "or supplied configuration.",
    inputSchema: {
      section: sectionEnum.describe("Which area to explain"),
      snapshot_id: z
        .string()
        .optional()
        .describe("Explain a stored snapshot instead of the live device"),
      config_text: z.string().optional().describe("Explain this raw `/export` text instead"),
    },
    async handler(a, ctx) {
      const resolved = await resolveConfig(a, ctx);
      if (typeof resolved === "string") return resolved;
      const narrative = analyze(resolved.text, resolved.device);
      return renderNarrative(narrative, { sections: [a.section as NarrativeSection] });
    },
  }),

  defineTool({
    name: "diff_explanations",
    title: "Explain What Changed",
    annotations: READ,
    description:
      "Compares two configurations and reports the CONSEQUENCES of the difference in plain " +
      "language — 'the forward chain no longer ends in a drop, so anything not matched is now " +
      "allowed', 'VLAN 40 was added and can reach the internet through the existing NAT rule'. " +
      "This is the question a reviewer actually has; diff_config_snapshots answers the different " +
      "question of which LINES changed, and a moved rule looks unremarkable there. " +
      "Pass two snapshot ids, or two raw exports, or one of each. Leaving the AFTER side out " +
      "compares a snapshot against the device as it is right now, which is the usual way to ask " +
      "'what has changed since we documented this'. Changes are ordered most consequential " +
      "first, and security changes are called out as such.",
    inputSchema: {
      before_snapshot_id: z.string().optional().describe("The earlier snapshot"),
      after_snapshot_id: z.string().optional().describe("The later snapshot"),
      before_text: z.string().optional().describe("The earlier `/export` text"),
      after_text: z.string().optional().describe("The later `/export` text"),
    },
    async handler(a, ctx) {
      // Checked BEFORE resolving anything: without a baseline there is nothing
      // to compare, and `resolveConfig` would otherwise fall through to reading
      // the live device for no reason.
      if (!a.before_snapshot_id && a.before_text === undefined) {
        return "Provide `before_snapshot_id` or `before_text` — a diff needs a baseline to compare against.";
      }
      const before = await resolveConfig(
        { snapshot_id: a.before_snapshot_id, config_text: a.before_text },
        ctx,
      );
      if (typeof before === "string") return `Before: ${before}`;

      const after = await resolveConfig(
        { snapshot_id: a.after_snapshot_id, config_text: a.after_text },
        ctx,
      );
      if (typeof after === "string") return `After: ${after}`;

      const diff = diffNarratives(
        analyze(before.text, before.device),
        analyze(after.text, after.device),
      );
      return renderDiff(diff);
    },
  }),
];
