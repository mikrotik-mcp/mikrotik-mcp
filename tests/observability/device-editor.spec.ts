// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DeviceEditor } from "../../ui/observability/device-editor";
import { mergeConfigDraft } from "../../src/config-write";
import { jumpHostIssue } from "../../ui/observability/device-jump-host";

vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
let host: HTMLDivElement;
let root: Root;
let applied: ReturnType<typeof vi.fn<(cfg: Record<string, unknown>) => void>>;
let saved: ReturnType<typeof vi.fn<(cfg: Record<string, unknown>) => Promise<boolean>>>;
let cancelled: ReturnType<typeof vi.fn<() => void>>;
let calls: { path: string; body: any }[];
const accepted = () =>
  applied.mock.calls[0][0] as {
    defaultDevice?: string;
    devices: Record<string, Record<string, unknown>>;
  };
const redacted = {
  host: "192.0.2.1",
  port: 22,
  username: "admin",
  password: "«redacted»",
  keyFilename: "/keys/old",
  privateKey: "«redacted»",
  keyPassphrase: "«redacted»",
};
const cfg = { devices: { edge: redacted, branch: { host: "192.0.2.2" } }, defaultDevice: "edge" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  applied = vi.fn();
  saved = vi.fn(async () => true);
  cancelled = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json(
        path.includes("ssh-keys")
          ? {
              keys: [
                {
                  path: "/keys/id_ed25519",
                  name: "id_ed25519",
                  type: "ssh-ed25519",
                  fingerprint: "SHA256:abc",
                  publicKey: "ssh-ed25519 public",
                  usable: true,
                },
                {
                  path: "/keys/public-only",
                  name: "public-only",
                  type: "ssh-ed25519",
                  fingerprint: "SHA256:def",
                  publicKey: "ssh-ed25519 public",
                  usable: false,
                },
              ],
            }
          : path.includes("test-device")
            ? { ok: true, status: { reachable: true, identity: "lab", latencyMs: 8 } }
            : { ok: true },
      );
    }),
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
const render = async (config = cfg, isNew = false) =>
  act(async () => {
    root.render(
      h(DeviceEditor, {
        cfg: config,
        name: "edge",
        isNew,
        onApply: applied,
        onSave: saved,
        saveNotice: "Saves device changes with a 60s auto-revert window.",
        onCancel: cancelled,
        advanced: () => null,
      }),
    );
  });
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  )!;
const click = async (label: string) => {
  expect(button(label)).toBeTruthy();
  await act(async () => button(label).click());
};
const input = async (id: string, value: string) => {
  const el = document.querySelector<HTMLInputElement>(`#${id}`)!;
  expect(el).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("jump picker auto-fills a linked router without copying credentials and tests the same draft", async () => {
  await render({
    ...cfg,
    devices: {
      ...cfg.devices,
      branch: {
        host: "192.0.2.2",
        port: 2222,
        username: "ops",
        password: "«redacted»",
        keyFilename: "/keys/bastion",
      },
    },
  } as typeof cfg);
  await click("branch192.0.2.2:2222 · ops");
  expect(document.querySelector<HTMLInputElement>("#jump_host")?.value).toBe("192.0.2.2");
  expect(document.querySelector<HTMLInputElement>("#jump_port")?.value).toBe("2222");
  expect(document.querySelector<HTMLInputElement>("#jump_username")?.value).toBe("ops");
  expect(document.querySelector<HTMLInputElement>("#jump_keyFilename")?.value).toBe(
    "/keys/bastion",
  );
  expect(document.querySelector<HTMLInputElement>("#jump_password")?.value).toBe("");
  expect(document.querySelector<HTMLInputElement>("#jump_host")?.readOnly).toBe(true);
  await click("Test connection");
  const body = calls.find((c) => c.path.includes("test-device"))!.body;
  expect(body.config.jumpVia).toBe("branch");
  expect(body.config.jumpHost).toBeUndefined();
  expect(body.config.keyFilename).toBe("/keys/old");
  expect(body.devices.branch.port).toBe(2222);
  expect(body.devices.branch.password).toBe("«redacted»");
  expect(saved).not.toHaveBeenCalled();
});

test("manual address, configured router and direct modes are exclusive; switching never carries secrets", async () => {
  await render();
  const combo = document.querySelector<HTMLInputElement>(
    '[aria-label="Jump via device or address"]',
  )!;
  await act(async () => combo.focus());
  await input(combo.id, "203.0.113.8");
  await click("Use “203.0.113.8” as a custom address");
  expect(document.querySelector<HTMLInputElement>("#jump_host")?.value).toBe("203.0.113.8");
  expect(document.querySelector<HTMLInputElement>("#jump_host")?.readOnly).toBe(false);
  await input("jump_password", "manual-secret");
  await input("jump_host", "203.0.113.9");
  expect(document.querySelector<HTMLInputElement>("#jump_password")?.value).toBe("");
  await act(async () => combo.click());
  await click("branch192.0.2.2:22 · admin");
  await act(async () => combo.click());
  await click("Enter a custom address…");
  expect(document.querySelector<HTMLInputElement>("#jump_keyFilename")?.value).toBe("");
  await act(async () => combo.click());
  await click("Direct connection · no jump host");
  await click("Test connection");
  const body = calls.find((c) => c.path.includes("test-device"))!.body;
  expect(body.config.jumpVia).toBeUndefined();
  expect(body.config.jumpHost).toBeUndefined();
});

test("jump-host guards reject missing, MAC, disabled and cyclic routers before probing", async () => {
  const devices = {
    edge: redacted,
    loop: { host: "loop", jumpVia: "edge" },
    mac: { mac: "00:11:22:33:44:55" },
    off: { host: "off", disabled: true },
  };
  for (const name of ["edge", "loop", "mac", "off", "missing"])
    expect(jumpHostIssue({ jumpVia: name }, devices, "edge")).not.toBe("");
  await render({
    ...cfg,
    devices: { ...cfg.devices, edge: { ...redacted, jumpVia: "edge" } },
  } as typeof cfg);
  await click("Connect & Save");
  expect(document.body.textContent).toContain("jump-host cycle");
  expect(calls).toHaveLength(0);
  expect(saved).not.toHaveBeenCalled();
});

test("keyboard navigation scrolls the shared jump-host viewport, not its non-scrolling list", async () => {
  await render();
  const combo = document.querySelector<HTMLInputElement>(
    '[aria-label="Jump via device or address"]',
  )!;
  await act(async () => combo.click());
  const list = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Jump hosts"]')!;
  const viewport = list.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const option = button("branch192.0.2.2:22 · admin");
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100 } as DOMRect);
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 500 } as DOMRect);
  vi.spyOn(option, "getBoundingClientRect").mockReturnValue({ top: 200, bottom: 250 } as DOMRect);
  await act(async () => {
    combo.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(viewport.scrollTop).toBe(150);
  expect(list.scrollTop).toBe(0);
});

