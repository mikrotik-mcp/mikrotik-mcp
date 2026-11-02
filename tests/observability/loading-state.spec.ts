// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
import { LoadingState } from "../../ui/observability/loading-state";

/** Loading previews must never become interactive or masquerade as real router data. */
test.each(["table", "cards", "chart", "form"] as const)(
  "%s skeleton has an accessible status and no interactive sample data",
  async (layout) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(LoadingState, { layout, label: "Loading network" })),
      );
      expect(host.querySelector("[skullet-loading]")).not.toBeNull();
      expect(host.textContent).toContain("Loading network");
      expect(host.querySelector("[aria-hidden=true]")).not.toBeNull();
      expect(host.querySelector("button, input, a, select")).toBeNull();
      await act(async () => root.render(createElement("p", null, "No results")));
      expect(host.querySelector("[skullet-loading]")).toBeNull();
      expect(host.textContent).toBe("No results");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
