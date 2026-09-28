// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { CapsmanView } from "../../ui/observability/capsman";
import { api, postJson } from "../../ui/observability/api";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: Root;
let enabled: boolean;
let mode: "ok" | "error" | "unsupported";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  enabled = false;
  mode = "ok";
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/devices")
      return { defaultDevice: "home", devices: [{ name: "home" }, { name: "remote" }] };
    if (path.startsWith("/api/capsman/manager?")) {
      if (mode === "error") throw new Error("Device disconnected");
      return {
        device: new URL(path, "http://fixture").searchParams.get("device"),
        managers:
          mode === "unsupported"
            ? []
            : [{ path: "/interface wifi capsman", label: "WiFi CAPsMAN", enabled }],
      };
    }
    if (path.startsWith("/api/capsman/overview"))
      return {
        managerEnabled: enabled,
        radios: [],
        cochannel: [],
        proposedChannels: {},
        bandSplit: { "2ghz": 0, "5ghz": 0 },
        totals: { caps: 0, radios: 0, clients: 0 },
      };
    if (path.startsWith("/api/capsman/clients")) return { weak: [] };
    if (path.startsWith("/api/capsman/audit")) return { findings: [], total: 0 };
    return { series: [] };
  });
  vi.mocked(postJson).mockImplementation(async () => {
    enabled = !enabled;
    return { ok: true };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const open = async () => {
  await act(async () => root.render(h(CapsmanView)));
};
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent === label,
  )!;
const chooseRemote = async () => {
  await click(host.querySelector<HTMLElement>('[aria-label="CAPsMAN router"]')!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (el) => el.textContent === "remote",
    )!,
  );
};
test("scopes all data to the selected router and confirms enable/disable without optimistic status", async () => {
  await open();
  await chooseRemote();
  for (const name of ["manager", "overview", "clients", "audit", "trends"])
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path === `/api/capsman/${name}?device=remote`),
    ).toBe(true);
  await click(button("Enable"));
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("on remote?");
  expect(postJson).not.toHaveBeenCalled();
  await click(button("Cancel"));
  expect(postJson).not.toHaveBeenCalled();
  await click(button("Enable"));
  await click(button("Enable manager"));
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/capsman/manager", {
    device: "remote",
    path: "/interface wifi capsman",
    enabled: true,
    confirm: true,
  });
  expect(button("Disable")).toBeTruthy();
  await click(button("Disable"));
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("may lose access");
  await click(button("Disable manager"));
  expect(vi.mocked(postJson).mock.calls.at(-1)?.[1]).toMatchObject({
    device: "remote",
    enabled: false,
  });
  expect(button("Enable")).toBeTruthy();
});
test.each(["error", "unsupported"] as const)(
  "never offers a toggle for %s settings",
  async (value) => {
    mode = value;
    await open();
    expect(button("Enable")).toBeUndefined();
    expect(button("Disable")).toBeUndefined();
    expect(host.textContent).toContain(value === "error" ? "Device disconnected" : "Not supported");
  },
);
test("locks selection while applying and keeps an uncertain outcome visible until refreshed", async () => {
  await open();
  let finish!: (value: unknown) => void;
  vi.mocked(postJson).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click(button("Enable"));
  await click(button("Enable manager"));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="CAPsMAN router"]')?.disabled).toBe(
    true,
  );
  expect(button("Cancel").disabled).toBe(true);
  await act(async () =>
    finish({ ok: false, error: "Final status unknown. Refresh before trying again." }),
  );
  expect(host.textContent).toContain("Final status unknown");
  expect(button("Enable").disabled).toBe(true);
  expect(postJson).toHaveBeenCalledTimes(1);
  await click(button("Refresh status"));
  expect(button("Enable").disabled).toBe(false);
});
