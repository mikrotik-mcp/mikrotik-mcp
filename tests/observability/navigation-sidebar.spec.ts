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
const sectionPicker = () =>
  host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Browse section"]')!;
const pages = () => host.querySelector<HTMLElement>(".shell-section-pages")!;
async function browse(label: string) {
  await act(async () => sectionPicker().click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes(label),
  )!;
  await act(async () => option.click());
}

test("opens the current section and keeps firing alerts reachable from another section", async () => {
  await mount();
  expect(sectionPicker().textContent).toContain("Users & VPN");
  expect(pages().querySelectorAll("a")).toHaveLength(5);
  expect(pages().querySelector('a[href="#http-proxy"]')).toBeTruthy();
  expect(pages().querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("#openvpn");
  expect(host.querySelector('a[aria-label="2 alerts firing"]')?.getAttribute("href")).toBe(
    "#alerts",
  );
  await act(async () => sectionPicker().click());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(8);
});

test("browsing a different section previews its pages and route changes reveal the destination", async () => {
  await mount();
  await browse("Backup & recovery");
  expect(pages().getAttribute("aria-label")).toBe("Backup & recovery");
  expect(navigate).not.toHaveBeenCalled();
  await mount("capsman");
  expect(sectionPicker().textContent).toContain("Network");
  expect(pages().querySelector('[aria-current="page"]')?.getAttribute("href")).toBe("#capsman");
  await mount("openvpn");
  expect(sectionPicker().textContent).toContain("Users & VPN");
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
  await browse("Network");
  await act(async () => pages().querySelector<HTMLAnchorElement>('a[href="#capsman"]')!.click());
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

test("navigation width can be adjusted, restored on remount and reset", async () => {
  await mount();
  const divider = () =>
    host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize navigation"]')!;
  await act(async () =>
    divider().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  expect(divider().getAttribute("aria-valuenow")).toBe("384");
  await act(async () => root.render(null));
  await mount();
  expect(divider().getAttribute("aria-valuenow")).toBe("384");
  await act(async () => divider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(divider().getAttribute("aria-valuenow")).toBe("280");
});

test("pinned pages are a board: a number key, the group, and a live number", async () => {
  window.localStorage.setItem(NAVIGATION_PINS_KEY, JSON.stringify(["feed", "alerts", "terminal"]));
  await mount("alerts");
  const rows = [...host.querySelectorAll<HTMLElement>(".shell-pinned .shell-pin")];
  expect(rows.map((row) => row.querySelector(".shell-pin-key")!.textContent)).toEqual([
    "1",
    "2",
    "3",
  ]);
  expect(rows.map((row) => row.querySelector(".shell-pin-group")!.textContent)).toEqual([
    "Monitoring",
    "Monitoring",
    "Router configuration",
  ]);
  // Only a page with a live number shows one: 2 alerts fire, the feed is empty.
  expect(rows.map((row) => row.querySelector(".shell-pin-note")?.textContent ?? "")).toEqual([
    "",
    "2 firing",
    "",
  ]);
  expect(rows[1]!.querySelector(".shell-pin-led")!.getAttribute("data-tone")).toBe("bad");
  expect(rows[1]!.getAttribute("aria-current")).toBe("page");
  expect(host.querySelector(".shell-pin-keys")!.textContent).toBe("press 1 to 3");
});

test("a digit key opens its pinned page, but not while typing", async () => {
  window.localStorage.setItem(NAVIGATION_PINS_KEY, JSON.stringify(["feed", "alerts"]));
  await mount("openvpn");
  const press = (code: string, init: KeyboardEventInit = {}): void => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
  };
  press("Digit2");
  expect(navigate).toHaveBeenLastCalledWith("alerts");
  // The key is read by its place, so a Persian layout works too.
  press("Digit1", { key: "۱" });
  expect(navigate).toHaveBeenLastCalledWith("feed");
  navigate.mockClear();
  press("Digit3"); // no third pin
  press("Digit1", { metaKey: true }); // a browser shortcut
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  press("Digit1");
  input.remove();
  expect(navigate).not.toHaveBeenCalled();
});
