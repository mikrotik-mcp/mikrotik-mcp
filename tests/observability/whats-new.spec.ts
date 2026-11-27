// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { api } from "../../ui/observability/api";
import { useWhatsNew, WhatsNewModal } from "../../ui/observability/whats-new";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn() }));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));

function Dashboard({ installed }: { installed: string }) {
  const { openModal, target, dismissRelease } = useWhatsNew(installed);
  return h(
    "div",
    null,
    h("button", { onClick: openModal }, "What's new"),
    target && h(WhatsNewModal, { target, onDismiss: dismissRelease }),
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test.each([
  { installed: "6.23.0", latest: "6.22.0", seen: "6.22.0" },
  { installed: "6.18.0", latest: "6.23.0", seen: "6.18.0" },
  { installed: "6.24.0-rc.1", latest: "6.23.0", seen: "6.24.0-rc.1" },
])(
  "opens the installed notes for $installed when latest is $latest",
  async ({ installed, latest, seen }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const newer = installed === "6.18.0";
    vi.mocked(api).mockImplementation(async (path) => {
      const version = path === "/api/releases/current" ? installed : latest;
      return {
        version,
        body: `Notes belonging to ${version}`,
        currentVersion: installed,
        isNewer: newer && version === latest,
      };
    });
    localStorage.setItem("mt-whats-new-seen-version", seen);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(Dashboard, { installed })));
      if (newer) {
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
          `Notes belonging to ${latest}`,
        );
        await act(async () => document.querySelector<HTMLButtonElement>(".rn-done")!.click());
      }
      if (seen === installed) await act(async () => host.querySelector("button")!.click());
      const text = document.querySelector('[role="dialog"]')?.textContent;
      expect(text).toContain(`Notes belonging to ${installed}`);
      expect(text).not.toContain(`Notes belonging to ${latest}`);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
