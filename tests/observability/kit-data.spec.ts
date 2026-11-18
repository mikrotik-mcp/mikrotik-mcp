// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  ChartTipLayer,
  hideTip,
  RowDrawer,
  RowMenu,
  RowMore,
  tipProps,
} from "../../ui/observability/kit";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(async () => ({ devices: [] })) }));
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const menuItems = (): string[] =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
    (el) => el.textContent ?? "",
  );

test("row menu reads the clicked cell and runs its filter", async () => {
  const filter = vi.fn();
  const open = vi.fn();
  await act(async () =>
    root.render(
      h(RowMenu, {
        title: "dashboard_files",
        sub: "23:44 · home-ax3",
        onOpen: open,
        cells: { device: { value: "home-ax3", kind: "router", filter } },
        copies: [{ label: "Call ID", value: "8e388741-4a62" }],
        row: { id: 1 },
        children: h(
          "div",
          { role: "button", tabIndex: 0, className: "row" },
          h("span", { "data-col": "device" }, "home-ax3"),
          h(RowMore),
        ),
      }),
    ),
  );
  const cell = host.querySelector('[data-col="device"]')!;
  await act(async () => {
    cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  });
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("dashboard_files");
  expect(menuItems()).toEqual(
    expect.arrayContaining([
      "Open details↵",
      "Show only home-ax3",
      "Copy “home-ax3”Ctrl C",
      "Copy",
    ]),
  );
  const show = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent === "Show only home-ax3",
  )!;
  await act(async () => show.click());
  expect(filter).toHaveBeenCalledTimes(1);
  expect(host.querySelector('button[aria-label="Actions for dashboard_files"]')).toBeTruthy();
});

test("row drawer: J and K move between rows, Esc closes", async () => {
  const next = vi.fn();
  const prev = vi.fn();
  const close = vi.fn();
  await act(async () =>
    root.render(
      h(RowDrawer, {
        open: true,
        onClose: close,
        label: "Call details: x",
        title: "x",
        nav: { index: 2, total: 9, onNext: next, onPrev: prev },
        tabs: [
          { id: "a", label: "Overview", content: h("p", null, "one") },
          { id: "b", label: "Input", content: h("p", null, "two") },
        ],
      }),
    ),
  );
  const drawer = document.querySelector('[role="dialog"][aria-label="Call details: x"]')!;
  expect(drawer.textContent).toContain("3 of 9");
  expect(drawer.textContent).toContain("one");
  await act(async () =>
    (document.querySelector('[role="tab"]:nth-child(2)') as HTMLElement).click(),
  );
  expect(drawer.textContent).toContain("two");
  const key = (k: string) =>
    act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
    });
  await key("j");
  await key("k");
  await key("Escape");
  expect(next).toHaveBeenCalledTimes(1);
  expect(prev).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test("a chart mark shows the shared tooltip card on hover and focus", async () => {
  const props = tipProps({
    title: "MOM Afranet",
    rows: [{ label: "Memory", value: "91%" }],
    action: { label: "Open router", onClick: () => {} },
  });
  await act(async () =>
    root.render(
      h("div", null, h("span", { ...props, "data-testid": "mark" }, "node"), h(ChartTipLayer)),
    ),
  );
  const mark = host.querySelector('[data-testid="mark"]')!;
  await act(async () => {
    mark.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    (props.onFocus as (e: { currentTarget: Element }) => void)({ currentTarget: mark });
  });
  const tip = document.querySelector('[role="tooltip"].kit-ctip')!;
  expect(tip.textContent).toContain("MOM Afranet");
  expect(tip.textContent).toContain("91%");
  expect(tip.querySelector("button")?.textContent).toBe("Open router");
  await act(async () => hideTip(true));
  expect(document.querySelector(".kit-ctip")).toBeNull();
});
