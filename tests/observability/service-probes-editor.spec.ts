// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ServiceProbesEditor } from "../../ui/observability/service-probes-editor";
import { ConfigEditor } from "../../ui/observability/config-editor";
import { ServiceProbePicker } from "../../ui/observability/service-probe-picker";
import { api, postJson } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const cfg = {
  serviceProbes: {
    timeoutMs: 5000,
    scheduled: { lab: ["contract-1"] },
    targets: {
      existing: {
        kind: "https",
        host: "existing.example.com",
        port: 443,
        path: "/",
        addresses: ["192.0.2.1"],
      },
    },
  },
};
const recordDraft = vi.fn<(value: Record<string, unknown>) => void>();
function Harness() {
  const [value, setValue] = useState<Record<string, unknown>>(structuredClone(cfg));
  return h(ServiceProbesEditor, {
    cfg: value,
    onChange: (next) => {
      recordDraft(next);
      setValue(next);
    },
  });
}
beforeEach(() => {
  recordDraft.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  vi.mocked(postJson).mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function click(text: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
  );
  expect(button, `Button ${text}`).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const labelNode = [...document.querySelectorAll("label")].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  const el = labelNode
    ? document.getElementById(labelNode.htmlFor)
    : document.querySelector(`[aria-label="${label}"]`);
  expect(el, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
test("invalid input stays open, valid add is draft-only, searchable and preserves schedule", async () => {
  await act(async () => root.render(h(Harness)));
  await click("Add service");
  await click("Add to draft");
  expect(document.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  await fill("Service ID", "demo");
  await fill("Hostname", "api.example.com");
  await fill("Allowed IPs or CIDRs", "192.0.2.8,2001:db8::8/128");
  await click("Add to draft");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(recordDraft.mock.lastCall?.[0].serviceProbes).toMatchObject({
    scheduled: cfg.serviceProbes.scheduled,
    targets: { demo: { addresses: ["192.0.2.8", "2001:db8::8/128"] } },
  });
  await fill("Search service probes", "2001:db8");
  expect(host.textContent).toContain("demo");
  expect(host.textContent).not.toContain("existing.example.com");
  expect(postJson).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});
test("stable aliases cannot be renamed, edit and removal affect only the chosen draft target", async () => {
  await act(async () => root.render(h(Harness)));
  await click("Edit service existing");
  const alias = document.querySelector('input[value="existing"]') as HTMLInputElement;
  expect(alias.disabled).toBe(true);
  await fill("Hostname", "changed.example.com");
  await click("Update draft");
  expect(recordDraft.mock.lastCall?.[0].serviceProbes).toMatchObject({
    targets: { existing: { host: "changed.example.com" } },
  });
  await click("Remove service existing");
  await click("Cancel");
  expect(recordDraft.mock.lastCall?.[0].serviceProbes).toMatchObject({
    targets: { existing: expect.anything() },
  });
  await click("Remove service existing");
  await click("Remove from draft");
  expect(recordDraft.mock.lastCall?.[0].serviceProbes).toEqual({
    ...cfg.serviceProbes,
    targets: {},
  });
  expect(postJson).not.toHaveBeenCalled();
});
test("canceling dirty details asks before discarding and leaves the outer draft unchanged", async () => {
  await act(async () => root.render(h(Harness)));
  await click("Add service");
  await fill("Hostname", "unsaved.example.com");
  await click("Cancel");
  expect(document.body.textContent).toContain("Discard the unsaved service details?");
  await click("Continue editing");
  await click("Cancel");
  await click("Discard service details");
  expect(recordDraft).not.toHaveBeenCalled();
});
test("focused editor validates, previews, saves and confirms using only the probe scope", async () => {
  const onClose = vi.fn(),
    onReload = vi.fn();
  vi.mocked(postJson).mockImplementation(async (path) =>
    path === "/api/config?scope=serviceProbes"
      ? { ok: true, config: cfg, pendingId: "p", rollbackMs: 60000 }
      : { ok: true, kept: true, summary: { changed: false } },
  );
  await act(async () =>
    root.render(h(ConfigEditor, { scope: "serviceProbes", initial: cfg, onClose, onReload })),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 370));
  });
  expect(postJson).toHaveBeenCalledWith("/api/config/validate?scope=serviceProbes", cfg);
  await click("Preview diff");
  expect(postJson).toHaveBeenCalledWith("/api/config/preview?scope=serviceProbes", cfg);
  await click("Save probes");
  expect(postJson).toHaveBeenCalledWith("/api/config?scope=serviceProbes", {
    config: cfg,
    rollbackMs: 60000,
  });
  expect(document.body.textContent).toContain("Reverting in");
  expect((host.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  await click("Keep changes");
  expect(postJson).toHaveBeenCalledWith("/api/config/keep", { pendingId: "p" });
  expect(onReload).toHaveBeenCalled();
  await click("Close");
  expect(onClose).toHaveBeenCalledOnce();
});

test("picker reads approvals without SSH inventory and clears removed or non-HTTPS selections", async () => {
  const onChange = vi.fn();
  vi.mocked(api).mockResolvedValue({
    targets: [
      { name: "secure", kind: "https" },
      { name: "dns_only", kind: "dns" },
    ],
  });
  await act(async () =>
    root.render(
      h(ServiceProbePicker, { device: "home", value: "dns_only", onChange, onManage: vi.fn() }),
    ),
  );
  expect(api).toHaveBeenCalledExactlyOnceWith(
    "/api/service-contracts/targets?device=home",
    expect.any(AbortSignal),
  );
  expect(onChange).toHaveBeenCalledWith("");
  expect(postJson).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  vi.mocked(api).mockResolvedValue({ targets: [{ name: "newly_saved", kind: "https" }] });
  onChange.mockClear();
  await act(async () =>
    root.render(
      h(ServiceProbePicker, { device: "home", value: "newly_saved", onChange, onManage: vi.fn() }),
    ),
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Approved service"]')?.hasAttribute("disabled")).toBe(
    false,
  );
});

test("approval lookup errors are not misreported as an empty list and can be retried", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("Connection unavailable"));
  await act(async () =>
    root.render(
      h(ServiceProbePicker, { device: "home", value: "", onChange: vi.fn(), onManage: vi.fn() }),
    ),
  );
  expect(host.textContent).toContain("Connection unavailable");
  expect(host.textContent).not.toContain("No HTTPS services approved yet");
  vi.mocked(api).mockResolvedValue({ targets: [] });
  await click("Retry approvals");
  expect(host.textContent).toContain("No HTTPS services approved yet");
});
