// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { FlightRecorderView } from "../../ui/observability/flight-recorder";
import { blankFlight } from "../../src/flight-recorder/model";
import { api, postJson } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
test("empty capture stays paused and settings require an explicit enable action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : { recorder: blankFlight("lab", Date.now()), toolEventsAvailable: false },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(h(FlightRecorderView));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.textContent).toContain("No timeline yet");
    expect(host.textContent).toContain("Recording is paused");
    expect(postJson).not.toHaveBeenCalled();
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Capture settings"))!
        .click();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Raw log messages are not stored",
    );
    expect(postJson).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
