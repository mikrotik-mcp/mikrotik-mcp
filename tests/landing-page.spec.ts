import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import type { HTMLButtonElement, HTMLSelectElement } from "happy-dom";
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
