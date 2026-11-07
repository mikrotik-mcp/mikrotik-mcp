// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import type { BandwidthRun } from "../../src/bandwidth/types";
import {
  BandwidthView,
  bandwidthMeasurement,
  bandwidthStatistics,
} from "../../ui/observability/bandwidth";
import { navigationGroups, parseViewHash } from "../../ui/observability/navigation";

test("failed, unfinished and absent measurements remain missing instead of zero", () => {
  for (const status of ["failed", "interrupted", "running"] as const) {
    expect(bandwidthMeasurement({ status, txBps: 1000000 } as BandwidthRun, "txBps")).toBeNull();
  }
  expect(bandwidthMeasurement(undefined, "txBps")).toBeNull();
  for (const value of [null, Number.NaN, Infinity, -1]) {
    expect(
      bandwidthMeasurement({ status: "ok", txBps: value } as BandwidthRun, "txBps"),
    ).toBeNull();
  }
  expect(bandwidthMeasurement({ status: "ok", txBps: 0 } as BandwidthRun, "txBps")).toBe(0);
  expect(bandwidthMeasurement({ status: "ok", rxBps: 2500000 } as BandwidthRun, "rxBps")).toBe(2.5);
});

test("initial view is disabled by default with bounded inputs and explicit live actions", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(BandwidthView));
  expect(host.textContent).toContain("Loading saved tests and history");
  expect(host.textContent).toContain("Load live source addresses");
  expect(host.textContent).toContain("Check readiness (live reads)");
  expect(host.textContent).toContain("path is not forced");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
  const numberInputs = [...host.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  expect(numberInputs.map((i) => [i.min, i.max])).toEqual([
    ["5", "60"],
    ["300", "604800"],
    ["1", "100000000000"],
    ["1", "100000000000"],
    ["28", "64000"],
    ["28", "64000"],
    ["1", "255"],
    ["0.02", "5"],
  ]);
  const report = numberInputs.at(-1)!;
  expect(report.step).toBe("0.001");
  expect(report.min).toBe("0.02");
  expect(report.max).toBe("5");
  expect(
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Save test")?.disabled,
  ).toBe(true);
});

test("bandwidth is routable and discoverable with tunnel vocabulary", () => {
  expect(parseViewHash("#/bandwidth")).toBe("bandwidth");
  expect(
    navigationGroups("tunnel throughput")
      .flatMap((g) => g.items)
      .some((i) => i.id === "bandwidth"),
  ).toBe(true);
});

test("polls only saved state until a live-read button is explicitly clicked", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { vi } = await import("vite-plus/test");
  vi.useFakeTimers();
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ jobs: [], runs: [], devices: ["source", "destination"], concurrency: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(BandwidthView));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url] of fetcher.mock.calls as unknown as [string][])
      expect(url).toMatch(/^\/api\/bandwidth(?:\?|$)/);
    expect(host.textContent).toContain("No saved tests");
    expect(host.textContent).toContain("No retained runs match");
    await act(async () => {
      root.unmount();
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("manual traffic waits for impact confirmation and sends no credentials or binding", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { vi } = await import("vite-plus/test");
  const job = {
    id: "tunnel-one",
    name: "Tunnel One",
    source: "source",
    destination: "destination",
    sourceInterface: "wg1",
    sourceAddress: "10.0.0.1",
    destinationAddress: "10.0.0.2",
    protocol: "tcp",
    direction: "both",
    durationSeconds: 10,
    localTxBps: 10000000,
    remoteTxBps: 10000000,
    localUdpTxSize: 1500,
    remoteUdpTxSize: 1500,
    connectionCount: 1,
    randomData: false,
    reportIntervalSeconds: 1,
    intervalSeconds: 300,
    enabled: false,
    nextRunAt: 0,
  };
  const fetcher = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? _url === "/api/bandwidth/preflight"
              ? { ready: true, checks: [], warning: "" }
              : { run: { status: "running" } }
            : { jobs: [job], runs: [], devices: ["source", "destination"], concurrency: 1 },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(BandwidthView));
    });
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Edit Tunnel One")!
        .click();
    });
    const randomData = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Generate random data"))!
      .querySelector("input")!;
    await act(async () => {
      randomData.click();
    });
    expect(randomData.checked).toBe(true);
    const report = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Report interval (seconds)"))!
      .querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        report,
        "0.021",
      );
      report.dispatchEvent(new Event("input", { bubbles: true }));
      report.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Check readiness (live reads)")!
        .click();
    });
    const readiness = fetcher.mock.calls.find(([url]) => url === "/api/bandwidth/preflight")!;
    expect(JSON.parse(readiness[1]!.body as string).job).toMatchObject({
      randomData: true,
      reportIntervalSeconds: 0.021,
    });
    fetcher.mockClear();
    const run = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Run Tunnel One",
    )!;
    await act(async () => {
      run.click();
    });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "can disrupt service",
    );
    const confirm = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Acknowledge impact & run",
    )!;
    await act(async () => {
      confirm.click();
    });
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/api/bandwidth/run");
    const body = writes[0][1]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({
      id: "tunnel-one",
      acknowledgeImpact: true,
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});

