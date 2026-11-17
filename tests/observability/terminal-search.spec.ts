/** Terminal find bar: how a query becomes a pattern, and what it matches. */
import { expect, test, vi } from "vite-plus/test";
import { buildPattern, findMatches } from "../../ui/observability/terminal-search";

vi.mock("../../ui/observability/terminal-lib", () => ({ workspace: { activePane: "" } }));

const plain = { matchCase: false, words: false, regex: false };
const matches = (text: string, query: string, options = plain) => {
  const pattern = buildPattern(query, options);
  if (!(pattern instanceof RegExp)) return pattern;
  return findMatches(text, pattern).map(([from, to]) => text.slice(from, to));
};

test("a plain query is literal and ignores case", () => {
  expect(matches("ether1 Ether1 ether10", "ether1")).toEqual(["ether1", "Ether1", "ether1"]);
  expect(matches("10.0.0.1 1000001", "0.0.")).toEqual(["0.0."]);
  expect(matches("a (b) [c]", "(b)")).toEqual(["(b)"]);
  expect(buildPattern("", plain)).toBeNull();
});

test("match case, whole words and regular expressions", () => {
  expect(matches("ether1 Ether1", "ether1", { ...plain, matchCase: true })).toEqual(["ether1"]);
  expect(matches("ether1 ether10 wether1", "ether1", { ...plain, words: true })).toEqual([
    "ether1",
  ]);
  expect(matches("wg-home wg-fiber ether1", "wg-\\w+", { ...plain, regex: true })).toEqual([
    "wg-home",
    "wg-fiber",
  ]);
  expect(buildPattern("(", { ...plain, regex: true })).toBe("invalid");
});

test("empty matches are skipped and the result count is capped", () => {
  expect(matches("abc", "x*", { ...plain, regex: true })).toEqual([]);
  const pattern = buildPattern("a", plain) as RegExp;
  expect(findMatches("a".repeat(100), pattern, 10)).toHaveLength(10);
});
