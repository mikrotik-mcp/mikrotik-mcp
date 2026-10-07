// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { AaaView } from "../../ui/observability/aaa";
import { api } from "../../ui/observability/api";
import type { UmUserCounters } from "../../src/observability/um-reports";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.mock("../../ui/observability/um-reports", () => ({ UmReports: () => null }));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: Root;
let readCounters: (device: string) => Promise<UmUserCounters>;
const counters = (device = "home", download = 1048576): UmUserCounters => ({
  device,
  available: true,
  collectedAt: Date.now(),
  rows: [
    { id: "*1", name: "alice", active: 2, seconds: 90061, download, upload: 2048 },
    { id: "*2", name: "zero", active: 0, seconds: 0, download: 0, upload: 0 },
  ],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.clearAllMocks();
  readCounters = async (device) => counters(device);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/devices")
      return { defaultDevice: "home", devices: [{ name: "home" }, { name: "remote" }] };
    if (path.startsWith("/api/aaa/user-counters"))
      return readCounters(new URL(path, "http://localhost").searchParams.get("device")!);
    if (path.startsWith("/api/aaa/list/um-profiles")) return { available: true, rows: [] };
    return {
      available: true,
      rows: ["alice", "zero", "unknown"].map((name) => ({ name, group: "default" })),
    };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
};
const open = async () => {
  await act(async () => root.render(h(AaaView)));
  expect(api).not.toHaveBeenCalledWith(expect.stringContaining("user-counters"), expect.anything());
  await click(button("Users"));
};
const row = (name: string) =>
  [...host.querySelectorAll("tbody tr")].find((tr) =>
    tr.querySelector("td")?.textContent?.startsWith(name),
  )!;
const ticks = async (ms: number) => {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
};
const reads = () => vi.mocked(api).mock.calls.filter(([path]) => path.includes("user-counters"));

test("shows user-perspective totals and refreshes without replacing an open edit form", async () => {
  await open();
  expect(row("alice").textContent).toContain("1d 01:01:01");
  expect(row("alice").textContent).toContain("1.0 MiB");
  expect(row("alice").textContent).toContain("2.0 KiB");
  expect(row("alice").textContent).toContain("2 active connections");
  expect(row("zero").textContent).toContain("00:00:00");
  expect(row("zero").textContent).toContain("0 B");
  expect(
    [...row("unknown").querySelectorAll("td")].filter((cell) => cell.textContent === "—"),
  ).toHaveLength(3);
  await click(button("Add"));
  const input = [...host.querySelectorAll("label")]
    .find((el) => el.textContent?.startsWith("Name"))!
    .querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  readCounters = async (device) => counters(device, 2097152);
  await ticks(5000);
  expect(row("alice").textContent).toContain("2.0 MiB");
  expect(input.value).toBe("draft");
  expect(reads()).toHaveLength(2);
  expect(api).not.toHaveBeenCalledWith(expect.stringContaining("/reports"), expect.anything());
});

test("retains last known totals on errors and accepts counter resets on recovery", async () => {
  await open();
  readCounters = async () => {
    throw new Error("Connection to device is unavailable");
  };
  await ticks(5000);
  expect(host.textContent).toContain("Counters unavailable");
  expect(host.textContent).toContain("showing last known values");
  expect(row("alice").textContent).toContain("1.0 MiB");
  readCounters = async (device) => counters(device, 0);
  await click(button("Refresh"));
  expect(row("alice").textContent).toContain("0 B");
  expect(host.textContent).not.toContain("Counters unavailable");
  expect(host.textContent).toContain("Live · 5s refresh");
});

test("shows router-local last connection dates, unknowns and background refresh states", async () => {
  readCounters = async (device) => ({
    ...counters(device),
    lastConnections: { status: "ready", collectedAt: Date.now() },
    rows: counters(device).rows.map((r) => ({
      ...r,
      lastConnection: r.name === "alice" ? "2026-10-05 23:45:56" : null,
    })),
  });
  await open();
  expect(host.textContent).toContain("Last connection");
  expect(row("alice").textContent).toContain("2026-10-05");
  expect(row("alice").textContent).toContain("23:45:56");
  expect(row("alice").querySelector('[title*="router local time"]')).not.toBeNull();
  expect(row("zero").textContent).toContain("Unknown");
  readCounters = async (device) => ({
    ...counters(device),
    lastConnections: { status: "pending" },
  });
  await ticks(5000);
  expect(row("zero").textContent).toContain("Loading…");
  readCounters = async (device) => ({
    ...counters(device),
    lastConnections: { status: "stale" },
    rows: counters(device).rows.map((r) => ({ ...r, lastConnection: "2026-10-05 23:45:56" })),
  });
  await ticks(5000);
  expect(row("alice").textContent).toContain("23:45:56");
});

test("pauses hidden tabs, avoids overlapping requests, and stops when leaving Users", async () => {
  let resolve!: (value: UmUserCounters) => void;
  readCounters = () =>
    new Promise((r) => {
      resolve = r;
    });
  await open();
  await ticks(20_000);
  expect(reads()).toHaveLength(1);
  await act(async () => resolve(counters()));
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await ticks(20_000);
  expect(reads()).toHaveLength(1);
  expect(host.textContent).toContain("Updates paused");
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  readCounters = async (device) => counters(device);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(reads()).toHaveLength(2);
  await click(button("Profiles"));
  await ticks(10_000);
  expect(reads()).toHaveLength(2);
});

test("aborts old-device reads and ignores late responses after switching routers", async () => {
  let finish!: (value: UmUserCounters) => void;
  readCounters = (device) =>
    device === "home"
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve(counters(device, 4096));
  await open();
  const oldSignal = reads()[0][1]!;
  await click(host.querySelector<HTMLElement>('[aria-label="Router"]')!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (el) => el.textContent === "remote",
    )!,
  );
  expect(oldSignal.aborted).toBe(true);
  expect(row("alice").textContent).toContain("4.0 KiB");
  await act(async () => finish(counters("home")));
  expect(row("alice").textContent).toContain("4.0 KiB");
  expect(row("alice").textContent).not.toContain("1.0 MiB");
});
