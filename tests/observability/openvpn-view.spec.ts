// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { OpenVpnConnections } from "../../ui/observability/openvpn";
import { api, postJson } from "../../ui/observability/api";
import type { OpenVpnSnapshot } from "../../src/core/openvpn-sessions-model";
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({
  api: vi.fn(),
  postJson: vi.fn(),
  withToken: (path: string) => `${path}?token=example`,
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const snapshot: OpenVpnSnapshot = {
  device: "lab",
  observedAt: Date.now(),
  canDisconnect: true,
  sessions: [
    {
      id: "*1",
      name: "ali",
      address: "10.8.0.2",
      callerId: "198.51.100.1",
      sessionId: "0x81",
      encoding: "AES256-GCM",
      radius: true,
      uptime: "1h",
      uptimeSeconds: 3600,
      disconnectToken: "ticket1",
    },
    {
      id: "*2",
      name: "ali",
      address: "10.8.0.3",
      callerId: "198.51.100.2",
      sessionId: "0x82",
      encoding: "AES256-GCM",
      radius: false,
      uptime: "2m",
      uptimeSeconds: 120,
      disconnectToken: "ticket2",
    },
  ],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue(structuredClone(snapshot));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(device = "lab") {
  await act(async () => root.render(h(OpenVpnConnections, { device, key: device })));
}
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
test("shows distinct connections, user count, uptime and filter without mutating", async () => {
  await mount();
  expect(host.querySelectorAll(".ovpn-session")).toHaveLength(2);
  expect(host.textContent).toContain("01:00:00");
  expect(host.textContent).toContain("RADIUS authenticated");
  expect(host.querySelectorAll(".ovpn-summary strong")[1].textContent).toBe("1");
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "10.8.0.3",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll(".ovpn-session")).toHaveLength(1);
  expect(host.textContent).not.toContain("198.51.100.1");
  expect(postJson).not.toHaveBeenCalled();
});
test("requires confirmation and sends only the selected session token, never the username", async () => {
  vi.mocked(postJson).mockResolvedValue({
    status: "disconnected",
    message: "Selected connection ended.",
  });
  await mount();
  await act(async () =>
    (host.querySelector('[aria-label="Disconnect ali session *2"]') as HTMLButtonElement).click(),
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("198.51.100.2");
  expect(dialog.textContent).toContain("management tunnel");
  expect(button("Disconnect connection").disabled).toBe(true);
  expect(postJson).not.toHaveBeenCalled();
  await act(async () => (dialog.querySelector('[role="checkbox"]') as HTMLButtonElement).click());
  await act(async () => button("Disconnect connection").click());
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/openvpn/disconnect?device=lab", {
    token: "ticket2",
    confirm: true,
  });
  expect(host.textContent).toContain("Selected connection ended.");
});
test("cancel does not write and changing router aborts reads and discards previous rows", async () => {
  await mount();
  await act(async () =>
    (host.querySelector('[aria-label="Disconnect ali session *1"]') as HTMLButtonElement).click(),
  );
  await act(async () => button("Cancel").click());
  expect(postJson).not.toHaveBeenCalled();
  const oldSignal = vi.mocked(api).mock.calls[0][1]!;
  vi.mocked(api).mockImplementation(() => new Promise(() => {}));
  await mount("remote");
  expect(oldSignal.aborted).toBe(true);
  expect(host.textContent).not.toContain("ali");
  expect(host.textContent).toContain("Reading active connections");
});
test("expires an open confirmation without sending a disconnect", async () => {
  vi.useFakeTimers();
  await mount();
  await act(async () =>
    (host.querySelector('[aria-label="Disconnect ali session *1"]') as HTMLButtonElement).click(),
  );
  await act(async () =>
    (document.querySelector('[role="dialog"] [role="checkbox"]') as HTMLButtonElement).click(),
  );
  expect(button("Disconnect connection").disabled).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(56000);
  });
  expect(button("Disconnect connection").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("selection expired");
  expect(postJson).not.toHaveBeenCalled();
});
test("unreachable is not zero; read-only disables disconnect", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("Router disconnected"));
  await mount();
  expect(host.textContent).toContain("Connection list unavailable");
  expect(host.textContent).not.toContain("No active OpenVPN");
  expect(host.querySelector(".ovpn-summary strong")?.textContent).toBe("—");
  vi.mocked(api).mockResolvedValue({ ...snapshot, canDisconnect: false });
  await mount("readonly");
  expect((host.querySelector(".ovpn-disconnect") as HTMLButtonElement).disabled).toBe(true);
});
test("polls without overlapping and freezes time with visible stale state on failure", async () => {
  vi.useFakeTimers();
  await mount();
  const calls = vi.mocked(api).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(host.textContent).toContain("01:00:02");
  vi.mocked(api).mockRejectedValue(new Error("Router disconnected"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(api).toHaveBeenCalledTimes(calls + 1);
  expect(host.textContent).toContain("Last known connections · stale");
  expect(host.querySelectorAll(".ovpn-session")).toHaveLength(2);
  expect((host.querySelector(".ovpn-disconnect") as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain("01:00:00");
});

test("shows a same-origin country flag beside the source IP, searches countries and reuses it in the dialog", async () => {
  const data = structuredClone(snapshot);
  data.sessions[0].sourceGeo = { status: "resolved", countryCode: "nl", country: "Netherlands" };
  data.sessions[1].sourceGeo = { status: "private" };
  vi.mocked(api).mockResolvedValue(data);
  await mount();
  const source = host.querySelector(".ovpn-client-source")!;
  expect(source.textContent).toContain("198.51.100.1");
  expect(source.querySelector("img")?.getAttribute("src")).toBe("/api/flag/nl?token=example");
  expect(source.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("Netherlands");
  expect(host.querySelectorAll(".ovpn-country")[1].getAttribute("title")).toContain("Private");
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "netherlands",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll(".ovpn-session")).toHaveLength(1);
  await act(async () => (host.querySelector(".ovpn-disconnect") as HTMLButtonElement).click());
  expect(document.querySelector('[role="dialog"] .ovpn-country img')?.getAttribute("src")).toBe(
    "/api/flag/nl?token=example",
  );
  expect(postJson).not.toHaveBeenCalled();
});

test("country lookup states and a failed flag never hide the IP or imply a country", async () => {
  const data = structuredClone(snapshot);
  data.sessions[0].sourceGeo = { status: "resolved", countryCode: "nl", country: "Netherlands" };
  data.sessions[1].sourceGeo = { status: "pending" };
  vi.mocked(api).mockResolvedValue(data);
  await mount();
  expect(host.querySelectorAll(".ovpn-country")[1].getAttribute("aria-label")).toContain(
    "Looking up",
  );
  await act(async () => host.querySelector(".ovpn-country img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector(".ovpn-country")?.textContent).toBe("NL");
  expect(host.textContent).toContain("198.51.100.1");
  expect(host.textContent).toContain("198.51.100.2");
});
