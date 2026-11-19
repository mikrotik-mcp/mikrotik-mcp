import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { Cmd, extractCreatedId, readBackUnavailable } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { listItemIds, ruleResolver } from "./_resolve-rule-id";

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

/**
 * Where the new rule is in the list, as text for the caller, and its row.
 *
 * The row is counted from the ordered id list. It is not read from `print`:
 * right after `add place-before=…`, RouterOS prints the new rule with the row
 * number it would have at the END of the list (rule 6 of 7 for a rule that is
 * in fact row 0). A caller that trusts that number "repairs" a correct order.
 */
async function placement(
  scope: string,
  id: string,
  ctx: ToolContext,
  placeBefore?: string,
): Promise<{ row: number; text: string } | null> {
  let ids: string[];
  try {
    ids = await listItemIds(scope, ctx);
  } catch {
    return null;
  }
  const row = ids.findIndex((item) => item.toLowerCase() === id.toLowerCase());
  if (row < 0) return null;
  const next = ids[row + 1];
  let text = `Row ${row} of ${ids.length} (rows count from 0)${next ? `, directly before ${next}` : ", the last row"}.`;
  const asked = placeBefore?.trim();
  if (asked) {
    // A row number means "take that row"; an id means "be directly before that item".
    const kept = /^\d+$/.test(asked)
      ? row === Number(asked)
      : next?.toLowerCase() === asked.toLowerCase();
    text += kept
      ? ` place_before=${asked} was applied.`
      : ` WARNING: place_before=${asked} was NOT applied. Read the order with the list tool of this table, then use its move tool.`;
  }
  return { row, text };
}

/** Keep a confirmed write distinct from an unavailable read-back so callers do not add duplicates. */
export async function readCreatedRule(
  scope: string,
  output: string,
  label: string,
  ctx: ToolContext,
  placeBefore?: string,
): Promise<string> {
  const id = extractCreatedId(output);
  if (!id) {
    return `Failed to verify ${label.toLowerCase()} creation: the add command completed without an internal ID. Do not retry creation; inspect ${scope} first.`;
  }
  try {
    const details = await executeMikrotikCommand(`${scope} print detail where .id=${id}`, ctx);
    const records = parseRecords(details);
    if (!readBackUnavailable(details) && records.format === "detail" && records.rows.length === 1) {
      const place = await placement(scope, id, ctx, placeBefore);
      if (!place) return `${label} created successfully (id ${id}):\n\n${details}`;
      // Put the real row in place of the one `print` showed.
      const shown = details.replace(/^( *)\d+(?= )/m, `$1${place.row}`);
      return `${label} created successfully (id ${id}). ${place.text}\n\n${shown}`;
    }
  } catch (error) {
    ctx.error(
      `Read-back unavailable for ${scope} ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return `${label} created (id ${id}), but its current details could not be verified. Do not retry creation; inspect ${scope} for .id=${id}.`;
}
