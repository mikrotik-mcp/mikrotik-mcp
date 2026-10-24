// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BackupsView } from "../../ui/observability/backups";
import { api, postJson } from "../../ui/observability/api";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({
  api: vi.fn(),
  postJson: vi.fn(),
  withToken: (path: string) => path,
}));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const data = {
  dir: "/tmp/fixture-backups",
  devices: ["fixture"],
  backups: [{ name: "safe.rsc", bytes: 40, modified: 1_700_000_000_000, device: "fixture" }],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/backups") return structuredClone(data);
    if (path === "/api/backups/get?name=safe.rsc")
      return { name: "safe.rsc", content: "/ip address print" };
    throw new Error(`Unexpected read: ${path}`);
  });
  vi.mocked(postJson).mockResolvedValue({
    ok: true,
    name: "new.rsc",
    bytes: 40,
    applied: 1,
    committed: false,
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

test("vault shows device-scoped host backups and loads body only on request", async () => {
  await act(async () => root.render(createElement(BackupsView)));
  expect(host.textContent).toContain("Local backup vault");
  expect(host.textContent).toContain("safe.rsc");
  expect(host.textContent).toContain("/tmp/fixture-backups");
  expect(api).toHaveBeenCalledWith("/api/backups");
  expect(api).not.toHaveBeenCalledWith("/api/backups/get?name=safe.rsc");
  await act(async () => button("view")!.click());
  expect(host.textContent).toContain("/ip address print");
  expect(postJson).not.toHaveBeenCalled();
});

test("create backup sends explicit safe export options and never defaults to secrets", async () => {
  await act(async () => root.render(createElement(BackupsView)));
  await act(async () => button("Create backup")!.click());
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/backups/create", {
    device: "fixture",
    label: undefined,
    show_sensitive: false,
    verbose: false,
    compact: false,
    terse: false,
  });
  expect(host.textContent).toContain("Created new.rsc");
});

test("restore requires explicit selection and a dry-run keeps confirm=false", async () => {
  await act(async () => root.render(createElement(BackupsView)));
  expect(button("Dry-run")).toBeUndefined();
  await act(async () => button("restore")!.click());
  expect(host.textContent).toContain("Restore safe.rsc");
  await act(async () => button("Dry-run")!.click());
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/backups/restore", {
    name: "safe.rsc",
    device: "fixture",
    confirm: false,
  });
  expect(host.textContent).toContain("Dry-run OK");
  expect(button("Restore (commit)")).toBeTruthy();
});
