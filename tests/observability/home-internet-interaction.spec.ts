// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { HomeInternetView } from "../../ui/observability/home-internet";
import { api, postJson } from "../../ui/observability/api";
import type { HomeClient, PolicyPlan } from "../../src/home/model";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));

const client: HomeClient = {
  mac: "02:00:00:00:00:01",
  ip: "192.0.2.10",
  hostname: "phone",
  name: "Family phone",
  person: "Ali",
  firstSeen: 1,
  lastSeen: Date.now(),
  acknowledged: false,
  present: true,
};

const preview: PolicyPlan = {
  id: "preview-1",
  device: "fixture",
  input: { mac: client.mac, action: "pause", minutes: 30, startInMinutes: 0 },
  ip: client.ip,
  createdAt: Date.now(),
  previewExpiresAt: Date.now() + 60_000,
  fingerprint: "fixture",
  commands: ["/ip firewall filter add comment=temporary"],
  undo: ["/ip firewall filter remove *A"],
  warnings: ["Existing sessions can disconnect"],
  status: "preview",
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(label),
  );
const click = async (label: string) => {
  const target = button(label);
  expect(target).toBeTruthy();
  await act(async () => target!.click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/devices")
      return { devices: [{ name: "fixture" }], defaultDevice: "fixture" };
    if (path === "/api/home-internet?device=fixture") return { clients: [client], policies: [] };
    throw new Error(`Unexpected dashboard read: ${path}`);
  });
  vi.mocked(postJson).mockImplementation(async (path) => {
    if (path.startsWith("/api/home-internet/refresh"))
      return {
        clients: [client],
        tables: ["main", "warp"],
      };
    if (path.startsWith("/api/home-internet/preview")) return preview;
    throw new Error(`Unexpected write: ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

test("discovery shows new household devices and available route tables", async () => {
  await act(async () => root.render(createElement(HomeInternetView)));
  expect(host.textContent).toContain("1 new");
  await click("Discover devices & paths");
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/home-internet/refresh?device=fixture", {});
  expect(host.textContent).toContain("DHCP inventory updated");
  await click("Choose a path");
  expect(host.textContent).toContain("warp");
  expect(button("Compare paths")?.disabled).toBe(true);
});

test("temporary policy remains a preview until explicit approval", async () => {
  await act(async () => root.render(createElement(HomeInternetView)));
  await click("Your household");
  expect(host.textContent).toContain("Family phone");
  await click("Manage device");
  await click("Review temporary change");
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/home-internet/preview?device=fixture", {
    mac: client.mac,
    action: "pause",
    minutes: 30,
    startInMinutes: 0,
  });
  expect(host.textContent).toContain("Review before anything changes");
  expect(host.textContent).toContain("Existing sessions can disconnect");
  expect(button("Apply this temporary change")?.disabled).toBe(true);
  await click("Discard preview");
  expect(button("Apply this temporary change")).toBeUndefined();
  expect(postJson).toHaveBeenCalledTimes(1);
});