test("statistics include every successful observation and exclude missing/failed rates per direction", () => {
  const runs = [
    { status: "ok", txBps: 0, rxBps: null },
    { status: "ok", txBps: 6000000, rxBps: 2000000 },
    { status: "ok", txBps: 3000000, rxBps: 4000000 },
    { status: "failed", txBps: 900000000, rxBps: 900000000 },
    { status: "interrupted", txBps: 900000000 },
    { status: "running", txBps: 900000000 },
  ] as BandwidthRun[];
  expect(bandwidthStatistics(runs, "txBps")).toEqual({ count: 3, min: 0, mean: 3, max: 6 });
  expect(bandwidthStatistics(runs, "rxBps")).toEqual({ count: 2, min: 2, mean: 3, max: 4 });
  expect(bandwidthStatistics([], "txBps")).toEqual({ count: 0, min: null, mean: null, max: null });
});

test("comparison respects selected jobs and excludes runs outside the time window", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { vi } = await import("vite-plus/test");
  const now = Date.now();
  const runs = [
    {
      id: "a1",
      job: { id: "a", name: "Alpha" },
      startedAt: now,
      status: "ok",
      txBps: 2000000,
      rxBps: null,
    },
    {
      id: "a2",
      job: { id: "a", name: "Alpha" },
      startedAt: now,
      status: "failed",
      txBps: 999000000,
    },
    {
      id: "old",
      job: { id: "a", name: "Alpha" },
      startedAt: now - 25 * 3600000,
      status: "ok",
      txBps: 999000000,
    },
    { id: "b1", job: { id: "b", name: "Beta" }, startedAt: now, status: "ok", txBps: 8000000 },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ jobs: [], runs, devices: [], concurrency: 1 })),
    ),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(BandwidthView));
    });
    const history = host.querySelector('[aria-label="Bandwidth throughput history"]')!;
    const articles = () => [...history.querySelectorAll("article")];
    expect(articles()).toHaveLength(2);
    expect(articles()[0].textContent).toContain(
      "Successful: 1 · Failed/interrupted: 1 · Running: 0",
    );
    const tx = articles()[0].querySelector("tbody tr")!;
    expect([...tx.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "1",
      "2 Mbps",
      "2 Mbps",
      "2 Mbps",
    ]);
    const alpha = [...history.querySelectorAll("label")]
      .find((label) => label.textContent === "Alpha (deleted)")!
      .querySelector("input")!;
    await act(async () => {
      alpha.click();
    });
    expect(articles()).toHaveLength(1);
    expect(articles()[0].textContent).toContain("Alpha");
    expect(history.textContent).not.toContain("8 Mbps");
    expect(history.textContent).toContain("not like-for-like");
  } finally {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  }
});
