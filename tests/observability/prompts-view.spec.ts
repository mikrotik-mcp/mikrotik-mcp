// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { PromptsView } from "../../ui/observability/prompts";
import { api } from "../../ui/observability/api";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn() }));
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

test("required inputs gate copying, preview escapes markup, and refresh failure preserves the draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockResolvedValue({
    prompts: [
      {
        name: "diagnose",
        title: "Diagnose",
        description: "Find a cause",
        arguments: [{ name: "target", required: true }],
        body: "Check {{target}}",
      },
    ],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((el) => el.textContent === label)!;
  try {
    await act(async () => root.render(h(PromptsView)));
    expect(button("Copy request").disabled).toBe(true);
    const input = host.querySelector<HTMLInputElement>('[aria-label="target"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "<script>example</script>",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Copy request").disabled).toBe(false);
    await act(async () => button("Preview request").click());
    expect(host.querySelector('[aria-label="Request preview"]')?.textContent).toContain(
      "Check <script>example</script>",
    );
    expect(host.querySelector("script")).toBeNull();
    vi.mocked(api).mockRejectedValueOnce(new Error("offline"));
    await act(async () => button("Refresh library").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("offline");
    expect(host.querySelector<HTMLInputElement>('[aria-label="target"]')?.value).toBe(
      "<script>example</script>",
    );
    expect(api).toHaveBeenCalledWith("/api/catalog", expect.any(AbortSignal));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
