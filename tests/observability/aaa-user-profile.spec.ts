// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { AaaView } from "../../ui/observability/aaa";
import { api, postJson } from "../../ui/observability/api";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.mock("../../ui/observability/um-reports", () => ({ UmReports: () => null }));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: Root;
let profileMode: "ok" | "empty" | "error" = "ok";
let assignments: Record<string, string>[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  profileMode = "ok";
  assignments = [{ user: "existing", profile: "Monthly" }];
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/devices")
      return { defaultDevice: "home", devices: [{ name: "home" }, { name: "remote" }] };
    if (path.startsWith("/api/aaa/list/um-profiles")) {
      if (profileMode === "error") throw new Error("Device disconnected");
      return {
        available: true,
        rows:
          profileMode === "empty"
            ? []
            : [{ name: "Monthly", validity: "30d", "starts-when": "first-auth" }],
      };
    }
    if (path.startsWith("/api/aaa/list/um-user-profiles"))
      return { available: true, rows: assignments };
    return {
      available: true,
      rows: [
        {
          name: "existing",
          group: "default",
          "shared-users": "2",
          password: "••••••",
          "otp-secret": "••••••",
          comment: "A template",
          "total-download": "1000",
        },
        { name: "existing-copy" },
      ],
    };
  });
  vi.mocked(postJson).mockResolvedValue({
    ok: true,
    message: "User created and profile assigned.",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === label)!;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
};
const open = async () => {
  await act(async () => root.render(h(AaaView)));
  await click(button("Users"));
  await click(button("Add"));
};
const choose = async (label: string, value: string) => {
  await click(host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (el) => el.textContent === value,
    )!,
  );
};
const fill = async (label: string, value: string) => {
  const el = [...host.querySelectorAll("label")].find((node) =>
    node.textContent?.startsWith(label),
  )!;
  const input = (
    el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector("input")
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const fillName = async () => {
  await fill("Name", "alice");
  await fill("Password", "New!234x");
};
test("loads same-router profiles only on add and submits the chosen profile with the user", async () => {
  await open();
  expect(api).toHaveBeenCalledWith(
    "/api/aaa/list/um-profiles?device=home",
    expect.any(AbortSignal),
  );
  await choose("Initial profile", "Monthly");
  expect(host.textContent).toContain("Validity: 30d");
  expect(host.textContent).toContain("Starts on first authentication");
  await fillName();
  await click(button("Create"));
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/aaa/add", {
    device: "home",
    slug: "um-users",
    fields: { name: "alice", password: "New!234x", profile: "Monthly" },
  });
  expect(host.querySelector('[aria-label="Initial profile"]')).toBeNull();
  await click(button("Edit"));
  expect(host.querySelector('[aria-label="Initial profile"]')).toBeNull();
});
test("supports no profile and resets choices when the router changes", async () => {
  await open();
  await choose("Initial profile", "Monthly");
  await choose("Router", "remote");
  expect(host.querySelector('[aria-label="Initial profile"]')).toBeNull();
  profileMode = "empty";
  await click(button("Add"));
  expect(api).toHaveBeenCalledWith(
    "/api/aaa/list/um-profiles?device=remote",
    expect.any(AbortSignal),
  );
  expect(host.textContent).toContain("No profiles yet");
  await fillName();
  await click(button("Create"));
  expect(postJson).toHaveBeenLastCalledWith("/api/aaa/add", {
    device: "remote",
    slug: "um-users",
    fields: { name: "alice", password: "New!234x" },
  });
});
test("shows profile load errors and retries without losing the user draft", async () => {
  profileMode = "error";
  await open();
  await fillName();
  expect(host.textContent).toContain("Device disconnected");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Initial profile"]')!.disabled).toBe(
    true,
  );
  profileMode = "ok";
  await click(button("Retry profiles"));
  await choose("Initial profile", "Monthly");
  await click(button("Create"));
  expect(postJson).toHaveBeenLastCalledWith(
    "/api/aaa/add",
    expect.objectContaining({
      fields: { name: "alice", password: "New!234x", profile: "Monthly" },
    }),
  );
});
test("partial success closes creation and preserves the actionable warning after refreshing users", async () => {
  await open();
  await choose("Initial profile", "Monthly");
  await fillName();
  vi.mocked(postJson).mockResolvedValue({
    ok: false,
    created: true,
    message: "User created; check Assignments, do not recreate.",
  });
  await click(button("Create"));
  expect(host.querySelector('[aria-label="Initial profile"]')).toBeNull();
  expect(host.textContent).toContain("User created; check Assignments, do not recreate.");
  expect(postJson).toHaveBeenCalledTimes(1);
});
