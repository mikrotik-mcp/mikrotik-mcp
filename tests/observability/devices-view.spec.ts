// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import { DevicesView } from "../../ui/observability/devices-view";
import { DeviceResources } from "../../ui/observability/health";
import { DeviceAddressStatus } from "../../ui/observability/device-address-status";
import { ConfigEditor } from "../../ui/observability/config-editor";
import type { DeviceInfo, DevicesPayload, SSHPoolPayload } from "../../ui/observability/types";

vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
// Isolate the management-path drawing from table interactions.
vi.mock("../../ui/observability/connectivity", () => ({
  ManagementPaths: ({ devices }: { devices: DeviceInfo[] }) =>
    h("div", { "data-testid": "paths" }, devices.map((d) => d.name).join(",")),
  PathLegend: () => null,
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
const acceptDeviceForm = async () => {
  const formButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  await click(formButton("Continue"));
  await click(formButton("Continue"));
  await click(formButton("Add to draft"));
};
const filter = async (name: string) =>
  click(
    [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Show"] button')].find((b) =>
      b.textContent?.startsWith(name),
    )!,
  );
const rows = () => [...host.querySelectorAll<HTMLElement>('.dv-routers [role="button"].dv-cols')];
const names = () => rows().map((el) => el.querySelector(".dv-name")?.textContent);
const select = async (name: string) =>
  click(rows().find((r) => r.querySelector(".dv-name")?.textContent === name)!);
const details = (name: string) =>
  host.querySelector<HTMLElement>(`[role="region"][aria-label="Router details: ${name}"]`);

test("address status separates active fallback, historical success, failures and untested addresses", async () => {
  await act(async () =>
    root.render(
      h(DeviceAddressStatus, {
        endpoints: {
          primary: "10.0.0.1",
          hosts: ["10.0.0.1", "203.0.113.1", "2001:db8::1", "192.0.2.9"],
          connected: [{ host: "203.0.113.1", port: 22, transport: "ssh" }],
          observations: [
            { host: "10.0.0.1", port: 22, transport: "ssh", checkedAt: 1000, error: "timed out" },
            { host: "2001:db8::1", port: 22, transport: "ssh", checkedAt: 1000 },
          ],
        },
      }),
    ),
  );
  expect(
    [...host.querySelectorAll("[data-state]")].map((r) => r.getAttribute("data-state")),
  ).toEqual(["failed", "connected", "verified", "untested"]);
  expect(host.textContent).toContain("Primary");
  expect(host.textContent).toContain("Last success");
  expect(host.textContent).toContain("timed out");
});

test("address status refresh shows preference separately from live sessions, clears expired preference and exposes transport failures", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const endpoints = {
    primary: "10.0.0.1",
    hosts: ["10.0.0.1", "203.0.113.1"],
    connected: [{ host: "203.0.113.1", port: 22, transport: "ssh" as const }],
    observations: [
      { host: "203.0.113.1", port: 22, transport: "ssh" as const, checkedAt: 1000 },
      {
        host: "203.0.113.1",
        port: 443,
        transport: "rest" as const,
        checkedAt: 1000,
        error: "ECONNREFUSED",
      },
    ],
    remembered: [{ host: "203.0.113.1", port: 22, transport: "ssh" as const, expiresAt: 301000 }],
  };
  try {
    await act(async () => root.render(h(DeviceAddressStatus, { endpoints })));
    expect(host.textContent).toContain("Fast reconnect");
    expect(host.textContent).toContain("Remembered · SSH :22 · 5m 00s left");
    expect(host.textContent).toContain("REST :443 · Last attempt failed");
    expect(host.textContent).toContain("ECONNREFUSED");
    expect(host.querySelector('[data-state="connected"]')).not.toBeNull();
    endpoints.connected = [];
    clock.mockReturnValue(61_000);
    await act(async () => {
      root.render(h(DeviceAddressStatus, { endpoints }));
      vi.advanceTimersByTime(1000);
    });
    expect(host.querySelector('[data-state="connected"]')).toBeNull();
    expect(host.textContent).toContain("Last success");
    expect(host.textContent).toContain("4m 00s left");
    clock.mockReturnValue(301000);
    // Expiry must update even without a new endpoints payload or parent render.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(host.textContent).not.toContain("Remembered");
    expect(host.textContent).not.toContain("Fast reconnect");
    expect(host.textContent).toContain("Primary");
  } finally {
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    clock.mockRestore();
  }
});
const search = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search devices"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const draftConfig = {
  defaultDevice: "edge",
  devices: {
    edge: { host: "192.0.2.1", username: "admin", password: "«redacted»" },
    branch: { host: "192.0.2.2", username: "operator", password: "«redacted»" },
  },
  mcp: { transport: "stdio" },
};
const mockConfigApi = (rollbackMs = 60000) => {
  const calls: { path: string; body: any }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    const result = path.includes("test-device")
      ? { ok: true, status: { reachable: true, latencyMs: 12, identity: "lab" } }
      : path.includes("validate")
        ? { ok: true }
        : path.includes("preview")
          ? { summary: { changed: true, added: 1, removed: 0 }, unified: "+test" }
          : path.includes("keep")
            ? { kept: true }
            : path.includes("rollback")
              ? { rolledBack: true, config: draftConfig }
              : init?.method === "POST"
                ? { ok: true, config: body.config, pendingId: "pending-lab", rollbackMs }
                : path.includes("schema")
                  ? {}
                  : draftConfig;
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
};

test("an expired config confirmation reloads the restored draft using the latest callback", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const calls = mockConfigApi(1000);
  const onReload = vi.fn();
  const latestReload = vi.fn();
  const props = { initial: draftConfig, scope: "devices" as const, onClose: vi.fn() };
  try {
    await act(async () => root.render(h(ConfigEditor, { ...props, onReload })));
    await click(button("Move branch up"));
    await click(button("Save devices"));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(button("Keep changes")).toBeTruthy();
    await act(async () => root.render(h(ConfigEditor, { ...props, onReload: latestReload })));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(host.textContent).toContain("Auto-reverted — changes were not confirmed in time.");
    expect(button("Keep changes")).toBeUndefined();
    expect(latestReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.path === "/api/config?scope=devices")).toHaveLength(1);
    expect(calls.some((c) => c.path === "/api/config" && !c.body)).toBe(true);
    expect(button("Close").disabled).toBe(false);
  } finally {
    await act(async () => root.render(null));
    vi.useRealTimers();
  }
});

