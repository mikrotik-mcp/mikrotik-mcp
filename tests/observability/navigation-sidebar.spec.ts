// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  DashboardSidebar,
  SIDEBAR_COLLAPSED_KEY,
  useSidebarCollapsed,
} from "../../ui/observability/dashboard-shell";
import { CommandPalette } from "../../ui/observability/command-palette";
import { NAVIGATION_PINS_KEY } from "../../ui/observability/navigation-pins";
import {
  readRecentPages,
  rememberRecentPage,
  RECENT_PAGES_KEY,
} from "../../ui/observability/recent-pages";
import type { ViewId } from "../../ui/observability/navigation";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigate = vi.fn();
const closeMobile = vi.fn();
const openSearch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Reduced motion: state changes land at once instead of after an animation.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
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
      h(DashboardSidebar, {
        view,
        onNavigate: navigate,
        onMobileOpenChange: closeMobile,
        onSearch: openSearch,
        renderIcon: () => null,
        liveMode: "ws",
        feedCount: 0,
        firingCount: 2,
        releaseAvailable: false,
        controls: null,
      }),
    ),
  );
}
const heading = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button.shell-group-heading[aria-label="${label}"]`)!;
const track = (label: string) =>
  document.getElementById(heading(label).getAttribute("aria-controls")!)!;

test("active page opens its correct category, with counts and the shared scrollbar", async () => {
  await mount();
  expect(host.querySelectorAll(".shell-nav-group")).toHaveLength(8);
  expect(heading("Users & VPN").getAttribute("aria-expanded")).toBe("true");
  expect(heading("Users & VPN").dataset.active).toBe("true");
  expect(heading("Users & VPN").querySelector(".shell-group-size")?.textContent).toBe("4");
  expect(track("Users & VPN").hidden).toBe(false);
  expect(track("Users & VPN").querySelector('a[href="#openvpn"]')).not.toBeNull();
  expect(track("Network").hidden).toBe(true);
  expect(
    host.querySelector('.shell-nav-scroll [data-slot="scroll-area-viewport"] .shell-groups'),
  ).not.toBeNull();
  expect(heading("Monitoring").querySelector('[aria-label="2 alerts firing"]')).not.toBeNull();
  expect(host.querySelector('nav[aria-label="Dashboard navigation"]')).not.toBeNull();
  expect(host.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("#openvpn");
});

test("navigating across categories reveals the new group without carrying the old expansion", async () => {
  await mount();
  await act(async () => heading("Backup & recovery").click());
  expect(track("Backup & recovery").hidden).toBe(false);
  await act(async () => heading("Backup & recovery").click());
  expect(track("Backup & recovery").hidden).toBe(true);
  await act(async () => heading("Backup & recovery").click());
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

test("the search field opens the palette, and choosing a page closes the mobile menu", async () => {
  await mount();
  const field = host.querySelector<HTMLButtonElement>("button.sb-search")!;
  expect(field.textContent).toContain("Jump to a page");
  expect(field.getAttribute("aria-haspopup")).toBe("dialog");
  await act(async () => field.click());
  expect(openSearch).toHaveBeenCalledOnce();
  await act(async () => heading("Network").click());
  await act(async () =>
    track("Network").querySelector<HTMLAnchorElement>('a[href="#capsman"]')!.click(),
  );
  expect(navigate).toHaveBeenCalledWith("capsman");
  expect(closeMobile).toHaveBeenCalledWith(false);
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

// ── search palette ───────────────────────────────────────────────────────────

const setOpen = vi.fn();
const collapse = vi.fn();
async function palette() {
  await act(async () =>
    root.render(
      h(CommandPalette, {
        open: true,
        onOpenChange: setOpen,
        onNavigate: navigate,
        renderIcon: () => null,
        actions: [{ id: "navigation", label: "Collapse sidebar", icon: null, run: collapse }],
      }),
    ),
  );
}
const input = () => document.querySelector<HTMLInputElement>('.pal input[role="combobox"]')!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () =>
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    ),
  );
}
const options = () =>
  [...document.querySelectorAll<HTMLElement>('.pal [role="option"]')].map((option) =>
    option.id.replace("shell-palette-", ""),
  );

test("the palette is a dialog with a combobox over a listbox, focused on open", async () => {
  await palette();
  const dialog = document.querySelector('.pal[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(input());
  expect(input().getAttribute("aria-controls")).toBe("shell-palette-list");
  expect(document.getElementById("shell-palette-list")?.getAttribute("role")).toBe("listbox");
  expect(input().getAttribute("aria-activedescendant")).toBe(
    document.querySelector('[role="option"][aria-selected="true"]')?.id,
  );
});

test("search matches words over labels, descriptions, groups and extra terms", async () => {
  await palette();
  await type("wireless");
  expect(options().filter((id) => id.startsWith("page-"))).toEqual(["page-capsman"]);
  expect(document.querySelector(".pal-count")?.textContent).toBe("1 page matches");
  // Words found in the visible label are marked.
  await type("caps");
  expect(document.querySelector('[id="shell-palette-page-capsman"] mark')?.textContent).toBe(
    "CAPs",
  );
  await act(async () =>
    document.querySelector<HTMLElement>('[id="shell-palette-page-capsman"]')!.click(),
  );
  expect(setOpen).toHaveBeenCalledWith(false);
  expect(navigate).toHaveBeenCalledWith("capsman");
});

test("arrows move the selection, Enter opens it and Ctrl Enter opens a new tab", async () => {
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  await palette();
  await type("router");
  const first = options()[0];
  await press("ArrowDown");
  const second = options()[1];
  expect(input().getAttribute("aria-activedescendant")).toBe(`shell-palette-${second}`);
  await press("ArrowUp");
  expect(input().getAttribute("aria-activedescendant")).toBe(`shell-palette-${first}`);
  await press("Enter", { ctrlKey: true });
  expect(open).toHaveBeenCalledWith(`#${first.replace("page-", "")}`, "_blank", "noopener");
  expect(navigate).not.toHaveBeenCalled();
  await press("Enter");
  expect(navigate).toHaveBeenCalledWith(first.replace("page-", ""));
});

