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
