/**
 * Check a RouterOS command on the router without running it.
 *
 * `:parse` compiles text with the router's own parser and returns the compiled
 * form. It runs nothing. When the text is wrong, the answer names the problem
 * and where it is: `bad command name adress (line 1 column 5)`. So the check is
 * exact for the RouterOS version and packages of that router, which no offline
 * list of commands can be.
 *
 * What it does not check: values that are only looked up when the command runs
 * (an interface that does not exist, an address that is already in use).
 */
import { executeMikrotikCommand } from "./connector";
import type { ToolContext } from "./context";
import { quoted } from "./routeros";

export interface SyntaxProblem {
  /** The parser's words, for example `bad parameter interfce`. */
  message: string;
  line: number;
  column: number;
  /** The text at that place, when it can be shown. */
  near?: string;
}

const PROBLEM =
  /(bad command name[^()]*|bad parameter[^()]*|syntax error[^()]*|expected [^()]*|invalid value[^()]*|ambiguous [^()]*|missing value[^()]*)\(line (\d+) column (\d+)\)/i;

/** Read the answer of `:put [:parse "…"]`. `null` means the text parsed. */
export function readParseAnswer(answer: string, command: string): SyntaxProblem | null {
  const match = answer.match(PROBLEM);
  if (!match) return null;
  const line = Number(match[2]);
  const column = Number(match[3]);
  const text = command.split("\n")[line - 1] ?? "";
  const near = text.slice(Math.max(column - 1, 0)).match(/^\S+/)?.[0];
  return { message: match[1]!.trim(), line, column, near };
}

/**
 * Parse `command` on the router. Returns the problem, `null` when the text is
 * valid, or `undefined` when the check itself could not run (it must then not
 * block the caller).
 */
export async function checkSyntax(
  command: string,
  ctx: ToolContext,
): Promise<SyntaxProblem | null | undefined> {
  try {
    const answer = await executeMikrotikCommand(
      `:put [:parse ${quoted(command)}]`,
      { ...ctx, risk: "READ" },
      { maxMs: 15_000 },
    );
    return readParseAnswer(answer, command);
  } catch (error) {
    // Some versions report the parse error as a failed command.
    const text = error instanceof Error ? error.message : String(error);
    return PROBLEM.test(text) ? readParseAnswer(text, command) : undefined;
  }
}

/** One sentence for a tool result. */
export function describeProblem(problem: SyntaxProblem): string {
  return (
    `${problem.message} at line ${problem.line}, column ${problem.column}` +
    `${problem.near ? ` (near "${problem.near}")` : ""}`
  );
}
