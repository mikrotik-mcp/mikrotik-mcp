// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ServiceRoutingView } from "../../ui/observability/service-routing";
import { api, postJson } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const policy = {
  id: "p",
  device: "lab",
  name: "Search",
  host: "example.com",
  target: "example",
  family: "ipv4",
  sources: ["10.1.0.0/24"],
  tables: ["main", "warp"],
  primary: "main",
  state: "draft",
  samples: [],
  history: [],
  failuresBeforeSwitch: 3,
  cooldownSeconds: 300,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : { policies: [policy] },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
test("shows the primary and unknown evidence without probing on mount", async () => {
  await act(async () => root.render(h(ServiceRoutingView)));
  expect(host.textContent).toContain("Primary exit");
  expect(host.textContent).toContain("untested");
  expect(host.textContent).toContain("Automatic failover paused");
  expect(postJson).not.toHaveBeenCalled();
});
test("preview opens an explicit confirmation dialog without applying", async () => {
  vi.mocked(postJson).mockResolvedValue({
    ...policy,
    plan: {
      id: "plan",
      commands: ["/ip firewall mangle add"],
      table: "main",
      expiresAt: Date.now() + 120000,
    },
  });
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : {
          policies: [
            {
              ...policy,
              plan: {
                id: "plan",
                commands: ["/ip firewall mangle add"],
                table: "main",
                expiresAt: Date.now() + 120000,
              },
            },
          ],
        },
  );
  await act(async () => root.render(h(ServiceRoutingView)));
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Preview route via main"),
  )!;
  await act(async () => button.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Review routing change");
  const apply = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Apply reviewed change",
  )!;
  expect(apply.disabled).toBe(true);
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/service-routing/preview?device=lab", {
    id: "p",
    table: "main",
    remove: false,
  });
});
