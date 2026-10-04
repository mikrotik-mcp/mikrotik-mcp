// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DashboardSidebar } from "../../ui/observability/dashboard-shell";
import { AnimatedSidebarProvider } from "../../ui/observability/components/beui/registry/components/motion/animated-sidebar";
import { NAVIGATION_PINS_KEY } from "../../ui/observability/navigation-pins";
import type { ViewId } from "../../ui/observability/navigation";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigate = vi.fn();
const closeMobile = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(view: ViewId = "openvpn") {
  await act(async () =>
    root.render(
      h(
        AnimatedSidebarProvider,
        {},
        h(DashboardSidebar, {
          view,
          onNavigate: navigate,
          onMobileOpenChange: closeMobile,
          renderIcon: () => null,
          liveMode: "ws",
          feedCount: 0,
          firingCount: 2,
          releaseAvailable: false,
          controls: null,
        }),
      ),
    ),
  );
}
const heading = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button.shell-group-heading[aria-label="${label}"]`)!;
const track = (label: string) =>
  document.getElementById(heading(label).getAttribute("aria-controls")!)!;
async function search(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Find a page"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("active page opens its correct category, with counts and the shared scrollbar", async () => {
  await mount();
  expect(host.querySelectorAll(".shell-nav-group")).toHaveLength(8);
  expect(heading("Users & VPN").getAttribute("aria-expanded")).toBe("true");
  expect(heading("Users & VPN").dataset.active).toBe("true");
  expect(heading("Users & VPN").querySelector(".shell-group-size")?.textContent).toBe("3");
  expect(track("Users & VPN").hidden).toBe(false);
  expect(track("Users & VPN").querySelector('a[href="#openvpn"]')).not.toBeNull();
  expect(track("Network").hidden).toBe(true);
  expect(
    host.querySelector('.shell-nav-scroll [data-slot="scroll-area-viewport"] nav'),
  ).not.toBeNull();
  expect(heading("Monitoring").querySelector('[aria-label="2 alerts firing"]')).not.toBeNull();
});

test("navigating across categories reveals the new group without carrying the old expansion", async () => {
  await mount();
  await act(async () => heading("Backup & recovery").click());
  expect(track("Backup & recovery").hidden).toBe(false);
  await mount("capsman");
  expect(track("Network").hidden).toBe(false);
  expect(track("Backup & recovery").hidden).toBe(true);
  expect(track("Users & VPN").hidden).toBe(true);
});

test("reveals a below-fold active page by scrolling only the menu viewport", async () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches('[data-slot="scroll-area-viewport"]')) return new DOMRect(0, 100, 240, 200);
    if (this.matches('.shell-nav-group .shell-nav-link[aria-current="page"]'))
      return new DOMRect(0, 500, 200, 40);
    return new DOMRect();
  });
  const pageScroll = vi.spyOn(window, "scrollTo");
  await mount("config");
  const viewport = host.querySelector<HTMLElement>(
    '.shell-nav-scroll [data-slot="scroll-area-viewport"]',
  )!;
  expect(viewport.scrollTop).toBe(252);
  expect(pageScroll).not.toHaveBeenCalled();
});

test("search reveals matching pages and selecting a result clears the search and closes mobile", async () => {
  await mount();
  await search("wireless");
  expect(host.querySelectorAll(".shell-nav-group")).toHaveLength(1);
  expect(track("Network").hidden).toBe(false);
  const result = track("Network").querySelector<HTMLAnchorElement>('a[href="#capsman"]')!;
  await act(async () => result.click());
  expect(navigate).toHaveBeenCalledWith("capsman");
  expect(closeMobile).toHaveBeenCalledWith(false);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Find a page"]')!.value).toBe("");
  expect(host.querySelectorAll(".shell-nav-group")).toHaveLength(8);
  await search("no-matching-page");
  expect(host.querySelector(".shell-nav-empty")?.textContent).toContain("No matching pages");
});

test("existing pinned pages still open their unchanged routes", async () => {
  window.localStorage.setItem(NAVIGATION_PINS_KEY, '["capsman","openvpn","alerts"]');
  await mount();
  const pinned = host.querySelector('section[aria-label="Pinned pages"]')!;
  expect([...pinned.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
    "#capsman",
    "#openvpn",
    "#alerts",
  ]);
  await act(async () => pinned.querySelector<HTMLAnchorElement>('a[href="#capsman"]')!.click());
  expect(navigate).toHaveBeenCalledWith("capsman");
  expect(window.localStorage.getItem(NAVIGATION_PINS_KEY)).toBe('["capsman","openvpn","alerts"]');
});
