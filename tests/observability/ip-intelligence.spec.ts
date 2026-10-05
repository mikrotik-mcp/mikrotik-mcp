// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { IpIntelligenceView } from "../../ui/observability/ip-intelligence";
import { postJson } from "../../ui/observability/api";
import { saveDownload } from "../../ui/observability/workspace-ui";

vi.mock("../../ui/observability/workspace-ui", () => ({ saveDownload: vi.fn() }));

vi.mock("../../ui/observability/api", () => ({
  postJson: vi.fn(),
  withToken: (url: string) => url,
}));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const report = {
  ip: "1.1.1.1",
  public: true,
  version: 4,
  cached: false,
  lookedUpAt: 1000,
  expiresAt: 301000,
  providers: {
    ipquery: {
      status: "ready",
      data: {
        isp: { org: "Example Network", asn: "AS13335" },
        risk: { is_vpn: false, risk_score: 0 },
        extra: null,
      },
    },
    ipkit: { status: "error", error: "Provider returned HTTP 429" },
  },
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(postJson).mockResolvedValue(report);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(IpIntelligenceView)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function submit() {
  await act(async () => (host.querySelector(".ipi-examples button") as HTMLButtonElement).click());
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
test("requires explicit submission, preserves every scalar, and displays independent errors", async () => {
  expect(postJson).not.toHaveBeenCalled();
  await submit();
  expect(postJson).toHaveBeenCalledWith("/api/ip-intelligence", { ip: "1.1.1.1" });
  expect(host.textContent).toContain("Example Network");
  expect(host.textContent).toContain("risk.is_vpnfalse");
  expect(host.textContent).toContain("risk.risk_score0");
  expect(host.textContent).toContain("extranull");
  expect(host.textContent).toContain("Provider returned HTTP 429");
  expect(host.querySelectorAll('[data-slot="scroll-area"]')).toHaveLength(2);
  expect(host.textContent).toContain("1 of 2 sources received");
});
test("server errors are actionable, not mistaken for a successful report", async () => {
  vi.mocked(postJson).mockResolvedValue({ error: "Enter a valid IP address" });
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Enter a valid IP address");
  expect(host.querySelector(".ipi-providers")).toBeNull();
});
test("searches all returned fields and copies/exports the complete report", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await submit();
  const input = host.querySelector('[aria-label="Search ipquery fields"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "risk");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const fields = host.querySelector(".ipi-fields")!;
  expect(fields.textContent).toContain("risk.is_vpnfalse");
  expect(fields.textContent).not.toContain("Example Network");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Copy report"))!
      .click(),
  );
  expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(report);
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Export JSON"))!
      .click(),
  );
  expect(saveDownload).toHaveBeenCalledWith(
    "ip-1.1.1.1.json",
    JSON.stringify(report, null, 2),
    "application/json",
  );
  expect(postJson).toHaveBeenCalledTimes(1);
});
test("editing the address discards old metadata, including late responses", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(postJson).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await submit();
  await act(async () => {
    const input = host.querySelector("#ipi-address") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "8.8.8.8",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => finish(report));
  expect(host.textContent).not.toContain("Example Network");
  expect(host.querySelector(".ipi-providers")).toBeNull();
});
test("late requests do not render after leaving the page", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(postJson).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await submit();
  expect(host.textContent).toContain("Gathering two independent perspectives");
  await act(async () => root.render(null));
  await act(async () => finish(report));
  expect(host.textContent).toBe("");
});
