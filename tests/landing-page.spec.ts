import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import type { HTMLButtonElement, HTMLElement, HTMLSelectElement } from "happy-dom";
import { afterEach, expect, test, vi } from "vite-plus/test";

const root = resolve(import.meta.dirname, "../assets");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const windows: Window[] = [];
const load = (setup?: (window: Window) => void) => {
  const window = new Window({ url: "http://localhost:9199/" });
  windows.push(window);
  setup?.(window);
  window.document.write(html);
  for (const script of window.document.scripts) window.eval(script.textContent ?? "");
  return window;
};
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

test("theme follows the system until overridden and persists a manual choice", () => {
  const media = { matches: true, addEventListener: vi.fn() };
  const window = load((window) => {
    window.matchMedia = vi.fn().mockReturnValue(media);
  });
  const { document } = window;
  const root = document.documentElement;
  const select = document.querySelector<HTMLSelectElement>("#site-theme")!;
  const choose = (value: string) => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  expect(root.dataset.theme).toBe("dark");
  expect(select.value).toBe("system");
  choose("light");
  expect(root.dataset.theme).toBe("light");
  expect(window.localStorage.getItem("mikrotik-site-theme")).toBe("light");
  media.addEventListener.mock.calls[0]![1]();
  expect(root.dataset.theme).toBe("light");
  choose("system");
  expect(root.dataset.theme).toBe("dark");
  media.matches = false;
  media.addEventListener.mock.calls[0]![1]();
  expect(root.dataset.theme).toBe("light");
  choose("dark");
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
    "#151b19",
  );
});

test("saved theme applies in the head; invalid or blocked storage does not break the page", () => {
  const saved = load((window) => window.localStorage.setItem("mikrotik-site-theme", "dark"));
  expect(saved.document.documentElement.dataset.theme).toBe("dark");
  expect(saved.document.querySelector<HTMLSelectElement>("#site-theme")!.value).toBe("dark");
  const invalid = load((window) => window.localStorage.setItem("mikrotik-site-theme", "invalid"));
  expect(invalid.document.documentElement.dataset.themePreference).toBe("system");
  const blocked = load((window) => {
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw new Error("Blocked");
      },
    });
  });
  const select = blocked.document.querySelector<HTMLSelectElement>("#site-theme")!;
  select.value = "dark";
  select.dispatchEvent(new blocked.Event("change", { bubbles: true }));
  expect(blocked.document.documentElement.dataset.theme).toBe("dark");
  expect(html.indexOf("root.dataset.theme =")).toBeLessThan(html.indexOf("<style>"));
});

test("landing page preserves local assets, anchors and meaningful no-script content", () => {
  const { document } = load();
  expect(document.querySelectorAll("h1")).toHaveLength(1);
  expect(document.querySelectorAll("script[src]")).toHaveLength(0);
  expect(document.querySelector("noscript")?.textContent).toContain("overview");
  for (const element of document.querySelectorAll("[src], a[href^='#']")) {
    const src = element.getAttribute("src");
    if (src?.startsWith("./")) expect(existsSync(resolve(root, src))).toBe(true);
    const href = element.getAttribute("href");
    if (href?.startsWith("#")) expect(document.getElementById(href.slice(1))).not.toBeNull();
  }
  for (const option of document.querySelectorAll("#screen-select option")) {
    expect(
      existsSync(resolve(root, `screenshots/web/dashboard-${option.getAttribute("value")}.webp`)),
    ).toBe(true);
  }
  expect(html).toContain("prefers-reduced-motion");
});

test("example and screenshot controls update content without router requests", () => {
  const window = load();
  const { document } = window;
  document.querySelector<HTMLButtonElement>("[data-scenario=plan]")!.click();
  expect(document.getElementById("example-title")!.textContent).toBe("Review before applying");
  expect(document.querySelector("[data-scenario=investigate]")!.getAttribute("aria-pressed")).toBe(
    "false",
  );
  const select = document.querySelector<HTMLSelectElement>("#screen-select")!;
  select.value = "memory";
  select.dispatchEvent(new window.Event("change"));
  expect(document.getElementById("dashboard-image")!.getAttribute("src")).toContain(
    "dashboard-memory.webp",
  );
  expect(document.getElementById("screen-caption")!.textContent).toContain("context");
});

test("both selects share styled controls while retaining native values and accessible labels", () => {
  const window = load();
  const { document } = window;
  expect(document.querySelectorAll(".site-select")).toHaveLength(2);
  for (const select of document.querySelectorAll<HTMLSelectElement>("select")) {
    const trigger = document.getElementById(`${select.id}-control`)!;
    const menu = document.querySelector<HTMLElement>(`#${select.id}-options`)!;
    expect(select.hidden).toBe(true);
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-label")).toBeTruthy();
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(menu.hidden).toBe(true);
    expect(menu.querySelectorAll('[role="option"]')).toHaveLength(select.options.length);
  }
  const gallery = document.querySelector<HTMLButtonElement>("#screen-select-control")!;
  expect(document.querySelector('label[for="screen-select-control"]')).not.toBeNull();
  expect(gallery.getAttribute("aria-describedby")).toBe("gallery-note");
  const theme = document.querySelector<HTMLButtonElement>("#site-theme-control")!;
  theme.focus();
  theme.click();
  expect(theme.getAttribute("aria-expanded")).toBe("true");
  document.querySelector<HTMLElement>("#site-theme-option-2")!.click();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(window.localStorage.getItem("mikrotik-site-theme")).toBe("dark");
  expect(theme.textContent).toBe("Dark");
  expect(document.getElementById("site-theme-option-2")!.getAttribute("data-current")).toBe("true");
  expect(document.activeElement).toBe(theme);
  expect(theme.getAttribute("aria-expanded")).toBe("false");
  gallery.click();
  document.querySelector<HTMLElement>("#screen-select-option-11")!.click();
  expect(gallery.textContent).toBe("Memory");
  expect(document.getElementById("dashboard-image")!.getAttribute("src")).toContain(
    "dashboard-memory.webp",
  );
});

