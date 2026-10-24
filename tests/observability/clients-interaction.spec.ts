// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ClientsView } from "../../ui/observability/clients";
import { api, postJson } from "../../ui/observability/api";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({
  api: vi.fn(),
  postJson: vi.fn(),
  withToken: (path: string) => path,
}));

const inventory = {
  __mikrotikView: "connected-devices",
  generatedAt: new Date().toISOString(),
  counts: { total: 2, static: 1, blocked: 1 },
  devices: [
    {
      mac: "02:00:00:00:00:01",
      ip: "192.0.2.10",
      host: "phone",
      iface: "wifi1",
      server: "dhcp1",
      status: "bound",
      static: false,
      blocked: false,
      lastSeen: "1m",
      comment: "",
    },
    {
      mac: "02:00:00:00:00:02",
      ip: "192.0.2.11",
      host: "laptop",
      iface: "bridge",
      server: "dhcp1",
      status: "bound",
      static: true,
      blocked: true,
      lastSeen: "2m",
      comment: "",
    },
  ],
};

class QuietSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", QuietSocket);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/devices")
      return {
        defaultDevice: "fixture",
        server: "fixture",
        devices: [{ name: "fixture", isDefault: true }],
      };
    if (path === "/api/clients" || path === "/api/clients?device=fixture")
      return structuredClone(inventory);
    throw new Error(`Unexpected read: ${path}`);
  });
  vi.mocked(postJson).mockResolvedValue({
    ok: true,
    message: "Applied",
    view: structuredClone(inventory),
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

test("client inventory distinguishes blocked and static leases and filters by address", async () => {
  await act(async () => root.render(createElement(ClientsView)));
  expect(host.textContent).toContain("2 total · 1 static · 1 blocked");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(host.textContent).toContain("laptop");
  expect(host.textContent).toContain("No counter");
  const filter = host.querySelector<HTMLInputElement>(
    'input[placeholder="Filter IP / MAC / name…"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      filter,
      "192.0.2.11",
    );
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(host.textContent).toContain("laptop");
  expect(host.textContent).not.toContain("phone");
  expect(postJson).not.toHaveBeenCalled();
});

test("block action targets only the selected client's MAC and router", async () => {
  await act(async () => root.render(createElement(ClientsView)));
  expect(button("Block")).toBeTruthy();
  await act(async () => button("Block")!.click());
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/clients/block", {
    mac: "02:00:00:00:00:01",
    device: "fixture",
  });
});
