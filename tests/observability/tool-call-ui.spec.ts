// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ToolCallLookup } from "../../ui/observability/tool-call-lookup";
import { DetailDrawer } from "../../ui/observability/detail-drawer";
import { api } from "../../ui/observability/api";
import type { ToolEvent } from "../../ui/observability/types";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({ api: vi.fn() }));
vi.mock("../../ui/observability/sheet", () => ({
  Sheet: ({ children, title }: { children: ReactNode; title: ReactNode }) =>
    h("section", null, title, children),
}));
const event: ToolEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  ts: 1,
  tool: "list_interfaces",
  title: "Interfaces",
  device: "lab",
  risk: "READ",
  durationMs: 12,
  isError: true,
  input: "{}",
  output: "timeout",
  error: "timeout",
  outputBytes: 7,
  hasStructured: false,
  truncated: false,
  bodyCaptured: true,
  logs: [{ offsetMs: 5, level: "error", message: "Connection lost" }],
  logsTruncated: true,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const found = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  found.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Enter the full reference as a user would, without a dependency on the feed buffer. */
async function enter(value: string) {
  const input = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () =>
  act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

test("lookup validates an ID, reads saved history on submit and reports missing evidence", async () => {
  await act(async () => root.render(h(ToolCallLookup, { onFound: found })));
  expect(host.querySelector('input[aria-label="Tool call ID"]')).not.toBeNull();
  await enter("../invalid");
  await submit();
  expect(api).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("complete call ID");
  vi.mocked(api).mockResolvedValue(event);
  await enter(` ${event.id} `);
  await submit();
  expect(api).toHaveBeenCalledWith(`/api/event/${event.id}`, expect.any(AbortSignal));
  expect(found).toHaveBeenCalledWith(event);
  vi.mocked(api).mockRejectedValue(new Error("404"));
  await enter("missing-call");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("not saved");
});

test("leaving the feed cancels a pending lookup and does not reopen an old drawer", async () => {
  let resolve!: (result: ToolEvent) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done as typeof resolve;
      }),
  );
  await act(async () => root.render(h(ToolCallLookup, { onFound: found })));
  await enter(event.id);
  await submit();
  expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  await submit();
  expect(api).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(api).mock.calls[0][1]!;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(event));
  expect(found).not.toHaveBeenCalled();
});

test("drawer shows a copyable full reference, bounded diagnostic evidence and legacy gaps", async () => {
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await act(async () => root.render(h(DetailDrawer, { event, onClose: () => {} })));
  expect(host.textContent).toContain(event.id);
  expect(host.textContent).toContain("Connection lost");
  expect(host.textContent).toContain("Additional diagnostic messages were omitted");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[title="Copy full call ID"]')!.click(),
  );
  expect(copy).toHaveBeenLastCalledWith(event.id);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[title="Copy MCP lookup"]')!.click(),
  );
  expect(copy).toHaveBeenLastCalledWith(`get_tool_call(${JSON.stringify({ call_id: event.id })})`);
  await act(async () =>
    root.render(
      h(DetailDrawer, {
        event: { ...event, logs: undefined, logsTruncated: undefined, bodyCaptured: false },
        onClose: () => {},
      }),
    ),
  );
  expect(host.textContent).toContain("Body capture was disabled");
  expect(host.textContent).toContain("No diagnostic messages saved");
});