test("Devices owns the draft, per-router tests, ordering and safe apply; Config has no router controls or JSON", async () => {
  const calls = mockConfigApi();
  await render();
  await click(button("Manage routers"));
  expect(host.querySelector('[aria-label="Router configuration draft"]')).toBeTruthy();
  await click(button("Test connection to branch"));
  expect(calls.find((c) => c.path.includes("test-device"))?.body.name).toBe("branch");
  expect(host.textContent).toContain("12 ms · lab");
  await click(button("Move branch up"));
  await click(button("Preview diff"));
  expect(
    Object.keys(calls.find((c) => c.path === "/api/config/preview?scope=devices")!.body.devices),
  ).toEqual(["branch", "edge"]);
  await click(button("Close"));
  expect(host.textContent).toContain("Discard this unsaved draft?");
  await click(button("Continue editing"));
  await click(button("Save devices"));
  expect(calls.some((c) => c.path === "/api/config?scope=devices")).toBe(true);
  expect(button("Close").disabled).toBe(true);
  await click(button("Keep changes"));
  expect(host.textContent).toContain("Changes kept.");
  await click(button("Close"));
  expect(host.querySelector('[aria-label="Router configuration draft"]')).toBeNull();

  await act(async () =>
    root.render(h(ConfigEditor, { initial: draftConfig, onClose: vi.fn(), onReload: vi.fn() })),
  );
  expect(host.textContent).toContain("Devices page");
  expect(host.textContent).not.toContain("Add device");
  expect(host.querySelector('[aria-label="Router configuration draft"]')).toBeNull();
  await click(button("JSON"));
  expect(host.querySelector("textarea")?.value).not.toContain('"devices"');
  expect(host.querySelector("textarea")?.value).not.toContain('"defaultDevice"');
});

test("copy, edit and remove stay in the Devices draft until saved", async () => {
  const calls = mockConfigApi();
  await render();
  await click(button("Manage routers"));
  await click(button("Copy branch"));
  await acceptDeviceForm();
  expect(button("Edit settings for branch-copy")).toBeTruthy();
  await click(button("Remove branch-copy"));
  expect(host.textContent).toContain("Remove branch-copy?");
  await click(button("Confirm removing branch-copy"));
  expect(button("Edit settings for branch-copy")).toBeUndefined();
  expect(calls.some((c) => c.path === "/api/config?scope=devices")).toBe(false);
});

