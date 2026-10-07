// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { OpenVpnHistory } from "../../ui/observability/openvpn-history";
import { api } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), withToken: (s: string) => s }));
vi.mock("../../ui/observability/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: unknown }) => children,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));
vi.mock("recharts", () => ({
  BarChart: () => null,
  Bar: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root?.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
test("history renders coverage and grouped metrics, drills into a user and never requests live sessions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockResolvedValue({
    generatedAt: Date.now(),
    coverage: { first: Date.now() - 86400000, last: Date.now(), gaps: 2, failures: 3 },
    users: ["demo"],
    allTime: 7,
    totals: { connections: 1, users: 1, ips: 1, networks: 1, countries: 1, seconds: 3600 },
    timeline: [],
    ips: [{ label: "1.1.1.1", detail: "Cloudflare", count: 1 }],
    networks: [{ label: "AS13335", detail: "Cloudflare", count: 1 }],
    countries: [{ label: "Australia", detail: "au", count: 1 }],
    sessions: [
      {
        id: "one",
        user: "demo",
        ip: "1.1.1.1",
        tunnel: "10.0.0.1",
        organization: "Cloudflare",
        started: Date.now() - 3600000,
        lastSeen: Date.now(),
        ended: null,
        uptime: 3600,
        uncertain: 1,
      },
    ],
    offset: 0,
    limit: 50,
  });
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(OpenVpnHistory, { device: "home" })));
  expect(host.textContent).toContain("2 collection gaps");
  expect(host.textContent).toContain("Timing / continuity uncertain");
  expect(host.textContent).toContain("AS13335");
  expect(host.querySelectorAll('[data-slot="scroll-area"]').length).toBe(4);
  await act(async () => host.querySelector<HTMLButtonElement>(".ovpn-history-user-link")!.click());
  expect(vi.mocked(api).mock.calls.some(([url]) => url.includes("user=demo"))).toBe(true);
  expect(vi.mocked(api).mock.calls.every(([url]) => url.startsWith("/api/openvpn/history?"))).toBe(
    true,
  );
});
