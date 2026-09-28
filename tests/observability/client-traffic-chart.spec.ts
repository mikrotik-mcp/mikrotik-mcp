// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrafficChart } from "../../ui/observability/clients";

test("client traffic chart fills its container without letterboxing or scaling its strokes", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(TrafficChart, {
      history: [
        { ts: 1000, rx: 10, tx: 2 },
        { ts: 2000, rx: 20, tx: 4 },
        { ts: 5000, rx: 15, tx: 3 },
      ],
    }),
  );
  const chart = host.querySelector("svg")!;
  expect(chart.classList.contains("w-full")).toBe(true);
  expect(chart.getAttribute("class")).not.toContain("max-w-");
  expect(chart.getAttribute("preserveAspectRatio")).toBe("none");
  expect(chart.getAttribute("aria-label")).toContain("download and upload");
  const lines = [...chart.querySelectorAll("polyline")];
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(line.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    // First/latest samples reach opposite padded edges, even before history fills.
    const x = line
      .getAttribute("points")!
      .split(" ")
      .map((p) => Number(p.split(",")[0]));
    expect(x).toEqual([8, 134, 512]);
  }
});
