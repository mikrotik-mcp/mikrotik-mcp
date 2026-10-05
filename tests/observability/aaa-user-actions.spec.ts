// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { UserActionRow } from "../../ui/observability/aaa-user-actions";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: Root;
const callbacks = {
  onEdit: vi.fn(),
  onDuplicate: vi.fn(),
  onToggle: vi.fn(),
  onRemove: vi.fn(),
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (busy = false, disabled = false) => {
  await act(async () =>
    root.render(
      h(
        "table",
        null,
        h(
          "tbody",
          null,
          h(UserActionRow, {
            name: "alice",
            busy,
            disabled,
            ...callbacks,
            children: h("td", null, "alice"),
          }),
        ),
      ),
    ),
  );
};
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Actions for alice"]')!;
const open = async (context: boolean) => {
  await act(async () => {
    if (context) {
      host
        .querySelector("tr")!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 120, clientY: 80 }),
        );
    } else {
      trigger().dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
    }
  });
};
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const select = async (label: string) => {
  await act(async () =>
    items()
      .find((el) => el.textContent === label)!
      .click(),
  );
};

test("keeps valid table markup with only one compact, labelled action button", async () => {
  await render();
  expect([...host.querySelector("tbody")!.children].map((el) => el.tagName)).toEqual(["TR"]);
  expect([...host.querySelector("tr")!.children].map((el) => el.tagName)).toEqual(["TD", "TD"]);
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
  expect(items()).toHaveLength(0);
});

test.each([true, false])(
  "shares all actions between context and click menus (context=%s)",
  async (context) => {
    await render();
    await open(context);
    expect(items().map((el) => el.textContent)).toEqual(["Edit", "Duplicate", "Disable", "Remove"]);
    expect(document.querySelector('[role="menu"]')!.textContent).toContain("alice");
    expect(items().at(-1)!.getAttribute("data-variant")).toBe("destructive");
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    await select("Edit");
    expect(callbacks.onEdit).toHaveBeenCalledOnce();
    expect(items()).toHaveLength(0);
    await open(context);
    await select("Duplicate");
    expect(callbacks.onDuplicate).toHaveBeenCalledOnce();
    await open(context);
    await select("Disable");
    expect(callbacks.onToggle).toHaveBeenCalledOnce();
    await open(context);
    await select("Remove");
    expect(callbacks.onRemove).toHaveBeenCalledOnce();
  },
);

test("offers Enable for a disabled user", async () => {
  await render(false, true);
  await open(true);
  expect(items().map((el) => el.textContent)).toContain("Enable");
  expect(items().map((el) => el.textContent)).not.toContain("Disable");
  await select("Enable");
  expect(callbacks.onToggle).toHaveBeenCalledOnce();
});

test("opens with the keyboard and Escape closes without taking any action", async () => {
  await render();
  await act(async () => {
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(items()).toHaveLength(4);
  await act(async () =>
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(items()).toHaveLength(0);
  for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
});

test("busy rows cannot open a context menu and already-open actions become disabled", async () => {
  await render();
  await open(true);
  await render(true);
  expect(trigger().disabled).toBe(true);
  expect(items()).toHaveLength(4);
  for (const item of items()) expect(item.getAttribute("aria-disabled")).toBe("true");
  await select("Remove");
  expect(callbacks.onRemove).not.toHaveBeenCalled();
  await act(async () =>
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await open(true);
  expect(items()).toHaveLength(0);
});
