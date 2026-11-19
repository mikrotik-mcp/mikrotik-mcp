// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { DateRangePicker, DateTimePicker } from "../../ui/observability/kit";

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** The popover's wrapper stays at translate(0, -200%), off the screen, until it has an anchor. */
const placed = async (): Promise<boolean> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const wrapper = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
  expect(wrapper).not.toBeNull();
  return !wrapper!.style.transform.includes("-200%");
};

test.each([
  ["DateTimePicker", () => h(DateTimePicker, { label: "From", onChange: () => {} })],
  ["DateRangePicker", () => h(DateRangePicker, { label: "Period", onChange: () => {} } as never)],
])("%s opens its calendar at the button", async (_name, element) => {
  await act(async () => root.render(element()));
  const trigger = host.querySelector<HTMLButtonElement>("button.kit-trigger")!;
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".kit-pop")).not.toBeNull();
  expect(await placed()).toBe(true);
});
