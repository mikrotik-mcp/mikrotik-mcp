import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { Cmd, extractCreatedId, readBackUnavailable } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { ruleResolver } from "./_resolve-rule-id";

/** Create once and print the assigned ID, resolving insertion positions before writing. */
export async function executeRuleCreate(
  scope: string,
  command: Cmd,
  ctx: ToolContext,
  placeBefore?: string,
): Promise<string> {
  if (placeBefore !== undefined && placeBefore !== "") {
    const id = await ruleResolver(scope)(placeBefore, ctx);
    if (!id || !/^\*[\dA-F]+$/i.test(id)) {
      return "failure: item referred by 'place-before' does not exist";
    }
    command.set("place-before", id);
  }
  return executeMikrotikCommand(`:put [${command.build()}]`, ctx);
}

/** Keep a confirmed write distinct from an unavailable read-back so callers do not add duplicates. */
export async function readCreatedRule(
  scope: string,
  output: string,
  label: string,
  ctx: ToolContext,
): Promise<string> {
  const id = extractCreatedId(output);
  if (!id) {
    return `Failed to verify ${label.toLowerCase()} creation: the add command completed without an internal ID. Do not retry creation; inspect ${scope} first.`;
  }
  try {
    const details = await executeMikrotikCommand(`${scope} print detail where .id=${id}`, ctx);
    const records = parseRecords(details);
    if (!readBackUnavailable(details) && records.format === "detail" && records.rows.length === 1) {
      return `${label} created successfully (id ${id}):\n\n${details}`;
    }
  } catch (error) {
    ctx.error(
      `Read-back unavailable for ${scope} ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return `${label} created (id ${id}), but its current details could not be verified. Do not retry creation; inspect ${scope} for .id=${id}.`;
}
