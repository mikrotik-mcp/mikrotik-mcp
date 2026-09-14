// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import { AccessView } from "../../ui/observability/access-view";
import type { AccessSettings } from "../../src/observability/access-settings";

vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
let host: HTMLDivElement;
let root: Root;
let settings: AccessSettings;
let fetchMock: ReturnType<typeof vi.fn>;
const fixture = (): AccessSettings => ({
  revision: "revision-1",
  configured: { enabled: false, devices: [], denyDevices: [], tools: [], denyTools: [] },
  effective: { enabled: false, scope: {} },
  narrowed: false,
  readOnly: false,
  devices: [
    { name: "lab", disabled: false },
    { name: "edge", disabled: false },
  ],
  tools: [
    { name: "get_system_identity", risk: "READ", noDevice: false },
    { name: "run_routeros_command", risk: "WRITE", noDevice: false },
  ],
  denials: [],
  pending: null,
  fromFile: true,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = fixture();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/preview"))
      return Response.json({
        preview: {
          effective: { enabled: body.access.enabled, scope: body.access },
          allowed: 1,
          blocked: 1,
          newlyAllowed: 0,
          newlyBlocked: 1,
          check: { allowed: true },
        },
      });
    if (url.endsWith("/apply")) {
      settings = {
        ...settings,
        configured: body.access,
        effective: { enabled: body.access.enabled, scope: body.access },
        revision: "revision-2",
        pending: { id: "change-1", owned: true, expiresAt: Date.now() + 60000 },
      };
      return Response.json({ ok: true, settings });
    }
    if (url.endsWith("/keep")) {
      settings = { ...settings, pending: null };
      return Response.json({ ok: true, settings });
    }
    if (url.endsWith("/rollback")) {
      settings = fixture();
      return Response.json({ ok: true, settings });
    }
    return Response.json(settings);
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => root.render(h(AccessView)));
};
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
};
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === name,
  )!;
const click = async (el: HTMLElement) => {
  expect(el).toBeTruthy();
  await act(async () => el.click());
};
const writes = () =>
  fetchMock.mock.calls.filter(([url]) => /\/(apply|keep|rollback)$/.test(String(url)));
const changeText = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("loads a configured form, actual BeUI controls, and a read-only decision preview", async () => {
  await render();
  await settle();
  expect(host.textContent).toContain("Access scope off");
  expect(host.textContent).toContain("Within the access boundary");
  expect(host.querySelector("select")).toBeNull();
  expect(host.querySelectorAll('[role="combobox"]').length).toBe(6);
  expect(host.querySelector('[role="switch"]')).toBeTruthy();
  expect(writes()).toHaveLength(0);
});
test("failed loading shows retry guidance instead of a perpetual loading or empty state", async () => {
  fetchMock.mockResolvedValue(Response.json({ error: "Server offline" }, { status: 503 }));
  await render();
  expect(host.textContent).toContain("Server offline");
  expect(host.textContent).toContain("Status unavailable");
  expect(host.textContent).not.toContain("No blocked calls recorded");
  expect(button("Reload saved policy")).toBeTruthy();
});
test("quick risk ceiling preserves tool exclusions and cannot apply without confirmation", async () => {
  settings.configured.denyTools = ["remove_*"];
  await render();
  await settle();
  await click(button("Read only"));
  await settle();
  expect(host.querySelector('[aria-label="Blocked tools rules"]')?.textContent).toContain(
    "remove_*",
  );
  await click(button("Review changes"));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("READ");
  expect(writes()).toHaveLength(0);
  await click(button("Cancel"));
  expect(writes()).toHaveLength(0);
});
test("selected-router mode cannot silently serialize an empty selection as all routers", async () => {
  await render();
  await settle();
  await click(host.querySelector('[aria-label="Allowed router scope"]')!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
      el.textContent?.includes("Only selected routers"),
    )!,
  );
  expect(host.textContent).toContain("Choose at least one allowed router");
  expect(button("Review changes").disabled).toBe(true);
  await click(host.querySelector('[aria-label="Allow lab"]')!);
  await settle();
  expect(host.textContent).not.toContain("Choose at least one allowed router");
  expect(button("Review changes").disabled).toBe(false);
  expect(writes()).toHaveLength(0);
});
test("picks catalog tools and persistent glob rules and shows the exact proposed changes", async () => {
  await render();
  await settle();
  const input = host.querySelector<HTMLInputElement>('[aria-label="Blocked tools"]')!;
  await act(async () => input.focus());
  await changeText(input, "remove_*");
  await click(document.querySelector("[data-combobox-item]")!);
  expect(host.querySelector('[aria-label="Blocked tools rules"]')?.textContent).toContain(
    "remove_*",
  );
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  await changeText(input, "run_routeros");
  await click(document.querySelector("[data-combobox-item]")!);
  await settle();
  await click(button("Review changes"));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "remove_*, run_routeros_command",
  );
  expect(writes()).toHaveLength(0);
});
test("apply starts a pending confirmation, keep is explicit, and only access is sent", async () => {
  await render();
  await settle();
  await click(button("Read only"));
  await settle();
  await click(button("Review changes"));
  await click(button("Apply for 60 seconds"));
  expect(host.textContent).toContain("Your policy is applied, but not yet permanent");
  expect(writes()).toHaveLength(1);
  const body = JSON.parse(writes()[0][1].body);
  expect(Object.keys(body).sort()).toEqual(["access", "revision"]);
  expect(body.access.maxRisk).toBe("READ");
  expect(button("Review changes").disabled).toBe(true);
  await click(button("Keep changes"));
  expect(writes()).toHaveLength(2);
  expect(host.textContent).toContain("Access settings saved");
});
test("existing pending changes survive reload and can be reverted", async () => {
  settings.pending = { id: "change-1", owned: true, expiresAt: Date.now() + 60000 };
  await render();
  expect(host.textContent).toContain("Your policy is applied");
  await click(button("Revert now"));
  expect(host.textContent).toContain("Previous access settings restored");
});
test("session and global read-only restrictions remain visible when the base is off", async () => {
  settings.narrowed = true;
  settings.readOnly = true;
  settings.effective = { enabled: true, scope: { maxRisk: "READ", expiresAt: 2000000000000 } };
  await render();
  expect(host.textContent).toContain("Access enforced");
  expect(host.textContent).toContain("Includes runtime session restrictions");
  expect(host.textContent).toContain("On · writes unavailable");
  expect(host.textContent).toContain("cannot be reset here");
});
