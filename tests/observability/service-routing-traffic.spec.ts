// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { RoutingTrafficPanel } from "../../ui/observability/service-routing-traffic";
import { RoutingDomainFields } from "../../ui/observability/service-routing-domain-fields";
import { api } from "../../ui/observability/api";
import type { RoutingPolicy } from "../../src/service-routing/model";
import type { RoutingTraffic } from "../../src/service-routing/traffic-model";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn() }));
const p = {
  id: "policy",
  device: "lab",
  family: "ipv4",
  state: "active",
  activeTable: "warp",
  primary: "warp",
} as RoutingPolicy;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
test("shows exact counters and live rate, then a gap rather than fake zeros on failure", async () => {
  const sample: RoutingTraffic = {
    policyId: p.id,
    device: p.device,
    state: "ready",
    at: Date.now(),
    ruleId: "*A",
    table: "warp",
    bytes: "1024",
    packets: "10",
    detail: "Client → service matched traffic",
  };
  vi.mocked(api)
    .mockResolvedValueOnce(sample)
    .mockResolvedValueOnce({ ...sample, at: sample.at + 5000, bytes: "6024", packets: "20" })
    .mockRejectedValue(new Error("Disconnected"));
  await act(async () => root.render(h(RoutingTrafficPanel, { policy: p })));
  expect(host.textContent).toContain("1.0 KiB");
  expect(host.textContent).toContain("Waiting for two live samples");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.textContent).toContain("8.0 kbps");
  expect(host.textContent).toContain("5.9 KiB");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.textContent).toContain("temporarily unavailable");
  expect([...host.querySelectorAll("dd")].map((e) => e.textContent)).toEqual(["—", "—", "—"]);
  expect(host.textContent).toContain("Return/download traffic is excluded");
});
test("drafts and paused panels do not query; an unmounted in-flight read is aborted", async () => {
  await act(async () => root.render(h(RoutingTrafficPanel, { policy: { ...p, state: "draft" } })));
  expect(api).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Counters start after a verified apply");
  await act(async () => root.render(h(RoutingTrafficPanel, { policy: p, paused: true })));
  expect(api).not.toHaveBeenCalled();
  vi.mocked(api).mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(h(RoutingTrafficPanel, { policy: p })));
  const signal = vi.mocked(api).mock.calls[0][1];
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true);
});
test("wildcard field explains apex exclusion and DNS consent without enabling it automatically", async () => {
  const onDnsConfirmed = vi.fn();
  await act(async () =>
    root.render(
      h(RoutingDomainFields, {
        domain: "*.example.com",
        onDomain: vi.fn(),
        dnsConfirmed: false,
        onDnsConfirmed,
        primary: "warp",
      }),
    ),
  );
  expect(host.textContent).toContain("not example.com itself");
  expect(host.textContent).toContain("adlist bypass");
  expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
  await act(async () => (host.querySelector('[role="checkbox"]') as HTMLButtonElement).click());
  expect(onDnsConfirmed).toHaveBeenCalledExactlyOnceWith(true);
});
