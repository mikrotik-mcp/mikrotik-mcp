// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { RecoveryLabView } from "../../ui/observability/recovery-lab";
import { api, postJson } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
// Exercise consent and error behavior independently of happy-dom's incomplete WAAPI cancellation.
vi.mock("../../ui/observability/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) =>
    h("button", {
      role: "checkbox",
      "aria-checked": checked,
      onClick: () => onCheckedChange(!checked),
    }),
}));
test("unconfigured lab explains its boundary without sending data", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : { runs: [], configured: false },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(RecoveryLabView)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.textContent).toContain("Connect an isolated runner");
    expect(host.textContent).toContain("not either of your production routers");
    expect(postJson).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
test("starting a prepared run requires transfer consent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/devices"
      ? { devices: [{ name: "lab" }], defaultDevice: "lab" }
      : {
          configured: true,
          runs: [
            {
              id: "run",
              device: "lab",
              preparedAt: Date.now(),
              snapshotAt: Date.now(),
              snapshotId: "snapshot",
              version: "7.20.1",
              mode: "restore",
              state: "prepared",
              commands: ["/interface bridge add name=lab"],
              commandSha256: "a".repeat(64),
              coverage: [],
              runnerId: "isolated",
            },
          ],
        },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(RecoveryLabView)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Review & run"))!
        .click();
    });
    const submit = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Start isolated rehearsal",
    )!;
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("15-minute TTL");
    expect(postJson).not.toHaveBeenCalled();
    vi.mocked(postJson).mockRejectedValueOnce(
      new Error("Runner unavailable; verify this run before retrying."),
    );
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="dialog"] [role="checkbox"]')!.click();
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await act(async () => submit.click());
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      "Runner unavailable",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
