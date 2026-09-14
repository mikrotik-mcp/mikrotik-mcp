// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import { AccessToolPicker } from "../../ui/observability/access-tool-picker";
import { globMatch } from "../../src/core/tool-pattern";

vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
let host: HTMLDivElement;
let root: Root;
let changed = vi.fn<(values: string[]) => void>();
const tools = [
  ...Array.from({ length: 100 }, (_, n) => ({
    name: `get_tool_${n}`,
    risk: "READ" as const,
    noDevice: false,
  })),
  { name: "remove_wireguard_peer", risk: "DESTRUCTIVE" as const, noDevice: false },
];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  changed = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const mount = async (initial: string[] = [], disabled = false) => {
  function Harness() {
    const [values, setValues] = useState(initial);
    return h(AccessToolPicker, {
      kind: "allow",
      tools,
      values,
      disabled,
      onChange: (next) => {
        changed(next);
        setValues(next);
      },
    });
  }
  await act(async () => root.render(h(Harness)));
};
const input = () => host.querySelector<HTMLInputElement>('[role="combobox"]')!;
const key = async (key: string) => {
  await act(async () =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );
};
const search = async (value: string) => {
  await act(async () => input().focus());
  await key("ArrowDown");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const rows = () => [...document.querySelectorAll<HTMLButtonElement>("[data-combobox-item]")];

test("search scans past the first 80 tools and selection adds a removable exact-name token", async () => {
  await mount();
  await search("");
  expect(rows()).toHaveLength(80);
  await search("remove_wireguard");
  expect(rows()).toHaveLength(1);
  await key("Enter");
  expect(changed).toHaveBeenLastCalledWith(["remove_wireguard_peer"]);
  const remove = host.querySelector<HTMLButtonElement>(
    '[aria-label="Remove remove_wireguard_peer from allowed tools"]',
  )!;
  await act(async () => remove.click());
  expect(changed).toHaveBeenLastCalledWith([]);
});
test("glob searches show only matching tools and store the pattern without expansion", async () => {
  await mount();
  await search("GET_*9");
  expect(rows()).toHaveLength(11);
  expect(
    rows()
      .slice(1)
      .every((row) => /get_tool_\d*9/.test(row.textContent!)),
  ).toBe(true);
  await key("Home");
  await key("Enter");
  expect(changed).toHaveBeenLastCalledWith(["GET_*9"]);
  expect(host.textContent).toContain("10 / 101 tool names");
  expect(globMatch(changed.mock.calls[0][0][0], "get_tool_109")).toBe(true);
});
test("zero-match patterns persist, duplicate matching is case-insensitive, Escape adds nothing", async () => {
  await mount();
  await search("future_*");
  await key("Home");
  await key("Enter");
  expect(changed).toHaveBeenLastCalledWith(["future_*"]);
  await search("FUTURE_*");
  expect(rows()[0].disabled).toBe(true);
  await key("Enter");
  expect(changed).toHaveBeenCalledTimes(1);
  await key("Escape");
  expect(input().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(input());
  expect(host.textContent).toContain("0 / 101 tool names");
});
test("existing rules survive absent catalog entries and remain immutable while locked", async () => {
  await mount(["old_tool", "get_*"], true);
  expect(host.textContent).toContain("old_tool");
  expect(input().disabled).toBe(true);
  for (const button of host.querySelectorAll<HTMLButtonElement>("button"))
    expect(button.disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled();
});
test("does not accept comma-separated or whitespace glob expressions as one rule", async () => {
  await mount();
  await search("get_*, remove_*");
  expect(rows()).toHaveLength(0);
  expect(host.textContent).toContain("Use one pattern at a time");
  await key("Enter");
  expect(changed).not.toHaveBeenCalled();
});
