// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { AaaView } from "../../ui/observability/aaa";
import { api, postJson } from "../../ui/observability/api";
import { generateUserPassword } from "../../ui/observability/aaa-user-credentials";
import { toast } from "../../ui/observability/toast-action";

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

test("generates exactly eight cryptographically random characters with all four classes", () => {
  const secure = vi.spyOn(crypto, "getRandomValues");
  vi.spyOn(Math, "random").mockImplementation(() => {
    throw new Error("Not a password RNG");
  });
  for (let i = 0; i < 200; i++) {
    const password = generateUserPassword();
    expect(password).toHaveLength(8);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[!@#$%&*+?-]/);
  }
  expect(secure).toHaveBeenCalled();
});

test("toggles password visibility without changing the value and hides it in every new draft", async () => {
  await open();
  await fillName();
  const input = () => host.querySelector<HTMLInputElement>('[autocomplete="new-password"]')!;
  expect(input().type).toBe("password");
  await click(host.querySelector('[aria-label="Show password"]')!);
  expect(input().type).toBe("text");
  expect(input().value).toBe("New!234x");
  expect(host.querySelector('[aria-label="Hide password"]')?.getAttribute("aria-pressed")).toBe(
    "true",
  );
  await click(host.querySelector('[aria-label="Generate 8-character password"]')!);
  const generated = input().value;
  expect(generated).toHaveLength(8);
  await click(host.querySelector('[aria-label="Hide password"]')!);
  expect(input().type).toBe("password");
  expect(input().value).toBe(generated);
  await click(host.querySelector('[aria-label="Show password"]')!);
  await click(button("Cancel"));
  await click(button("Add"));
  expect(input().type).toBe("password");
  expect(input().value).toBe("");
  await click(host.querySelector('[aria-label="Show password"]')!);
  await click(button("Edit"));
  expect(input().type).toBe("password");
  expect(input().value).toBe("");
  await click(host.querySelector('[aria-label="Show password"]')!);
  await click(host.querySelector('[aria-label="Duplicate existing"]')!);
  expect(input().type).toBe("password");
  expect(input().value).toBe("");
  expect(postJson).not.toHaveBeenCalled();
});

test("generates in the input, shows the submitted credentials only after success, copies and clears on close", async () => {
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await open();
  await fillName();
  await click(host.querySelector('[aria-label="Generate 8-character password"]')!);
  const password = host.querySelector<HTMLInputElement>('[autocomplete="new-password"]')!.value;
  expect(password).toHaveLength(8);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await choose("Initial profile", "Monthly");
  await click(button("Create"));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("User created");
  expect(dialog.textContent).toContain("Monthly");
  expect(dialog.textContent).toContain("alice");
  expect(dialog.querySelector('[aria-label="Created user password"]')?.textContent).toBe(password);
  await click(dialog.querySelector('[aria-label="Copy password"]')!);
  expect(copy).toHaveBeenCalledExactlyOnceWith(password);
  expect(dialog.textContent).toContain("Copied!");
  await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Done")!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain(password);
  await click(button("Add"));
  expect(host.querySelector<HTMLInputElement>('[autocomplete="new-password"]')!.value).toBe("");
});

test("keeps failed drafts, but shows credentials with a warning for confirmed creation and uncertain profile", async () => {
  await open();
  await fillName();
  await choose("Initial profile", "Monthly");
  vi.mocked(postJson).mockResolvedValueOnce({ ok: false, message: "User already exists" });
  await click(button("Create"));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[autocomplete="new-password"]')!.value).toBe(
    "New!234x",
  );
  vi.mocked(postJson).mockResolvedValueOnce({
    ok: false,
    created: true,
    message: "Check Assignments; do not recreate the user.",
  });
  await click(button("Create"));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("New!234x");
  expect(dialog.textContent).toContain("Monthly · unconfirmed");
  expect(dialog.textContent).toContain("do not recreate");
  expect(host.querySelector('[autocomplete="new-password"]')).toBeNull();
  expect(postJson).toHaveBeenCalledTimes(2);
});

test("duplicates only editable non-secret settings and the single assigned profile into a new draft", async () => {
  await open();
  await click(button("Cancel"));
  await click(host.querySelector('[aria-label="Duplicate existing"]')!);
  expect(postJson).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Settings copied from existing");
  expect(host.querySelector<HTMLInputElement>('[autocomplete="new-password"]')!.value).toBe("");
  await fill("Password", "Fresh!2x");
  await click(button("Create"));
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/aaa/add", {
    device: "home",
    slug: "um-users",
    fields: {
      name: "existing-copy-2",
      group: "default",
      "shared-users": "2",
      comment: "A template",
      disabled: "no",
      profile: "Monthly",
      password: "Fresh!2x",
    },
  });
});

test("does not silently pick one of multiple profiles or create a passwordless duplicate", async () => {
  assignments.push({ user: "existing", profile: "Other" });
  await open();
  await click(button("Cancel"));
  await click(host.querySelector('[aria-label="Duplicate existing"]')!);
  expect(host.textContent).toContain("multiple profiles");
  await click(button("Create"));
  expect(postJson).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Enter a name and password");
  await fill("Password", "Fresh!2x");
  await click(button("Create"));
  expect(vi.mocked(postJson).mock.calls[0][1]).toMatchObject({
    fields: { name: "existing-copy-2" },
  });
  expect(vi.mocked(postJson).mock.calls[0][1]).not.toHaveProperty("fields.profile");
});

test("reports clipboard denial instead of claiming the password was copied", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Permission denied"));
  await open();
  await fillName();
  await click(button("Create"));
  await click(document.querySelector('[aria-label="Copy password"]')!);
  expect(toast.error).toHaveBeenCalledWith("Couldn't copy. Select the text and copy it manually.");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Copied!");
});

test("ignores an old router's pending duplicate when the selected router changes", async () => {
  await open();
  await click(button("Cancel"));
  const original = vi.mocked(api).getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation((path, abort) => {
    if (path.startsWith("/api/aaa/list/um-user-profiles")) {
      signal = abort;
      return new Promise((done) => {
        resolve = done;
      });
    }
    return original(path, abort);
  });
  await click(host.querySelector('[aria-label="Duplicate existing"]')!);
  await choose("Router", "remote");
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve({ available: true, rows: assignments }));
  await click(button("Users"));
  expect(host.textContent).not.toContain("Settings copied");
  expect(host.querySelector('[autocomplete="new-password"]')).toBeNull();
  expect(postJson).not.toHaveBeenCalled();
});

test("keeps duplicate settings editable when profile lookup fails", async () => {
  await open();
  await click(button("Cancel"));
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, signal) =>
    path.startsWith("/api/aaa/list/um-user-profiles")
      ? Promise.reject(new Error("Device disconnected"))
      : original(path, signal),
  );
  await click(host.querySelector('[aria-label="Duplicate existing"]')!);
  expect(host.textContent).toContain("Profile assignments could not be read");
  expect(button("Create").disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[autocomplete="new-password"]')!.value).toBe("");
});