test("router inventory lists and counts draft addresses with a stable primary, not live connections", async () => {
  const calls = mockConfigApi();
  const initial = {
    ...draftConfig,
    devices: {
      ...draftConfig.devices,
      edge: { ...draftConfig.devices.edge, port: 2222, fallbackHosts: ["10.0.0.1", "2001:db8::1"] },
      layer2: { mac: "02:00:00:00:00:01", host: "127.0.0.1" },
      unfinished: { host: "", fallbackHosts: [" "] },
      duplicate: { host: "192.0.2.5", fallbackHosts: ["192.0.2.5", "  ", null] },
    },
  };
  await act(async () =>
    root.render(
      h(ConfigEditor, { initial, scope: "devices", onClose: vi.fn(), onReload: vi.fn() }),
    ),
  );
  const count = (name: string) =>
    host.querySelector(`[aria-label^="${name}: "][aria-label$="configured management addresses"]`);
  // The board marks a router's address count only when it is not exactly one.
  expect(count("edge")?.textContent).toBe("3 addresses");
  expect(count("branch")).toBeNull();
  expect(count("layer2")).toBeNull();
  expect(count("unfinished")?.textContent).toBe("0 addresses");
  expect(count("duplicate")).toBeNull();
  const list = (name: string) =>
    host.querySelector(`[aria-label="${name} management addresses"]`)?.textContent;
  expect(list("edge")).toBe("192.0.2.1 (primary), 10.0.0.1, 2001:db8::1");
  expect(list("branch")).toBe("192.0.2.2");
  expect(list("duplicate")).toBe("192.0.2.5");
  expect(list("layer2")).toBe("02:00:00:00:00:01");
  expect(list("unfinished")).toBe("No addresses configured");
  expect(host.textContent).toContain("SSH :2222");

  await click(button("Edit settings for edge"));
  const dialogButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  await click(dialogButton("Add fallback address"));
  const input = document.querySelector<HTMLInputElement>("#f_fallback_3")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "203.0.113.5",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(dialogButton("Continue"));
  await click(dialogButton("Continue"));
  await click(dialogButton("Update draft"));
  expect(count("edge")?.textContent).toBe("4 addresses");
  expect(list("edge")).toBe("192.0.2.1 (primary), 10.0.0.1, 2001:db8::1, 203.0.113.5");
  await click(button("Edit settings for edge"));
  const makePrimary = document.querySelector<HTMLButtonElement>(
    '[aria-label="Make 2001:db8::1 primary"]',
  );
  expect(makePrimary).not.toBeNull();
  await click(makePrimary!);
  await click(dialogButton("Continue"));
  await click(dialogButton("Continue"));
  await click(dialogButton("Update draft"));
  expect(count("edge")?.textContent).toBe("4 addresses");
  expect(list("edge")).toBe("2001:db8::1 (primary), 192.0.2.1, 10.0.0.1, 203.0.113.5");
  expect(initial.devices.edge.fallbackHosts).toHaveLength(2);
  expect(
    calls.some((c) => c.path.includes("test-device") || c.path === "/api/config?scope=devices"),
  ).toBe(false);
});

test("an unavailable settings API displays a retry, not an empty configuration", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ error: "Settings unavailable" }), { status: 503 }),
  );
  await render();
  await click(button("Manage routers"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Settings unavailable");
  expect(host.querySelector('[aria-label="Router configuration draft"]')).toBeNull();
  mockConfigApi();
  await click(button("Retry settings"));
  expect(host.querySelector('[aria-label="Router configuration draft"]')).toBeTruthy();
});

test.each(["Add device", "Edit edge"])(
  "%s opens only the modal and cancellation leaves management closed",
  async (action) => {
    const calls = mockConfigApi();
    await render();
    await click(button(action));
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Manage routers"]')).toBeNull();
    expect(host.querySelector('[aria-label="Router configuration draft"]')).toBeNull();
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === "Cancel",
    )!;
    await click(cancel);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-label="Manage routers"]')).toBeNull();
    expect(button("Add device").disabled).toBe(false);
    expect(button("Edit device")).toBeUndefined();
    await click(button("Manage routers"));
    await click(button("Preview diff"));
    expect(Object.keys(calls.find((c) => c.path.includes("preview"))!.body.devices)).toEqual([
      "edge",
      "branch",
    ]);
    expect(calls.some((c) => c.path === "/api/config?scope=devices")).toBe(false);
  },
);

