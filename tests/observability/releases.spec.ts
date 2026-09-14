// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { api, postJson } from "../../ui/observability/api";
import { ReleasesView } from "../../ui/observability/releases";
import { ReleaseDowngradeButton } from "../../ui/observability/release-actions";

vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue({
    currentVersion: "5.7.0",
    latestVersion: "5.7.0",
    updateAvailable: false,
    fetchedAt: 1,
    releases: ["5.7.0", "5.6.0", "5.5.0"].map((version, i) => ({
      version,
      name: version,
      body: `Notes for ${version}`,
      publishedAt: "2026-09-11T12:00:00Z",
      url: "https://example.com/release",
      prerelease: false,
      relation: i === 0 ? "current" : "older",
    })),
  });
  vi.mocked(postJson).mockResolvedValue({ ok: true, version: "5.6.0" });
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
  await act(async () => root.render(h(ReleasesView)));
};
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const action = () =>
  host.querySelector<HTMLButtonElement>('[aria-label="Review downgrade to v5.6.0"]')!;
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
    (b) => b.textContent?.trim() === label,
  )!;

test("release history gives every row one shared rail and marker; notes still expand", async () => {
  await render();
  const rows = host.querySelectorAll('ol[aria-label="Release history"] > li');
  expect(rows).toHaveLength(3);
  for (const row of rows)
    expect(row.querySelectorAll(".release-timeline-rail > .release-timeline-node")).toHaveLength(1);
  expect(action().textContent).toContain("v5.6.0");
  await click(rows[1]!.querySelector<HTMLButtonElement>('button[title="Show notes"]')!);
  expect(rows[1]!.textContent).toContain("Notes for 5.6.0");
  expect(postJson).not.toHaveBeenCalled();
});

test("hover, focus, review and cancel never install a release", async () => {
  await render();
  await act(async () => {
    action().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    action().focus();
  });
  expect(postJson).not.toHaveBeenCalled();
  await click(action());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Downgrade to v5.6.0?",
  );
  expect(postJson).not.toHaveBeenCalled();
  await click(dialogButton("Cancel"));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(postJson).not.toHaveBeenCalled();
});

test("only explicit confirmation sends the exact target version to the mocked installer", async () => {
  await render();
  await click(action());
  await click(dialogButton("Downgrade"));
  expect(postJson).toHaveBeenCalledExactlyOnceWith("/api/upgrade", { version: "5.6.0" });
});

test("disabled BeUI downgrade controls cannot request review", async () => {
  const review = vi.fn();
  await act(async () =>
    root.render(h(ReleaseDowngradeButton, { version: "5.6.0", disabled: true, onReview: review })),
  );
  await click(action());
  expect(review).not.toHaveBeenCalled();
  expect(action().type).toBe("button");
});
