// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { BandwidthRun } from "../../src/bandwidth/types";
import {
  BandwidthView,
  bandwidthMeasurement,
  bandwidthStatistics,
} from "../../ui/observability/bandwidth";
import { navigationGroups, parseViewHash } from "../../ui/observability/navigation";

// Happy DOM rejects cancelled WAAPI animations; exercise the real controls with Motion's JS fallback.
const animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
beforeAll(() => {
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: undefined });
});
afterAll(() => {
  if (animateDescriptor) Object.defineProperty(Element.prototype, "animate", animateDescriptor);
});

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
  expect(host.textContent).toContain("Selecting a router reads its interfaces");
  expect(host.textContent).toContain("Check readiness (live reads)");
  expect(host.textContent).toContain("path is not forced");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
  expect(host.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(0);
  const advanced = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
    (button) => button.textContent?.includes("Advanced Options"),
  )!;
  expect(advanced.textContent).toContain("Advanced Options");
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  const advancedContent = advanced.parentElement!.querySelector<HTMLElement>("[hidden]")!;
  expect(advancedContent.hidden).toBe(true);
  const generatedId = advancedContent.querySelector<HTMLInputElement>("input[readonly]")!;
  expect(generatedId.value).toMatch(/^[a-f0-9-]{36}$/);
  expect(advancedContent.querySelectorAll('input[type="number"]')).toHaveLength(4);
  const visibleNumbers = [...host.querySelectorAll('input[type="number"]')].filter(
    (input) => !input.closest("[hidden]"),
  );
  expect(visibleNumbers).toHaveLength(4);
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
            : String(_url).includes("/options?")
              ? {
                  interfaces: [
                    { name: "wg1", running: true, disabled: false },
                    { name: "ether2", running: true, disabled: false },
                  ],
                  addresses: [
                    {
                      interface: "wg1",
                      address: String(_url).includes("device=source") ? "10.0.0.1" : "10.0.0.2",
                    },
                  ],
                }
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
    const advanced = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Advanced Options"),
    )!;
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      advanced.click();
    });
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    const randomData = host.querySelector<HTMLButtonElement>(
      '[role="checkbox"][aria-label="Generate random data"]',
    )!;
    await act(async () => {
      randomData.click();
    });
    expect(randomData.getAttribute("aria-checked")).toBe("true");
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
      advanced.click();
    });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(report.closest("[hidden]")).not.toBeNull();
    expect(report.value).toBe("0.021");
    const recurring = host.querySelector<HTMLButtonElement>(
      '[role="checkbox"][aria-label="Enable recurring traffic (off by default)"]',
    )!;
    const acknowledgement = host.querySelector<HTMLButtonElement>(
      '[role="checkbox"][aria-label="I acknowledge the traffic impact"]',
    )!;
    await act(async () => {
      acknowledgement.click();
    });
    expect(acknowledgement.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      recurring.click();
    });
    expect(recurring.getAttribute("aria-checked")).toBe("true");
    expect(acknowledgement.getAttribute("aria-checked")).toBe("false");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Check readiness (live reads)")!
        .click();
    });
    const readiness = fetcher.mock.calls.find(([url]) => url === "/api/bandwidth/preflight")!;
    expect(JSON.parse(readiness[1]!.body as string).job).toMatchObject({
      randomData: true,
      reportIntervalSeconds: 0.021,
      enabled: true,
      localUdpTxSize: 1500,
      remoteUdpTxSize: 1500,
      connectionCount: 1,
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
    const alpha = history.querySelector<HTMLButtonElement>(
      '[role="checkbox"][aria-label="Alpha (deleted)"]',
    )!;
    expect(history.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => {
      alpha.click();
    });
    expect(alpha.getAttribute("aria-checked")).toBe("true");
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

test("router changes load inventory automatically, cancel stale reads and expose retry without generating traffic", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { vi } = await import("vite-plus/test");
  const job = {
    id: "first",
    name: "First",
    source: "slow",
    destination: "dest",
    sourceInterface: "wg1",
    sourceAddress: "10.0.0.1",
    destinationAddress: "10.0.0.2",
    protocol: "tcp",
    direction: "both",
    durationSeconds: 10,
    intervalSeconds: 300,
    localTxBps: 1,
    remoteTxBps: 1,
    localUdpTxSize: 1500,
    remoteUdpTxSize: 1500,
    connectionCount: 1,
    randomData: false,
    reportIntervalSeconds: 1,
    enabled: false,
    nextRunAt: 0,
  };
  let resolveSlow!: (response: Response) => void;
  let slowSignal: AbortSignal | undefined;
  let failDestination = true;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("device=slow")) {
      slowSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        resolveSlow = resolve;
      });
    }
    if (String(url).includes("device=dest") && failDestination)
      return new Response(JSON.stringify({ error: "Router unreachable" }), { status: 503 });
    if (String(url).includes("/options?"))
      return new Response(
        JSON.stringify({
          interfaces: [
            { name: "wg1", running: true, disabled: false },
            { name: "ether2", running: true, disabled: false },
          ],
          addresses: [
            {
              interface: "wg1",
              address: String(url).includes("device=dest") ? "10.0.0.2" : "10.0.0.1",
            },
          ],
        }),
      );
    return new Response(
      JSON.stringify({
        jobs: [job, { ...job, id: "second", name: "Second", source: "fast" }],
        runs: [],
        devices: ["slow", "fast", "dest"],
        concurrency: 2,
      }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () => {
      root.render(createElement(BandwidthView));
    });
    expect(fetcher.mock.calls).toHaveLength(1);
    await act(async () => {
      button("Edit First").click();
    });
    expect(host.textContent).toContain("Loading source inventory");
    expect(host.textContent).toContain("Router unreachable");
    await act(async () => {
      button("Edit Second").click();
    });
    expect(slowSignal?.aborted).toBe(true);
    expect(host.textContent).toContain("Source: 2 interfaces");
    await act(async () => {
      resolveSlow(
        new Response(
          JSON.stringify({
            interfaces: [{ name: "stale", running: true, disabled: false }],
            addresses: [],
          }),
        ),
      );
    });
    expect(host.textContent).toContain("Source: 2 interfaces");
    failDestination = false;
    await act(async () => {
      button("Retry destination inventory").click();
    });
    expect(host.textContent).not.toContain("Router unreachable");
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Expected source interface"]')?.disabled,
    ).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Expected source IPv4"]')?.disabled,
    ).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Destination IPv4 (explicit)"]')?.disabled,
    ).toBe(false);
    for (const label of [
      "Expected source interface",
      "Expected source IPv4",
      "Destination IPv4 (explicit)",
    ])
      expect(host.querySelector(`[aria-label="${label}"]`)?.getAttribute("role")).toBe("combobox");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