test("adding inside an open manager preserves its unsaved order when the modal is cancelled", async () => {
  const calls = mockConfigApi();
  await render();
  await click(button("Manage routers"));
  await click(button("Move branch up"));
  const manager = host.querySelector('[aria-label="Router configuration draft"]')!;
  await click(
    [...manager.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Add device",
    )!,
  );
  expect(host.querySelector('[aria-label="Manage routers"]')).toBeTruthy();
  await click(
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === "Cancel",
    )!,
  );
  expect(host.querySelector('[aria-label="Manage routers"]')).toBeTruthy();
  await click(button("Preview diff"));
  expect(Object.keys(calls.find((c) => c.path.includes("preview"))!.body.devices)).toEqual([
    "branch",
    "edge",
  ]);
  expect(calls.some((c) => c.path === "/api/config?scope=devices")).toBe(false);
});

test("the add modal tests without saving, then Connect & Save uses safe apply without a second save click", async () => {
  const calls = mockConfigApi();
  await render();
  await click(button("Add device"));
  const modalButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  const name = document.querySelector<HTMLInputElement>("#dev_name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      name,
      "new-lab",
    );
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Test and Connect & save sit on the review step, as the board draws them.
  await click(modalButton("Continue"));
  await click(modalButton("Continue"));
  await click(modalButton("Test connection"));
  expect(calls.some((c) => c.path === "/api/config?scope=devices")).toBe(false);
  await click(modalButton("Connect & save"));
  expect(calls.filter((c) => c.path.includes("test-device"))).toHaveLength(2);
  const saves = calls.filter((c) => c.path === "/api/config?scope=devices");
  expect(saves).toHaveLength(1);
  expect(saves[0].body.config.devices["new-lab"].host).toBe("192.168.88.1");
  expect(saves[0].body.config.devices.device).toBeUndefined();
  expect(saves[0].body.rollbackMs).toBe(60000);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain("unless you keep it");
  expect(calls.some((c) => c.path.includes("/keep"))).toBe(false);
  await click(button("Keep changes"));
  expect(host.textContent).toContain("Changes kept.");
});

test("new and discovered routers open here without overwriting an existing router or saving", async () => {
  const calls = mockConfigApi();
  await render({ ...payload, devices: [] });
  await click(button("Add device"));
  expect(document.querySelector<HTMLInputElement>("#dev_name")?.value).toBe("device");
  await acceptDeviceForm();
  await click(button("Close"));
  await click(button("Discard draft"));
  await act(async () =>
    root.render(
      h(DevicesView, {
        key: "discovery",
        payload: null,
        pool,
        capabilities: {},
        pulses: {},
        seed: { name: "edge", body: { host: "192.0.2.99", username: "admin" } },
      }),
    ),
  );
  expect(document.querySelector<HTMLInputElement>("#dev_name")?.value).toBe("edge-2");
  await acceptDeviceForm();
  await click(button("Preview diff"));
  const draft = calls.find((c) => c.path === "/api/config/preview?scope=devices")!.body;
  expect(draft.devices.edge.host).toBe("192.0.2.1");
  expect(draft.devices["edge-2"].host).toBe("192.0.2.99");
  expect(calls.some((c) => c.path === "/api/config?scope=devices")).toBe(false);
});

test("reverting an applied draft restores the previous router order", async () => {
  mockConfigApi();
  await render();
  await click(button("Manage routers"));
  await click(button("Move branch up"));
  await click(button("Save devices"));
  expect(button("Close").disabled).toBe(true);
  await click(button("Revert now"));
  expect(host.textContent).toContain("Reverted to the previous config.");
  expect(button("Move edge up").disabled).toBe(true);
  expect(button("Close").disabled).toBe(false);
});

