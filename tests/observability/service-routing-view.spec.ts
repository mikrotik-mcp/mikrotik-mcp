// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ServiceRoutingView } from "../../ui/observability/service-routing";
import {
  RouterRoutingInventory,
  useRoutingInventory,
} from "../../ui/observability/service-routing-inventory";
import { api, postJson } from "../../ui/observability/api";
import { routingAddressCache } from "../../ui/observability/service-routing-address-browser";
import { routingSections } from "../../src/service-routing/inventory";
import type { RoutingInventory } from "../../src/service-routing/inventory";
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const inventory: RoutingInventory = {
  device: "lab",
  observedAt: Date.now(),
  tables: ["main", "warp"],
  targets: [{ alias: "example", host: "example.com" }],
  sections: Object.fromEntries(
    Object.entries(routingSections).map(([k, path]) => [
      k,
      { path, state: "ready", observedAt: Date.now(), rows: [] },
    ]),
  ) as unknown as RoutingInventory["sections"],
};
inventory.sections.routes4.rows = [
  {
    "#": "0",
    ".id": "*1",
    "dst-address": "0.0.0.0/0",
    "routing-table": "main",
    gateway: "192.0.2.1",
    active: "yes",
    dynamic: "yes",
  },
];
inventory.sections.routes6.rows = [
  {
    "#": "0",
    ".id": "*2",
    "dst-address": "::/0",
    "routing-table": "main",
    gateway: "2001:db8::1",
    active: "yes",
  },
];
inventory.sections.tables.rows = [
  { "#": "0", name: "main", fib: "yes" },
  { "#": "1", name: "warp", fib: "yes" },
];
async function mount() {
  await act(async () => {
    root.render(h(ServiceRoutingView));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
async function policiesTab() {
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("MCP policies ("),
  )!;
  await act(async () => button.click());
}
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
  routingAddressCache.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : path.includes("/inventory?")
        ? structuredClone(inventory)
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
  await mount();
  await policiesTab();
  expect(host.textContent).toContain("Primary exit");
  expect(host.textContent).toContain("untested");
  expect(host.textContent).toContain("Automatic failover paused");
  expect(postJson).not.toHaveBeenCalled();
});

