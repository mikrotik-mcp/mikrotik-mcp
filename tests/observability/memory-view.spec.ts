// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MemoryView } from "../../ui/observability/memory";
import { api, postJson } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({
  api: vi.fn(),
  postJson: vi.fn(),
  deleteJson: vi.fn(),
}));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let root: Root;
let host: HTMLDivElement;
let enabled: boolean;
const fact = {
  id: 1,
  entityName: "edge",
  content: "Keep management reachable",
  key: "management",
  kind: "constraint",
  source: "operator",
  confidence: 0.8,
  pinned: true,
  expiresAt: null,
  verifiedAt: null,
  createdAt: 1,
  updatedAt: 1,
  revision: 3,
  status: "active",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  enabled = true;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/memory/config")
      return { enabled, dbPath: "/tmp/demo-memory.db", stats: null };
    if (path === "/api/memory/summary")
      return { stats: { entities: 1 }, health: { active: 1, review: 1, pinned: 1, archived: 0 } };
    if (path.startsWith("/api/memory/entities"))
      return { items: [{ name: "edge", entityType: "router" }], total: 1 };
    if (path.startsWith("/api/memory/entity/")) return { relations: [] };
    if (path.includes("history") || path.includes("activity")) return [];
    if (path.startsWith("/api/memory/facts"))
      return { items: [fact], total: 1, offset: 0, limit: 24 };
    throw new Error(`Unexpected request ${path}`);
  });
  vi.mocked(postJson).mockResolvedValue({ ...fact, revision: 4 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(h(MemoryView)));
const click = (element: HTMLElement) => act(async () => element.click());
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === text,
  )!;
const fill = async (element: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
test("uses paginated memory reads, scoped entities, and revision-safe actions", async () => {
  await render();
  expect(host.textContent).toContain("Keep management reachable");
  expect(vi.mocked(api).mock.calls.some(([path]) => path === "/api/memory/graph")).toBe(false);
  await click(host.querySelector<HTMLElement>('[aria-label="Unpin memory"]')!);
  expect(postJson).toHaveBeenCalledWith("/api/memory/facts/revise", {
    id: 1,
    expectedRevision: 3,
    pinned: false,
  });
  const subject = [...host.querySelectorAll<HTMLElement>(".memory-subject")].find(
    (el) => el.querySelector("small")?.textContent === "router",
  )!;
  await click(subject);
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes("entityName=edge"))).toBe(true);
  await click(host.querySelector<HTMLElement>('[data-tone="pinned"]')!);
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes("state=pinned"))).toBe(true);
});
test("refresh does not clear the search or replace filtered results with the full graph", async () => {
  vi.useFakeTimers();
  await render();
  await fill(host.querySelector<HTMLInputElement>('[aria-label="Search knowledge"]')!, "WireGuard");
  await act(async () => vi.advanceTimersByTime(260));
  await act(async () => vi.advanceTimersByTime(30000));
  const requests = vi
    .mocked(api)
    .mock.calls.map(([path]) => path)
    .filter((path) => path.startsWith("/api/memory/facts?"));
  expect(requests.at(-1)).toContain("query=WireGuard");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Search knowledge"]')!.value).toBe(
    "WireGuard",
  );
});
test("disabled memory remains configurable and never renders fabricated zero metrics", async () => {
  enabled = false;
  await render();
  expect(host.textContent).toContain("Knowledge memory is disabled");
  expect(host.querySelector(".memory-health")!.textContent).toContain("—");
  await click(button("Settings"));
  expect(document.querySelector('[aria-label="Enable knowledge memory"]')).not.toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});
test("failed memory creation keeps the form and explains the error", async () => {
  await render();
  await click(button("Add memory"));
  vi.mocked(postJson).mockResolvedValue({ error: "Entity not found; create it first" });
  const dialog = document.querySelector('[role="dialog"]')!;
  await act(async () =>
    dialog
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("Entity not found");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
