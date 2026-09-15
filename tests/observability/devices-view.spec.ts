// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import { DevicesView } from "../../ui/observability/devices-view";
import { DeviceHealthCard } from "../../ui/observability/health";
import type { DeviceInfo, DevicesPayload, SSHPoolPayload } from "../../ui/observability/types";

vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
// The SVG radar is unchanged. Isolate its geometry/RAF from directory interactions.
vi.mock("../../ui/observability/connectivity", () => ({
  ConnectivityGraph: ({ payload }: { payload: DevicesPayload }) =>
    h("div", { "data-testid": "radar" }, payload.devices.map((d) => d.name).join(",")),
  deviceColor: () => "var(--primary)",
}));
let host: HTMLDivElement;
let root: Root;
let payload: DevicesPayload;
let pool: SSHPoolPayload | null;
let actions: {
  onTest: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>;
  onReconnect: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>;
  onToggle: ReturnType<typeof vi.fn<(name: string, disabled: boolean) => void>>;
  onProbeCapabilities: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>;
};
const device = (
  name: string,
  reachable: boolean | null,
  extra: Partial<DeviceInfo> = {},
): DeviceInfo => ({
  name,
  host: "192.0.2.1",
  port: 22,
  username: "operator",
  authMode: "password",
  isDefault: name === "edge",
  status: {
    reachable,
    checkedAt: reachable == null ? null : 1000000,
    latencyMs: reachable === true ? 0 : null,
    cpuLoad: reachable ? 0 : undefined,
  },
  activity: { calls: 0, errors: 0, lastSeen: 0, avgMs: 0 },
  pool: null,
  ...extra,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn());
  payload = {
    server: "lab",
    defaultDevice: "edge",
    devices: [
      device("edge", true),
      device("branch", false),
      device("pending", null),
      device("disabled", null, { disabled: true }),
    ],
  };
  pool = {
    enabled: true,
    config: { keepAlive: true, keepAliveInterval: 10000, idleTimeout: 30000 },
    aggregate: { totalConnections: 2, totalInflight: 3, totalIdle: 1, totalBusy: 1 },
    devices: [],
  };
  actions = {
    onTest: vi.fn(async () => {}),
    onReconnect: vi.fn(async () => {}),
    onToggle: vi.fn(),
    onProbeCapabilities: vi.fn(async () => {}),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (value: DevicesPayload | null = payload) => {
  await act(async () =>
    root.render(h(DevicesView, { payload: value, pool, capabilities: {}, pulses: {}, ...actions })),
  );
};
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  )!;
const click = async (el: HTMLElement) => {
  expect(el).toBeTruthy();
  await act(async () => el.click());
};
const filter = async (name: string) =>
  click(
    [...host.querySelectorAll<HTMLButtonElement>(".device-filters button")].find((b) =>
      b.textContent?.startsWith(name),
    )!,
  );
const names = () => [...host.querySelectorAll(".device-dossier h3")].map((el) => el.textContent);
const search = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search devices"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("renders the actual BeUI controls without contacting or mutating devices", async () => {
  await render();
  expect(names()).toEqual(["edge", "branch", "pending", "disabled"]);
  expect(host.querySelector('[data-slot="button"]')).toBeTruthy();
  expect(host.querySelector("select")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
});
test("filters distinguish offline, unobserved, and disabled devices", async () => {
  await render();
  await filter("Online");
  expect(names()).toEqual(["edge"]);
  await filter("Offline");
  expect(names()).toEqual(["branch"]);
  await filter("Unchecked");
  expect(names()).toEqual(["pending", "disabled"]);
  await filter("Disabled");
  expect(names()).toEqual(["disabled"]);
  await filter("All");
  expect(names()).toHaveLength(4);
});
test("search matches names, addresses and hardware, and can reset an empty result", async () => {
  payload.devices[1].status.boardName = "hAP ax3";
  await render();
  await search(" HAP ");
  expect(names()).toEqual(["branch"]);
  await search("192.0.2.1");
  expect(names()).toHaveLength(4);
  await search("missing");
  expect(names()).toHaveLength(0);
  expect(host.textContent).toContain("No devices match");
  await click(button("Clear filters"));
  expect(names()).toHaveLength(4);
});
test("directory filters do not filter the radar or fleet-wide pool statistics", async () => {
  await render();
  await filter("Offline");
  expect(host.querySelector('[data-testid="radar"]')?.textContent).toBe(
    "edge,branch,pending,disabled",
  );
  expect(host.querySelector(".device-pool__total strong")?.textContent).toBe("2");
  expect(host.querySelectorAll(".device-pool__connections > div")).toHaveLength(4);
});
test("unknown resources are not meters at zero, but a real zero is retained", async () => {
  await render();
  const cards = host.querySelectorAll(".device-dossier");
  expect(cards[0].querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
  expect(cards[1].querySelectorAll('[role="meter"]')).toHaveLength(0);
  expect(cards[1].textContent).toContain("Awaiting readings");
  expect(cards[0].querySelector(".device-activity dd")?.textContent).toBe("<1ms");
});
test("retained readings on an offline or disabled device are explicitly historical", async () => {
  payload.devices[1].status.cpuLoad = 15;
  payload.devices[3].status.cpuLoad = 5;
  await render();
  expect(host.querySelectorAll(".device-dossier")[1].textContent).toContain(
    "Last known · not live",
  );
  expect(host.querySelectorAll(".device-dossier")[3].textContent).toContain(
    "Last known · not live",
  );
});
test("distinguishes not loaded, empty fleet, and unavailable pool", async () => {
  await render(null);
  expect(host.textContent).toContain("Waiting for device data");
  expect(host.textContent).not.toContain("Your fleet starts here");
  await render({ ...payload, devices: [] });
  expect(host.textContent).toContain("Your fleet starts here");
  pool = null;
  await render();
  expect(host.querySelector(".device-pool")?.textContent).toContain("Status unavailable");
  expect(host.querySelector(".device-pool__total strong")?.textContent).toBe("—");
  expect(host.querySelector(".device-pool")?.textContent).not.toContain("Pooling disabled");
});
test("test and reconnect target only the requested device and remain locked while busy", async () => {
  let complete!: () => void;
  actions.onTest.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await click(button("Test branch"));
  expect(actions.onTest).toHaveBeenCalledExactlyOnceWith("branch");
  expect(button("Reconnect branch").disabled).toBe(true);
  await click(button("Reconnect branch"));
  expect(actions.onReconnect).not.toHaveBeenCalled();
  await act(async () => complete());
  await click(button("Reconnect branch"));
  expect(actions.onReconnect).toHaveBeenCalledExactlyOnceWith("branch");
});
test("a rejected action displays an error and unlocks retry", async () => {
  actions.onTest.mockRejectedValue(new Error("timeout"));
  await render();
  await click(button("Test edge"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not test edge");
  expect(button("Test edge").disabled).toBe(false);
});
test("capability probing and enable changes remain explicit and named", async () => {
  await render();
  const card = host.querySelector(".device-dossier")!;
  await click(
    [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Probe")!,
  );
  expect(actions.onProbeCapabilities).toHaveBeenCalledExactlyOnceWith("edge");
  await click(card.querySelector<HTMLElement>('[role="switch"]')!);
  expect(actions.onToggle).toHaveBeenCalledExactlyOnceWith("edge", true);
  expect(actions.onReconnect).not.toHaveBeenCalled();
});
test("disabled devices cannot trigger probes and MAC-Telnet has no SSH reconnect action", async () => {
  payload.devices.push(device("layer2", null, { mac: "02:00:00:00:00:01" }));
  await render();
  expect(button("Test disabled").disabled).toBe(true);
  expect(button("Reconnect disabled").disabled).toBe(true);
  expect(button("Reconnect layer2")).toBeUndefined();
  await click(button("Test disabled"));
  expect(actions.onTest).not.toHaveBeenCalled();
});
test("pool states distinguish unreported, unpooled, recovering, busy and ready", async () => {
  payload.devices = [
    device("unknown", null),
    ...["closed", "dead", "busy", "idle"].map((name) =>
      device(name, true, {
        pool: {
          device: name,
          pooled: name !== "closed",
          dead: name === "dead",
          inflight: name === "busy" ? 2 : 0,
          idle: name === "idle",
        },
      }),
    ),
  ];
  await render();
  const poolText = host.querySelector(".device-pool__connections")?.textContent;
  for (const label of [
    "Not reported",
    "No connection",
    "Reconnecting",
    "2 active channels",
    "Ready · idle",
  ])
    expect(poolText).toContain(label);
  expect(host.querySelectorAll('.device-pool [role="meter"]')).toHaveLength(0);
});
test("zero free memory and disk space are retained in hardware details", async () => {
  const d = device("full", true);
  d.status.totalMemory = 1024;
  d.status.freeMemory = 0;
  d.status.freeHdd = 0;
  await act(async () => root.render(h(DeviceHealthCard, { d, historyOnly: true })));
  expect(host.textContent).toContain("1.0 KiB / 1.0 KiB");
  expect(host.textContent).toContain("0 B / —");
});
