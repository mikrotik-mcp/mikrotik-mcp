// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { format } from "date-fns";
import { DateTimePicker } from "../../ui/observability/components/ui/date-time-picker";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const change = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  change.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function open(props: Partial<Parameters<typeof DateTimePicker>[0]> = {}) {
  await act(async () =>
    root.render(
      h(DateTimePicker, {
        "aria-label": "Test date",
        onChange: change,
        value: new Date(2026, 8, 28, 10, 23),
        ...props,
      }),
    ),
  );
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
}
const day = (number: number) =>
  document.querySelector<HTMLButtonElement>(
    `button[data-day="${new Date(2026, 8, number).toLocaleDateString()}"]`,
  )!;

test("date-only selection uses the local day, closes and exposes an accessible trigger", async () => {
  await open({ showTime: false });
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('input[type="time"]')).toBeNull();
  await act(async () => day(29).click());
  expect(format(change.mock.calls[0][0], "yyyy-MM-dd HH:mm")).toBe("2026-09-29 00:00");
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Test date");
});
test("datetime selection preserves hours when changing date, and accepts a local time without mutating input", async () => {
  const value = new Date(2026, 8, 28, 10, 23);
  await open({ value });
  await act(async () => day(29).click());
  expect(format(change.mock.calls[0][0], "yyyy-MM-dd HH:mm")).toBe("2026-09-29 10:23");
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  const input = document.querySelector<HTMLInputElement>('input[type="time"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "18:45");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(format(change.mock.calls.at(-1)![0], "yyyy-MM-dd HH:mm")).toBe("2026-09-28 18:45");
  expect(format(value, "HH:mm")).toBe("10:23");
});
test("calendar min/max bounds include boundary days and clearing removes the value", async () => {
  await open({ showTime: false, min: new Date(2026, 8, 28), max: new Date(2026, 8, 29) });
  expect(day(27).disabled).toBe(true);
  expect(day(28).disabled).toBe(false);
  expect(day(29).disabled).toBe(false);
  expect(day(30).disabled).toBe(true);
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Clear")!
      .click(),
  );
  expect(change).toHaveBeenCalledWith(undefined);
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});
test("empty and disabled pickers do not invent a selected date or open disabled controls", async () => {
  await open({ value: undefined });
  expect(host.textContent).toContain("Pick date & time");
  expect(document.querySelector<HTMLInputElement>('input[type="time"]')?.disabled).toBe(true);
  expect(
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Clear")
      ?.disabled,
  ).toBe(true);
  expect(change).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await open({ disabled: true });
  expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
});