test("select keyboard navigation previews, commits once and lets Escape cancel", () => {
  const window = load();
  const { document } = window;
  const trigger = document.querySelector<HTMLButtonElement>("#site-theme-control")!;
  const select = document.querySelector<HTMLSelectElement>("#site-theme")!;
  const changed = vi.fn();
  select.addEventListener("change", changed);
  const key = (key: string) =>
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  trigger.focus();
  key("ArrowDown");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("site-theme-option-0");
  key("ArrowDown");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("site-theme-option-1");
  expect(select.value).toBe("system");
  key("Escape");
  expect(select.value).toBe("system");
  expect(trigger.hasAttribute("aria-activedescendant")).toBe(false);
  key("End");
  key("Enter");
  expect(select.value).toBe("dark");
  expect(changed).toHaveBeenCalledTimes(1);
  key(" ");
  key("Home");
  key("ArrowUp");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("site-theme-option-0");
  key(" ");
  expect(select.value).toBe("system");
  expect(changed).toHaveBeenCalledTimes(2);
  key("Enter");
  key("Enter");
  expect(changed).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(trigger);
});

test("gallery supports typeahead, long-list navigation and natural Tab dismissal", () => {
  const window = load();
  const { document } = window;
  const trigger = document.querySelector<HTMLButtonElement>("#screen-select-control")!;
  const select = document.querySelector<HTMLSelectElement>("#screen-select")!;
  const key = (key: string) =>
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  trigger.focus();
  key("m");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("screen-select-option-11");
  key("m");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("screen-select-option-15");
  key("e");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("screen-select-option-11");
  expect(key("Tab")).toBe(true);
  expect(select.value).toBe("memory");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  key("Home");
  key("PageDown");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("screen-select-option-10");
  key("PageUp");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("screen-select-option-0");
  key("End");
  key("ArrowDown");
  expect(trigger.getAttribute("aria-activedescendant")).toBe("screen-select-option-16");
  key("Escape");
  expect(select.value).toBe("memory");
});

test("select menus close on outside interaction, focus loss and viewport resize", () => {
  const window = load();
  const { document } = window;
  const theme = document.querySelector<HTMLButtonElement>("#site-theme-control")!;
  const gallery = document.querySelector<HTMLButtonElement>("#screen-select-control")!;
  theme.focus();
  theme.click();
  gallery.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
  gallery.focus();
  gallery.click();
  expect(theme.getAttribute("aria-expanded")).toBe("false");
  expect(gallery.getAttribute("aria-expanded")).toBe("true");
  theme.focus();
  expect(gallery.getAttribute("aria-expanded")).toBe("false");
  theme.click();
  window.dispatchEvent(new window.Event("resize"));
  expect(theme.getAttribute("aria-expanded")).toBe("false");
  theme.click();
  theme.click();
  expect(theme.getAttribute("aria-expanded")).toBe("false");
});

test("long select menus fit the available viewport and keep the active option visible", () => {
  const window = load();
  const { document } = window;
  const trigger = document.querySelector<HTMLButtonElement>("#screen-select-control")!;
  const menu = document.querySelector<HTMLElement>("#screen-select-options")!;
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    top: 600,
    bottom: 642,
  } as ReturnType<typeof trigger.getBoundingClientRect>);
  Object.defineProperty(menu, "scrollHeight", { value: 680 });
  Object.defineProperty(menu, "clientHeight", { value: 320 });
  const last = document.getElementById("screen-select-option-16")!;
  Object.defineProperty(last, "offsetTop", { value: 640 });
  Object.defineProperty(last, "offsetHeight", { value: 38 });
  trigger.click();
  expect(menu.dataset.side).toBe("above");
  expect(menu.style.getPropertyValue("--select-space")).toBe("584px");
  trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End" }));
  expect(menu.scrollTop).toBe(358);
  trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home" }));
  expect(menu.scrollTop).toBe(0);
});

test("native fallback is present before scripts and options never become executable markup", () => {
  const window = new Window();
  windows.push(window);
  window.document.write(html);
  for (const select of window.document.querySelectorAll<HTMLSelectElement>("select")) {
    expect(select.hidden).toBe(false);
  }
  const option = window.document.querySelector("#screen-select option")!;
  option.textContent = '<img src=x onerror="window.injected=true">';
  for (const script of window.document.scripts) window.eval(script.textContent ?? "");
  const item = window.document.getElementById("screen-select-option-0")!;
  expect(item.textContent).toBe(option.textContent);
  expect(item.querySelector("img")).toBeNull();
});

test("install switch copies the selected command and recovers from clipboard denial", async () => {
  const window = load();
  const { document } = window;
  let copied = "";
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  document.querySelector<HTMLButtonElement>("[data-install=docker]")!.click();
  const button = document.querySelector<HTMLButtonElement>("#copy-command")!;
  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(copied).toBe("docker pull alimaster/mikrotik-mcp:latest");
  expect(document.getElementById("copy-status")!.textContent).toBe("Command copied.");
  Object.defineProperty(window.navigator, "clipboard", {
    value: {
      writeText: async () => {
        throw new Error("Denied");
      },
    },
  });
  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(document.getElementById("copy-status")!.textContent).toContain("copy it manually");
  expect(button.disabled).toBe(false);
});
