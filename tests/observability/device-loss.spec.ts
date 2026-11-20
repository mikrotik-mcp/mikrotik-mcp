// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { LossBand, LossCell, lossPct, lossTone } from "../../ui/observability/device-loss";
import type { DeviceInfo } from "../../ui/observability/types";

const minute = 60_000;
const loss: NonNullable<DeviceInfo["loss"]> = {
  host: "10.0.0.1",
  sent: 360,
  lost: 24,
  pct: 6.666,
  longestGapMs: 10_000,
  longestGapAt: 20 * minute,
  avgMs: 24,
  jitterMs: 3,
  recent: [false, true, false],
  minutes: [
    { ts: 20 * minute, sent: 12, lost: 1, pct: 8.3, avgMs: 31 },
    { ts: 21 * minute, sent: 12, lost: 0, pct: 0, avgMs: 22 },
  ],
  addresses: [
    { host: "10.0.0.1", sent: 30, lost: 2, pct: 6.7, recent: [false, true, false] },
    { host: "192.168.88.1", sent: 30, lost: 30, pct: 100, recent: [true, true, true] },
  ],
};
const device = (over: Partial<DeviceInfo>): DeviceInfo =>
  ({ name: "lab-chr", host: "10.0.0.1", port: 22, status: {}, ...over }) as DeviceInfo;

test("a share reads without a needless decimal, and its tone follows 2% and 50%", () => {
  expect([0, 0.34, 6.666, 100].map(lossPct)).toEqual(["0%", "0.3%", "6.7%", "100%"]);
  expect([0, 1.9, 2, 49, 50].map(lossTone)).toEqual(["good", "good", "warn", "warn", "bad"]);
});

test("the table cell draws 30 ticks and the share, or a dash with no probes", () => {
  const html = renderToStaticMarkup(createElement(LossCell, { d: device({ loss }) }));
  expect(html.match(/<rect/g)).toHaveLength(30);
  expect(html).toContain("6.7%");
  expect(html).toContain("text-warning");
  expect(html).toContain("1 of the last 3 probes lost");
  expect(renderToStaticMarkup(createElement(LossCell, { d: device({}) }))).toContain("—");
});

test("the band shows the totals, the longest gap and one row for each address", () => {
  const html = renderToStaticMarkup(createElement(LossBand, { d: device({ loss }) }));
  for (const text of [
    "24 of 360 probes got no answer.",
    "Losing packets",
    "10 s, at ",
    "peak 8.3% at ",
    "192.168.88.1",
    "A probe is a TCP connection to the management port, every 5 s.",
  ])
    expect(html).toContain(text);
  expect(renderToStaticMarkup(createElement(LossBand, { d: device({}) }))).toBe("");
});