test("shared scroll areas wrap the form, navigation and key list; step changes reset the form viewport", async () => {
  await render();
  const viewport = document.querySelector<HTMLDivElement>(
    '[data-slot="scroll-area-viewport"][aria-label="Device setup form"]',
  )!;
  expect(viewport).toBeTruthy();
  expect(document.querySelectorAll('[data-slot="scroll-area"]')).toHaveLength(4);
  const scroll = vi.spyOn(viewport, "scrollTo");
  await click("Continue");
  expect(scroll).toHaveBeenCalledWith({ top: 0 });
  expect(document.querySelectorAll('[data-slot="scroll-area"]')).toHaveLength(3);
  const keys = document.querySelector('[aria-label="Available public keys"]')!;
  expect(keys.getAttribute("data-slot")).toBe("scroll-area-viewport");
  expect(keys.contains(button("Use key id_ed25519"))).toBe(true);
  await click("Back");
  expect(scroll).toHaveBeenCalledTimes(2);
});

test("Test connection is available immediately and never applies or saves the draft", async () => {
  await render();
  await click("Test connection");
  expect(document.body.textContent).toContain("Connection verified");
  expect(calls.filter((c) => c.path.includes("test-device"))).toHaveLength(1);
  expect(saved).not.toHaveBeenCalled();
  expect(applied).not.toHaveBeenCalled();
});

test("Connect & Save validates and freshly tests the current draft before saving, including a rename", async () => {
  await render();
  await input("dev_name", "edge-renamed");
  await input("f_host", "192.0.2.9");
  await click("Test connection");
  await click("Connect & Save");
  expect(saved).toHaveBeenCalledOnce();
  expect(calls.filter((c) => c.path.includes("test-device"))).toHaveLength(2);
  expect(calls.at(-2)?.path).toBe("/api/config/validate?scope=devices");
  expect(calls.at(-1)?.body).toEqual({
    name: "edge-renamed",
    config: { ...redacted, host: "192.0.2.9", $credentialsFrom: "edge" },
    devices: saved.mock.calls[0][0].devices,
  });
  expect((saved.mock.calls[0][0].devices as any)["edge-renamed"]).toEqual({
    ...redacted,
    host: "192.0.2.9",
    $credentialsFrom: "edge",
  });
  expect(applied).not.toHaveBeenCalled();
});

test.each([
  { ok: true, status: { reachable: false, error: "SSH authentication failed" } },
  { ok: true },
  { ok: false, error: "Permission denied" },
])("Connect & Save never saves an unsuccessful or unproven connection: %j", async (failure) => {
  await render();
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json(failure));
  await click("Connect & Save");
  expect(saved).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Connection could not be verified");
  expect(button("Connect & Save").disabled).toBe(false);
});

test("failed validation stops Connect & Save before probing, and a failed save retains the form", async () => {
  await render();
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ ok: false, error: "Invalid device settings" }),
  );
  await click("Connect & Save");
  expect(calls.some((c) => c.path.includes("test-device"))).toBe(false);
  expect(saved).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Invalid device settings");
  saved.mockResolvedValue(false);
  await click("Connect & Save");
  expect(saved).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("saving was not confirmed");
  expect(cancelled).not.toHaveBeenCalled();
});

