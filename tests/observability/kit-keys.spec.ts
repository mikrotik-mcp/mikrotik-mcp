// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { RowDrawer, isLetterKey } from "../../ui/observability/kit";

test("a letter shortcut reads the physical key, so any keyboard layout works", () => {
  expect(isLetterKey({ key: "j", code: "KeyJ" }, "j")).toBe(true);
  expect(isLetterKey({ key: "J", code: "KeyJ" }, "j")).toBe(true);
  // The J key on a Persian layout types "ت".
  expect(isLetterKey({ key: "ت", code: "KeyJ" }, "j")).toBe(true);
  expect(isLetterKey({ key: "ن", code: "KeyK" }, "j")).toBe(false);
  // A layout that moves the letter (Dvorak) still works by its own letter.
  expect(isLetterKey({ key: "j", code: "KeyC" }, "j")).toBe(true);
});

test("J and K move between rows of the drawer on a Persian layout", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onNext = vi.fn();
  const onPrev = vi.fn();
  await act(async () =>
    root.render(
      h(RowDrawer, {
        open: true,
        onClose: () => {},
        label: "Call details",
        title: "ping",
        rowKey: "1",
        nav: { index: 1, total: 5, onNext, onPrev },
        tabs: [{ id: "a", label: "A", content: "body" }],
      } as never),
    ),
  );
  const press = (key: string, code: string): void => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));
  };
  press("ت", "KeyJ");
  press("ن", "KeyK");
  press("j", "KeyJ");
  expect(onNext).toHaveBeenCalledTimes(2);
  expect(onPrev).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  host.remove();
});