test("saves an explicit domain without a probe and requires consent for a wildcard draft", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : path.startsWith("/api/service-contracts/targets")
        ? { targets: [] }
        : path.includes("/inventory?")
          ? structuredClone(inventory)
          : { policies: [policy] },
  );
  vi.mocked(postJson).mockResolvedValue({ ...policy, target: undefined, host: "*.example.com" });
  await mount();
  await act(async () =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === "New MCP policy")!.click(),
  );
  const fill = async (placeholder: string, value: string) =>
    act(async () => {
      const input = document.querySelector(`input[placeholder="${placeholder}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await fill("Google · household IPv4", "Manual wildcard");
  await fill("api.example.com or *.example.com", "*.example.com");
  await fill("10.10.10.0/24", "10.1.0.0/24");
  const exit = [...document.querySelectorAll("fieldset label")].find((e) =>
    e.textContent?.startsWith("main"),
  )!;
  await act(async () => (exit.querySelector('[role="checkbox"]') as HTMLButtonElement).click());
  const save = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Save draft",
  )!;
  expect(save.disabled).toBe(true);
  const consent = document.querySelector('.route-domain [role="checkbox"]') as HTMLButtonElement;
  await act(async () => consent.click());
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/service-routing?device=lab", {
    name: "Manual wildcard",
    domain: "*.example.com",
    target: undefined,
    dnsLearningConfirmed: true,
    precedence: undefined,
    family: "ipv4",
    sources: ["10.1.0.0/24"],
    tables: ["main"],
    primary: "main",
  });
});

test("managing approvals from the policy form preserves the unsaved policy on return", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : path === "/api/config"
        ? { serviceProbes: { targets: {}, timeoutMs: 5000 } }
        : path.startsWith("/api/service-contracts/targets")
          ? { targets: [] }
          : path.includes("/inventory?")
            ? structuredClone(inventory)
            : { policies: [] },
  );
  vi.mocked(postJson).mockResolvedValue({ ok: true });
  await mount();
  await act(async () =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === "New MCP policy")!.click(),
  );
  const input = document.querySelector('input[placeholder="Google · household IPv4"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "My unsaved policy",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Manage service probes"))!
      .click(),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Manage service probes");
  await act(async () =>
    [...document.querySelectorAll('[role="dialog"] button')]
      .find((b) => b.textContent === "Close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(
    (document.querySelector('input[placeholder="Google · household IPv4"]') as HTMLInputElement)
      .value,
  ).toBe("My unsaved policy");
  expect(vi.mocked(postJson).mock.calls.every(([path]) => path.includes("/validate"))).toBe(true);
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
      : path.includes("/inventory?")
        ? structuredClone(inventory)
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
  await mount();
  await policiesTab();
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

test("opens real IPv4 and IPv6 routes by default without requiring a saved policy or writing", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : path.includes("/inventory?")
        ? structuredClone(inventory)
        : { policies: [] },
  );
  await mount();
  expect(host.textContent).toContain("0.0.0.0/0");
  expect(host.textContent).toContain("::/0");
  expect(host.textContent).toContain("192.0.2.1");
  expect(host.textContent).toContain("Dynamic");
  expect(host.textContent).toContain("MCP policies (0)");
  expect(postJson).not.toHaveBeenCalled();
});

test("does not turn a failed IPv6 read into no routes, and retains IPv4", async () => {
  const partial = structuredClone(inventory);
  partial.sections.routes6 = {
    ...partial.sections.routes6,
    rows: [],
    state: "error",
    error: "Router read timed out",
  };
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : path.includes("/inventory?")
        ? partial
        : { policies: [] },
  );
  await mount();
  expect(host.textContent).toContain("1 sections could not be read");
  expect(host.textContent).toContain("Router read timed out");
  expect(host.textContent).toContain("192.0.2.1");
});

test("inspect shows rule fields without sending a mutation", async () => {
  await mount();
  const inspect = host.querySelector('button[aria-label="Inspect 0.0.0.0/0"]') as HTMLButtonElement;
  await act(async () => inspect.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("/ip route");
  expect(dialog?.textContent).toContain("192.0.2.1");
  expect(postJson).not.toHaveBeenCalled();
});

test("route gateway badges preserve raw scoped values in search and inspection", async () => {
  const data = structuredClone(inventory);
  data.sections.routes4.rows[0]["immediate-gw"] = "45.87.6.145%ether1";
  await act(async () =>
    root.render(h(RouterRoutingInventory, { data, loading: false, error: "", onRetry: vi.fn() })),
  );
  const gateway = host.querySelector(".routing-gateway__member");
  expect(gateway?.querySelector("code")?.textContent).toBe("45.87.6.145");
  expect(gateway?.querySelector(".routing-gateway__interface")?.textContent).toBe("ether1");
  const input = host.querySelector('input[aria-label="Search router routing"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "45.87.6.145%ether1",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("1 matching entries");
  await act(async () =>
    (host.querySelector('button[aria-label="Inspect 0.0.0.0/0"]') as HTMLButtonElement).click(),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("45.87.6.145%ether1");
  expect(data.sections.routes4.rows[0]["immediate-gw"]).toBe("45.87.6.145%ether1");
  expect(postJson).not.toHaveBeenCalled();
});

test("address explorer reads every page without writes and survives inventory refresh", async () => {
  const data = structuredClone(inventory);
  vi.mocked(api).mockImplementation(async (path) => ({
    device: "lab",
    family: path.includes("family=ipv6") ? "ipv6" : "ipv4",
    offset: 0,
    total: path.includes("family=ipv6") ? 0 : 2,
    rows: path.includes("family=ipv6")
      ? []
      : [
          { ".id": "*a", list: "services", address: "192.0.2.5" },
          { ".id": "*b", list: "services", address: "192.0.2.6" },
        ],
  }));
  const retry = vi.fn();
  await act(async () =>
    root.render(h(RouterRoutingInventory, { data, loading: false, error: "", onRetry: retry })),
  );
  const tab = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Address lists"),
  )!;
  await act(async () => tab.click());
  expect(api).toHaveBeenCalledWith(
    "/api/service-routing/addresses?device=lab&family=ipv4&offset=0",
    expect.any(AbortSignal),
  );
  expect(host.textContent).toContain("2 entries indexed");
  expect(host.textContent).toContain("192.0.2.6");
  await act(async () =>
    root.render(
      h(RouterRoutingInventory, {
        data: { ...data, observedAt: Date.now() + 1000 },
        loading: false,
        error: "",
        onRetry: retry,
      }),
    ),
  );
  expect(host.textContent).toContain("2 entries indexed");
  expect(api).toHaveBeenCalledTimes(2);
  expect(postJson).not.toHaveBeenCalled();
});

test("late responses from the previous router never replace the selected router", async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(api).mockImplementation((path) =>
    path.includes("device=old")
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({ ...inventory, device: "new" }),
  );
  function Harness({ device }: { device: string }) {
    const result = useRoutingInventory(device, false);
    return h("div", null, result.data?.device ?? "waiting");
  }
  await act(async () => root.render(h(Harness, { device: "old" })));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  await act(async () => root.render(h(Harness, { device: "new" })));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(host.textContent).toBe("new");
  await act(async () => resolveOld({ ...inventory, device: "old" }));
  expect(host.textContent).toBe("new");
});