test("actions run from the palette, and Escape closes without navigating", async () => {
  await palette();
  await type("no-matching-page");
  expect(document.querySelector(".pal .shell-nav-empty")?.textContent).toContain(
    "No matching pages",
  );
  expect(options()).toEqual(["action-navigation"]);
  await press("Enter");
  expect(collapse).toHaveBeenCalledOnce();
  expect(setOpen).toHaveBeenCalledWith(false);
  setOpen.mockClear();
  await press("Escape");
  expect(setOpen).toHaveBeenCalledWith(false);
  expect(navigate).not.toHaveBeenCalled();
});

test("recent pages are remembered newest first, deduplicated and capped", () => {
  rememberRecentPage("devices");
  rememberRecentPage("feed");
  rememberRecentPage("devices");
  rememberRecentPage("capsman");
  rememberRecentPage("alerts");
  expect(readRecentPages()).toEqual(["alerts", "capsman", "devices"]);
  window.localStorage.setItem(RECENT_PAGES_KEY, '["nope", 3, "feed"]');
  expect(readRecentPages()).toEqual(["feed"]);
});

test("the collapsed sidebar choice survives a reload", async () => {
  function Probe() {
    const [collapsed, set] = useSidebarCollapsed();
    return h(
      "button",
      { type: "button", onClick: () => set(!collapsed) },
      collapsed ? "rail" : "open",
    );
  }
  await act(async () => root.render(h(Probe)));
  expect(host.textContent).toBe("open");
  await act(async () => host.querySelector("button")!.click());
  expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
  await act(async () => root.render(null));
  await act(async () => root.render(h(Probe)));
  expect(host.textContent).toBe("rail");
});
