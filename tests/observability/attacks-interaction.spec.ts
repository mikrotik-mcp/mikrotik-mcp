// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { AttacksView } from "../../ui/observability/attacks";
import { api, postJson } from "../../ui/observability/api";
import type { AttacksPayload } from "../../ui/observability/types";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));

const observed = Date.now();
const payload: AttacksPayload = {
  posture: { enabled: true, mode: "detect", autoRespondTo: [], minConfidence: "confirmed" },
  incidents: [
    {
      id: "incident-1",
      source: "198.51.100.7",
      devices: ["edge"],
      stage: "attempt",
      confidence: "confirmed",
      severity: "critical",
      firstTs: observed - 60_000,
      lastTs: observed,
      detectors: ["login-failures"],
      narrative: "Repeated SSH failures",
      recommendations: ["Check authorized operators"],
      evidence: [
        { ts: observed, device: "edge", message: "login failure", detector: "login-failures" },
      ],
      spoofableOnly: false,
      signalCount: 3,
    },
  ],
  responses: [],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
const click = async (target: HTMLButtonElement | undefined) => {
  expect(target).toBeTruthy();
  await act(async () => target!.click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/attacks?hours=168") return structuredClone(payload);
    if (path === "/api/attacks/sources") return { sources: [] };
    if (path === "/api/attacks/devices") return { devices: [{ name: "edge", reachable: true }] };
    if (path === "/api/schedules") return { jobs: [], schedulable: [] };
    throw new Error(`Unexpected dashboard read: ${path}`);
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

test("shows detect-only posture and incident evidence before a response is offered", async () => {
  await act(async () => root.render(createElement(AttacksView)));
  expect(host.textContent).toContain("Detect-only");
  expect(host.textContent).toContain("Repeated SSH failures");
  expect(host.textContent).not.toContain("login failure");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Repeated SSH failures"),
    ),
  );
  expect(host.textContent).toContain("login failure");
  expect(host.textContent).toContain("Check authorized operators");
  expect(postJson).not.toHaveBeenCalled();
});

test("block uses a dry-run plan and requires a second explicit confirmation", async () => {
  vi.mocked(postJson)
    .mockResolvedValueOnce({
      dryRun: true,
      plan: { source: "198.51.100.7", devices: ["edge"], timeout: "1h" },
    })
    .mockResolvedValueOnce({ ok: true });
  await act(async () => root.render(createElement(AttacksView)));
  await click(button("Block…"));
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/attacks/incident-1/respond", {
    confirm: false,
  });
  expect(host.textContent).toContain("Block 198.51.100.7 on edge for 1h?");
  await click(button("Block it"));
  expect(postJson).toHaveBeenNthCalledWith(2, "/api/attacks/incident-1/respond", {
    confirm: true,
  });
  expect(button("Block it")).toBeUndefined();
});

test("cancelling a dry-run never sends the confirmation request", async () => {
  vi.mocked(postJson).mockResolvedValueOnce({
    dryRun: true,
    plan: { source: "198.51.100.7", devices: ["edge"], timeout: "1h" },
  });
  await act(async () => root.render(createElement(AttacksView)));
  await click(button("Block…"));
  await click(button("Cancel"));
  expect(button("Block it")).toBeUndefined();
  expect(postJson).toHaveBeenCalledTimes(1);
});
