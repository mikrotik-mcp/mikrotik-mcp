// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { TopologyMap } from "../../ui/observability/topology";
import type { TopologyPayload } from "../../ui/observability/types";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));

const topo: TopologyPayload = {
  server: "fixture-host",
  defaultDevice: "edge",
  generatedAt: 1,
  nodes: [
    {
      id: "edge",
      kind: "device",
      label: "Edge Router",
      configured: true,
      onboardable: false,
      ip: "192.0.2.1",
      reachable: true,
      cpuLoad: 8,
      memUsedPct: 23,
    },
    {
      id: "neighbor-1",
      kind: "neighbor",
      label: "Access Point",
      configured: false,
      onboardable: true,
      ip: "192.0.2.5",
      mac: "02:00:00:00:00:05",
      reachable: false,
      suggestedConfig: { name: "access-point", host: "192.0.2.5", port: 22, username: "admin" },
    },
  ],
  edges: [{ from: "edge", to: "neighbor-1", interface: "ether2" }],
  stats: { devices: 1, neighbors: 1, onboardable: 1 },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOnboard = vi.fn();
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onOnboard.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("topology renders the MCP hub, managed device and discovered neighbor separately", async () => {
  await act(async () => root.render(createElement(TopologyMap, { topo, onOnboard })));
  expect(host.textContent).toContain("fixture-host");
  expect(host.textContent).toContain("1 managed · 1 discovered");
  expect(host.textContent).toContain("1 awaiting onboard");
  expect(host.textContent).toContain("Edge Router");
  expect(host.textContent).toContain("Access Point");
  expect(host.querySelectorAll("svg g.cursor-pointer")).toHaveLength(2);
  expect(onOnboard).not.toHaveBeenCalled();
});

test("inspecting an unmanaged neighbor offers only its scoped configuration stub", async () => {
  await act(async () => root.render(createElement(TopologyMap, { topo, onOnboard })));
  const node = [...host.querySelectorAll("svg g.cursor-pointer")].find((g) =>
    g.textContent?.includes("Access Point"),
  );
  expect(node).toBeTruthy();
  await act(async () => node!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(host.textContent).toContain("Not managed yet");
  expect(host.textContent).toContain("access-point");
  expect(host.textContent).toContain("192.0.2.5");
  await act(async () => button("Add to Devices →")!.click());
  expect(onOnboard).toHaveBeenCalledExactlyOnceWith("access-point", {
    port: 22,
    username: "admin",
    host: "192.0.2.5",
  });
  await act(async () => button("Close")!.click());
  expect(host.textContent).not.toContain("Not managed yet");
});

test("zoom changes the displayed scale and reset restores the initial viewport", async () => {
  await act(async () => root.render(createElement(TopologyMap, { topo })));
  expect(host.textContent).toContain("100%");
  await act(async () => button("Zoom in")!.click());
  expect(host.textContent).toContain("125%");
  await act(async () => button("Reset")!.click());
  expect(host.textContent).toContain("100%");
});
