/**
 * Raw RouterOS CLI — last-resort fallback when `find_tools` returns nothing.
 *
 * Models should ALWAYS try `find_tools` → `invoke_tool` first: dedicated tools
 * have schema validation, structured output, and correct risk annotations.
 * This raw escape hatch skips all of that and runs an unvalidated CLI string,
 * so it should only fire when the gateway search genuinely found no match.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError } from "../core/routeros";
import { checkSyntax, describeProblem } from "../core/syntax-check";

export const rawCommandTools: ToolModule = [
  defineTool({
    name: "run_routeros_command",
    title: "Run a RouterOS Command (raw CLI)",
    annotations: WRITE,
    description:
      "⚠️ LAST RESORT — do NOT call this tool directly. ALWAYS call `find_tools` first to locate the " +
      "dedicated tool for your task, then run it via `invoke_tool`. Dedicated tools provide schema " +
      "validation, structured output, and accurate risk annotations that this raw command lacks. " +
      "Only use this tool when `find_tools` returned zero results for your query AND you are certain " +
      "no dedicated tool exists.\n\n" +
      "When you do use it: pass one RouterOS CLI command exactly as typed in the terminal. " +
      "The command is executed as-is with NO validation — it can be destructive, so review carefully. " +
      "By default the command is first parsed on the router WITHOUT running it; a command the router " +
      "does not know (a wrong menu, a misspelled parameter, RouterOS v6 syntax) is refused with the " +
      "place of the problem, and nothing runs. " +
      "Runs one command per call; call again with `… print` to verify a change. " +
      "For multi-command scripts use add_script + run_script instead.",
    inputSchema: {
      command: z
        .string()
        .describe("Full RouterOS CLI command exactly as typed, e.g. '/ip address print'"),
      check_syntax: z
        .boolean()
        .default(true)
        .describe("Parse the command on the router first and refuse it when it is not valid"),
    },
    async handler(a, ctx) {
      const cmd = a.command.trim();
      if (!cmd) return "Provide a RouterOS command to run.";
      if (a.check_syntax) {
        const problem = await checkSyntax(cmd, ctx);
        if (problem)
          return {
            text:
              `Not run: this router does not accept the command. ${describeProblem(problem)}.\n` +
              "Nothing was changed. Correct the command, or call find_tools for the dedicated tool.",
            isError: true,
          };
      }
      ctx.info(`Running raw RouterOS command: ${cmd}`);
      // Hard cap at 30 s — raw commands can hang the SSH channel (e.g. script
      // sub-expressions like `:put [find ...]`) and pin the connection, blocking
      // all subsequent tool calls until the server restarts.
      const result = await executeMikrotikCommand(cmd, ctx, { maxMs: 30_000 });
      if (looksLikeError(result)) return `RouterOS command error: ${result}`;
      return result.trim() ? result : "(command completed with no output)";
    },
  }),
  defineTool({
    name: "validate_routeros_command",
    title: "Validate a RouterOS Command (no execution)",
    annotations: READ,
    description:
      "Checks RouterOS CLI text on the router WITHOUT running it. The router's own parser compiles " +
      "the text (`:parse`) and reports the first problem with its line and column: an unknown menu, " +
      "a misspelled parameter, a syntax error, or RouterOS v6 syntax on a v7 router. Use it before " +
      "you run or propose a command or a script you wrote yourself, so a wrong command is caught " +
      "before it reaches a change. The answer is exact for that router's RouterOS version and " +
      "packages. It does NOT check values that are only looked up at run time (an interface that " +
      "does not exist, an address already in use). Accepts one command or a multi-line script. " +
      "Returns 'valid' or the problem and where it is.",
    inputSchema: {
      command: z.string().describe("A RouterOS command, or a script of several lines"),
    },
    async handler(a, ctx) {
      const text = a.command.trim();
      if (!text) return "Provide a RouterOS command to check.";
      const problem = await checkSyntax(text, ctx);
      if (problem === undefined)
        return {
          text: "The check could not run on this router, so the command is neither confirmed nor refused.",
          isError: true,
        };
      if (problem === null)
        return "Valid: this router's parser accepts the command. It was not run. Values that are looked up at run time (interface names, existing items) are not checked.";
      // An answer, not a failed call: the registry must not read the parser's words as an error.
      return {
        text: `Not valid on this router: ${describeProblem(problem)}. The command was not run.`,
        isError: false,
      };
    },
  }),
];
