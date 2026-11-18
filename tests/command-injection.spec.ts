/**
 * RouterOS console injection through tool arguments (GHSA-63gj-jfjx-xf7g,
 * GHSA-r4cq-vhjf-mppv, GHSA-2g58-43c8-4w2m, GHSA-p524-m32j-hf32).
 *
 * A tool argument is data. Whatever it holds, it must reach the router inside a
 * string literal, where `;`, `[ ]` and `$` have no meaning.
 */
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";

const command = vi.hoisted(() => vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const { quoted, quoteValue } = await import("../src/core/routeros");
const { interfaceTools } = await import("../src/tools/interfaces");

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

/**
 * The parts of a console command that are NOT inside a string literal: what
 * the router reads as commands, separators and substitutions.
 */
export function outsideStrings(cmd: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const char = cmd[i];
    if (inString && char === "\\") i += 1;
    else if (char === '"') inString = !inString;
    else if (!inString) out += char;
  }
  // A string that never closes would swallow the rest of the line on the router too.
  return inString ? `${out}<unterminated>` : out;
}

const run = async (name: string, args: Record<string, unknown>): Promise<string[]> => {
  const tool = interfaceTools.find((candidate) => candidate.name === name)!;
  await tool.handler(args as never, ctx);
  return command.mock.calls.map(([cmd]) => cmd);
};

describe("string literals", () => {
  test("quoted always quotes, and escapes what would end or extend the string", () => {
    expect(quoted("ether1")).toBe('"ether1"');
    expect(quoted('a"b')).toBe('"a\\"b"');
    expect(quoted("a\\")).toBe('"a\\\\"');
    expect(quoted("$[/user add name=x]")).toBe('"\\$[/user add name=x]"');
    expect(quoted("line1\nline2")).toBe('"line1\\nline2"');
    expect(quoted(5)).toBe('"5"');
  });
  test("neither helper lets a value leave its string", () => {
    for (const value of [
      'x"] ; /user add name=evil group=full ; #',
      'e" ; /system reset-configuration ; "',
      "a\\",
      'a\\" ; /user add name=evil',
      "$[/user add name=evil group=full]",
      "$(/system reboot)",
    ]) {
      for (const literal of [quoted(value), quoteValue(value)]) {
        const outside = outsideStrings(`/x print where name=${literal}`);
        expect(outside, literal).toBe("/x print where name=");
      }
    }
  });
});

describe("the proofs of concept of the reports no longer leave the string", () => {
  const evil = "/user add name=mcp_backdoor password=Pwn3d! group=full";
  test.each([
    ["get_interface", { name: `ether1" ; ${evil} ; /ip firewall filter print where comment="` }],
    ["list_interfaces", { name_filter: `e" ; ${evil} ; /interface print where name~"` }],
    ["enable_interface", { name: `x"] ; ${evil} ; #` }],
    ["disable_interface", { name: `x"] ; ${evil} ; #` }],
  ])("%s", async (name, args) => {
    const commands = await run(name, args);
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      const outside = outsideStrings(cmd);
      expect(outside, cmd).not.toContain("/user add");
      expect(outside, cmd).not.toContain(";");
      expect(outside, cmd).not.toContain("<unterminated>");
    }
  });
});
