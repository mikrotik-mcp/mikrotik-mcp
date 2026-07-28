import { describe, expect, test } from "vite-plus/test";
import { orMatch } from "../../src/utils/or-match";

describe("orMatch", () => {
  test("builds a parenthesised OR of regex-match terms by default", () => {
    expect(orMatch("topics", ["system", "firewall", "error"])).toBe(
      '(topics~"system" or topics~"firewall" or topics~"error")',
    );
  });

  test("uses double quotes, never single quotes (RouterOS where-clause requirement)", () => {
    const clause = orMatch("topics", ["system"]);
    expect(clause.includes("'")).toBe(false);
    expect(clause).toBe('(topics~"system")');
  });

  test("supports exact-match operator", () => {
    expect(orMatch("action", ["accept", "drop"], "=")).toBe('(action="accept" or action="drop")');
  });

  test("returns an empty string for an empty value list", () => {
    expect(orMatch("topics", [])).toBe("");
  });

  test("escapes embedded double quotes in values", () => {
    expect(orMatch("message", ['say "hi"'])).toBe('(message~"say \\"hi\\"")');
  });

  test("escapes backslashes so a trailing one cannot escape the closing quote", () => {
    // Raw value: `C:\` — without escaping the backslash the clause would end
    // `"C:\"` and the console would read the closing quote as string content.
    expect(orMatch("comment", ["C:\\"])).toBe('(comment~"C:\\\\")');
    expect(orMatch("comment", ['a\\"b'])).toBe('(comment~"a\\\\\\"b")');
  });
});