test("a pending connect-and-save locks editing and coalesces repeated actions", async () => {
  await render();
  let finish!: (value: Response) => void;
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const action = button("Connect & Save");
  await act(async () => {
    action.click();
    action.click();
  });
  expect(button("Test connection").disabled).toBe(true);
  expect(button("Connect & Save").disabled).toBe(true);
  expect(button("Close device editor").disabled).toBe(true);
  expect(document.querySelector("fieldset")?.disabled).toBe(true);
  expect(saved).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({ ok: true, status: { reachable: true } })));
  expect(saved).toHaveBeenCalledOnce();
});

test("rename stays local until accepted and preserves redacted credentials through safe draft resolution", async () => {
  await render();
  await input("dev_name", "edge-new");
  expect(applied).not.toHaveBeenCalled();
  await click("Continue");
  await click("Continue");
  await click("Update draft");
  const draft = accepted();
  expect(draft.defaultDevice).toBe("edge-new");
  expect(draft.devices["edge-new"].$credentialsFrom).toBe("edge");
  const resolved = mergeConfigDraft(draft, {
    ...cfg,
    devices: {
      ...cfg.devices,
      edge: {
        ...redacted,
        password: "kept",
        privateKey: "kept-inline",
        keyPassphrase: "kept-passphrase",
      },
    },
  }) as any;
  expect(resolved.devices["edge-new"].password).toBe("kept");
  expect(resolved.devices["edge-new"].privateKey).toBe("kept-inline");
  expect(calls.map((c) => c.path)).not.toContain("/api/config?scope=devices");
});

test("quick selection uses companion path, clears higher-priority inline key and old passphrase, never installs a key", async () => {
  await render();
  await click("Continue");
  expect(button("Use key public-only").disabled).toBe(true);
  await click("Use key id_ed25519");
  expect(document.querySelector<HTMLInputElement>("#f_keyFilename")?.value).toBe(
    "/keys/id_ed25519",
  );
  await click("Continue");
  await click("Test connection");
  const probe = calls.find((c) => c.path.includes("test-device"))!.body;
  expect(probe.config.keyFilename).toBe("/keys/id_ed25519");
  expect(probe.config.privateKey).toBeUndefined();
  expect(probe.config.keyPassphrase).toBeUndefined();
  expect(document.body.textContent).toContain("Connection verified");
  await click("Back");
  await input("f_username", "other");
  await click("Continue");
  expect(document.body.textContent).toContain("Settings changed. Test again");
  expect(document.body.textContent).not.toContain("Connection verified");
  await click("Update draft");
  expect(accepted().devices.edge.keyFilename).toBe("/keys/id_ed25519");
  expect(
    calls.every((c) =>
      [
        "/api/config/ssh-keys",
        "/api/config/validate?scope=devices",
        "/api/config/test-device",
      ].includes(c.path),
    ),
  ).toBe(true);
});

test("invalid names, ports and .pub paths cannot advance; cancellation never accepts changes", async () => {
  await render();
  await input("dev_name", "branch");
  await click("Continue");
  expect(document.body.textContent).toContain("A router with this name already exists.");
  await input("dev_name", "unique");
  await input("f_port", "65536");
  await click("Continue");
  expect(document.body.textContent).toContain("Use a port from 1 to 65535.");
  await input("f_port", "22");
  await click("Continue");
  await click("Use key id_ed25519");
  await input("f_keyFilename", "/keys/id_ed25519.pub");
  await click("Continue");
  expect(document.body.textContent).toContain("Use the private-key path, not the .pub file.");
  await click("Cancel");
  expect(cancelled).not.toHaveBeenCalled();
  await click("Discard form");
  expect(cancelled).toHaveBeenCalledOnce();
  expect(applied).not.toHaveBeenCalled();
});

test("password mode removes key precedence; MAC mode validates a real MAC instead of silently falling back to SSH", async () => {
  await render();
  await click("MAC-Telnet");
  await click("Continue");
  expect(document.body.textContent).toContain("Enter a MAC address such as");
  await click("SSH");
  await click("Continue");
  await click("Password authentication");
  await click("Continue");
  await click("Update draft");
  const device = accepted().devices.edge;
  expect(device.privateKey).toBeUndefined();
  expect(device.keyFilename).toBeUndefined();
  expect(device.keyPassphrase).toBeUndefined();
  expect(device.password).toBe("«redacted»");
});

test("validation failure retains the form and typed settings, and key loading can recover", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "no" }, { status: 503 }));
  await render();
  await click("Continue");
  expect(document.body.textContent).toContain("Could not load public keys");
  await click("Refresh public keys");
  expect(button("Use key id_ed25519")).toBeTruthy();
  await click("Continue");
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json(
      { ok: false, errors: [{ path: "devices.edge", message: "Invalid draft" }] },
      { status: 400 },
    ),
  );
  await click("Update draft");
  expect(document.body.textContent).toContain("Invalid draft");
  expect(applied).not.toHaveBeenCalled();
});