test("renders the routers table without contacting or mutating devices", async () => {
  await render();
  expect(names()).toEqual(["edge", "branch", "pending", "disabled"]);
  // The first router's details are open until the user picks another or closes them.
  expect(details("edge")).not.toBeNull();
  expect(host.querySelector("select")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  await click(button("Close router details"));
  expect(details("edge")).toBeNull();
  await select("branch");
  expect(details("branch")).not.toBeNull();
});
test("a live fallback wins over a failed probe throughout the fleet view", async () => {
  const branch = payload.devices[1]!;
  branch.endpoints = {
    primary: branch.host,
    hosts: [branch.host, "203.0.113.77"],
    connected: [{ host: "203.0.113.77", port: 2222, transport: "ssh" }],
    observations: [],
  };
  await render();
  await filter("Online");
  expect(names()).toEqual(["edge", "branch"]);
  expect(rows()[1]?.querySelector('[data-col="address"]')?.textContent).toContain("203.0.113.77");
  await select("branch");
  expect(details("branch")?.textContent).toContain("Online · connected");
  await filter("Offline");
  expect(names()).toEqual([]);
});
test("filters distinguish offline, unobserved, and disabled devices", async () => {
  await render();
  await filter("Online");
  expect(names()).toEqual(["edge"]);
  await filter("Offline");
  expect(names()).toEqual(["branch"]);
  await filter("Unchecked");
  expect(names()).toEqual(["pending"]);
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
  expect(host.textContent).toContain("No routers match");
  await click(button("Clear filters"));
  expect(names()).toHaveLength(4);
});
test("table filters do not filter the management paths or fleet-wide pool statistics", async () => {
  await render();
  await filter("Offline");
  expect(host.querySelector('[data-testid="paths"]')?.textContent).toBe(
    "edge,branch,pending,disabled",
  );
  const poolMetric = [...host.querySelectorAll(".monitor-metric")].find(
    (m) => m.querySelector(".monitor-metric-label")?.textContent === "SSH pool",
  );
  expect(poolMetric?.querySelector(".monitor-metric-value")?.textContent).toBe("2open");
  expect(host.querySelectorAll(".dv-pool-row")).toHaveLength(4);
});
test("unknown resources are not meters at zero, but a real zero is retained", async () => {
  await render();
  const [edge, branch] = rows();
  expect(edge.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
  expect(branch.querySelectorAll('[role="meter"]')).toHaveLength(0);
  expect(edge.textContent).toContain("<1 ms");
  await select("branch");
  expect(details("branch")?.textContent).toContain("awaiting readings");
});
test("retained readings on an offline or disabled device are explicitly historical", async () => {
  payload.devices[1].status.cpuLoad = 15;
  payload.devices[3].status.cpuLoad = 5;
  await render();
  await select("branch");
  expect(details("branch")?.textContent).toContain("last known, not live");
  await select("disabled");
  expect(details("disabled")?.textContent).toContain("last known, not live");
});
test("distinguishes not loaded, empty fleet, and unavailable pool", async () => {
  await render(null);
  expect(host.textContent).toContain("Waiting for device data");
  expect(host.textContent).not.toContain("No routers yet");
  await render({ ...payload, devices: [] });
  expect(host.textContent).toContain("No routers yet");
  pool = null;
  await render();
  expect(host.querySelector(".dv-pool")?.textContent).toContain("Status unavailable");
  expect(host.querySelector(".dv-pool")?.textContent).not.toContain("Pooling off");
  expect(host.textContent).toContain("not reported");
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
  await select("branch");
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
  const card = details("edge")!;
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
  await select("disabled");
  expect(button("Test disabled").disabled).toBe(true);
  expect(button("Reconnect disabled").disabled).toBe(true);
  await click(button("Test disabled"));
  expect(actions.onTest).not.toHaveBeenCalled();
  await select("layer2");
  expect(button("Test layer2")).toBeTruthy();
  expect(button("Reconnect layer2")).toBeUndefined();
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
  const poolText = host.querySelector(".dv-pool")?.textContent;
  for (const label of [
    "Not reported",
    "No connection",
    "Reconnecting",
    "Busy · 2 calls running",
    "Ready · idle",
  ])
    expect(poolText).toContain(label);
  expect(host.querySelectorAll('.dv-pool [role="meter"]')).toHaveLength(0);
});
test("zero free memory and disk space are retained in the resource details", async () => {
  const d = device("full", true);
  d.status.totalMemory = 1024;
  d.status.freeMemory = 0;
  d.status.freeHdd = 0;
  await act(async () => root.render(h(DeviceResources, { d })));
  const titles = [...host.querySelectorAll("[data-detail]")].map((el) =>
    el.getAttribute("data-detail"),
  );
  expect(titles).toContain("1.0 KiB / 1.0 KiB used");
  expect(titles).toContain("0 B / — free");
});
