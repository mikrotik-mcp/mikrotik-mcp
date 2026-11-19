// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import { flagPalette } from "../../ui/observability/flag-colours";

test("a flag's colours are read in the order the flag draws them", () => {
  const iran =
    '<svg><circle fill="#eee"/><path fill="#6da544" d="M0 0"/><path fill="#d80027" d="M0 0"/><path fill="#D80027"/></svg>';
  // White is left out: with two colours beside it, it only washes them out.
  expect(flagPalette(iran)).toEqual(["#6da544", "#d80027"]);
});

test("a flag of one colour and white keeps both, and no flag has no colours", () => {
  expect(flagPalette('<svg><path fill="#fff"/><path fill="#d80027"/></svg>')).toEqual([
    "#fff",
    "#d80027",
  ]);
  expect(flagPalette("")).toEqual([]);
  expect(flagPalette("flag not found")).toEqual([]);
});

test("at most three colours are used", () => {
  const many = ["#ff0000", "#00ff00", "#0000ff", "#ffcc00", "#00ccff"]
    .map((c) => `<path fill="${c}"/>`)
    .join("");
  expect(flagPalette(`<svg>${many}</svg>`)).toHaveLength(3);
});
