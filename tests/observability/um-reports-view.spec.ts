// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { UmReports } from "../../ui/observability/um-reports";
import { api } from "../../ui/observability/api";
import { saveDownload } from "../../ui/observability/workspace-ui";
import {
  buildUmReport,
  parseUmReportQuery,
  UM_REPORT_FIELDS,
} from "../../src/observability/um-reports";
import type { UmSnapshot } from "../../src/observability/um-reports";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn() }));
vi.mock("../../ui/observability/workspace-ui", () => ({ saveDownload: vi.fn() }));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  const sources = Object.fromEntries(
    Object.keys(UM_REPORT_FIELDS).map((key) => [key, { available: true, rows: [] }]),
  ) as unknown as UmSnapshot["sources"];
  sources.users.rows = [{ ".id": "*1", name: "alice" }];
  sources.totals.rows = [{ ".id": "*1", "active-sessions": "1" }];
  sources.sessions.rows = [
    {
      ".id": "*A",
      user: "alice",
      started: "2026-09-28 10:00:00",
      download: "1024",
      upload: "512",
      uptime: "1h",
      "user-address": "192.0.2.99",
    },
  ];
  const snapshot: UmSnapshot = {
    device: "edge",
    collectedAt: Date.parse("2026-09-28T11:00:00Z"),
    collectionMs: 100,
    clock: { zone: "UTC", offsetMs: 0 },
    sources,
  };
  vi.mocked(api).mockImplementation(async (path) =>
    buildUmReport(snapshot, parseUmReportQuery(new URL(path, "http://fixture").searchParams)),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(UmReports, { device: "edge" })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
test("retains accounting statistics and charts without a session list or its controls", () => {
  for (const label of [
    "Download accounted",
    "Upload accounted",
    "Active now",
    "Connected time",
    "The traffic story",
    "When connections happen",
    "How sessions ended",
    "Connection calendar",
  ])
    expect(host.textContent).toContain(label);
  expect(host.querySelectorAll('[data-slot="chart"]')).toHaveLength(2);
  expect(host.querySelectorAll(".um-calendar-day[data-active=true]")).toHaveLength(1);
  expect(host.textContent).not.toContain("Session explorer");
  expect(host.textContent).not.toContain("192.0.2.99");
  expect(host.querySelector('[aria-label="Search sessions"]')).toBeNull();
  expect(host.querySelector('[aria-label="Session state"]')).toBeNull();
  expect(host.querySelector(".um-pagination")).toBeNull();
  const query = new URL(vi.mocked(api).mock.calls[0][0], "http://fixture").searchParams;
  for (const key of ["search", "state", "page"]) expect(query.has(key)).toBe(false);
});
test("exports full-period statistics without individual session records", async () => {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Export report",
  )!;
  await act(async () => button.click());
  const report = JSON.parse(vi.mocked(saveDownload).mock.calls[0][1]);
  expect(report.sessions).toBeUndefined();
  expect(report.summary).toMatchObject({ sessions: 1, download: 1024, upload: 512, seconds: 3600 });
  expect(report.users[0]).toMatchObject({ name: "alice", sessions: 1 });
  expect(report.series.at(-1)).toMatchObject({ cumulativeDownload: 1024, cumulativeUpload: 512 });
  expect(report.hours[10].sessions).toBe(1);
});
test("keeps individual-user statistical filtering", async () => {
  await act(async () => host.querySelector<HTMLButtonElement>(".um-user-button")!.click());
  expect(host.textContent).toContain("alice · traffic story");
  expect(host.textContent).toContain("INDIVIDUAL USER");
  const query = new URL(vi.mocked(api).mock.calls.at(-1)![0], "http://fixture").searchParams;
  expect(query.get("user")).toBe("alice");
  expect(host.textContent).not.toContain("Session explorer");
});

test("polls background refresh promptly, labels stale data and keeps charts visible", async () => {
  const report = await vi.mocked(api).mock.results[0].value;
  vi.mocked(api).mockResolvedValue({
    ...report,
    cache: { stale: true, refreshing: true },
    refreshAfterMs: 3000,
  });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(host.textContent).toContain("Refreshing in the background");
  expect(host.textContent).toContain("Counters are not live");
  expect(host.querySelectorAll('[data-slot="chart"]')).toHaveLength(2);
  expect(host.querySelector(".um-loading")).toBeNull();
  const calls = vi.mocked(api).mock.calls.length;
  vi.mocked(api).mockResolvedValue(report);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api).toHaveBeenCalledTimes(calls + 1);
  expect(host.textContent).not.toContain("Counters are not live");
});

test("manual Refresh bypasses TTL once, while later filtering uses the shared cache", async () => {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!;
  await act(async () => button.click());
  expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain("refresh=true");
  await act(async () => host.querySelector<HTMLButtonElement>(".um-user-button")!.click());
  expect(vi.mocked(api).mock.calls.at(-1)![0]).not.toContain("refresh=true");
});

test("does not display another router's cached data during a slow or failed switch", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await act(async () => root.render(h(UmReports, { device: "remote" })));
  expect(host.querySelectorAll('[data-slot="chart"]')).toHaveLength(0);
  expect(host.textContent).not.toContain("alice");
  expect(host.textContent).toContain("Building the first cached snapshot");
  await act(async () => fail(new Error("Device connection unavailable")));
  expect(host.textContent).toContain("Device connection unavailable");
  expect(host.textContent).not.toContain("alice");
});

test("polls cold collection progress without showing false zero totals and recovers", async () => {
  const report = await vi.mocked(api).mock.results[0].value;
  vi.mocked(api).mockResolvedValue({
    device: "remote",
    status: "collecting",
    refreshAfterMs: 3000,
    progress: { source: "sessions", completed: 2000, total: 23_243 },
  });
  await act(async () => root.render(h(UmReports, { device: "remote" })));
  expect(host.textContent).toContain("2,000 / 23,243 sessions verified");
  expect(host.querySelector("progress")?.value).toBe(2000);
  expect(host.textContent).not.toContain("Download accounted");
  vi.mocked(api).mockResolvedValue({
    device: "remote",
    status: "error",
    error: "Device connection unavailable",
    refreshAfterMs: 30_000,
    progress: { source: "sessions", completed: 2000, total: 23_243 },
  });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(host.textContent).toContain("Device connection unavailable");
  expect(host.querySelector(".um-loading")).toBeNull();
  vi.mocked(api).mockResolvedValue({ ...report, device: "remote" });
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(host.textContent).toContain("Download accounted");
  expect(host.textContent).not.toContain("Device connection unavailable");
});

test("a stalled HTTP request times out instead of leaving an endless spinner", async () => {
  vi.mocked(api).mockImplementationOnce(
    (_path, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  await act(async () => root.render(h(UmReports, { device: "remote" })));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.textContent).toContain("did not respond within 15 seconds");
  expect(host.querySelector(".um-loading")).toBeNull();
});

test("distinguishes RAM-only cache from a successfully saved snapshot", async () => {
  const report = await vi.mocked(api).mock.results[0].value;
  vi.mocked(api).mockResolvedValue({ ...report, cache: { ...report.cache, persisted: false } });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(host.textContent).toContain("Memory-only cache");
  expect(host.textContent).toContain("This report could not be saved to disk");
  expect(host.querySelectorAll('[data-slot="chart"]')).toHaveLength(2);
});
