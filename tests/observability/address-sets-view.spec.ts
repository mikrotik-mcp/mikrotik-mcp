// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { AddressSets } from "../../ui/observability/address-sets";
import { api, postJson } from "../../ui/observability/api";
import { routingSections } from "../../src/service-routing/inventory";
import type { RouterRoutingSnapshot } from "../../src/service-routing/inventory";
import type { AddressSetRevision } from "../../src/address-sets/model";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
test("saving and previewing never publish until explicit command consent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockResolvedValue({ revisions: [] });
  const revision: AddressSetRevision = {
    id: "00000000-0000-4000-8000-000000000001",
    device: "lab",
    createdAt: 1,
    updatedAt: 1,
    input: {
      name: "test",
      source: "fixture",
      family: "ipv4",
      left: ["10.0.0.0/24"],
      right: [],
      operation: "union",
    },
    prefixes: ["10.0.0.0/24"],
    checksum: "test-checksum",
    addresses: "256",
    list: "mcp-as-test",
    state: "draft",
  };
  vi.mocked(postJson).mockImplementation(async (path) =>
    path.includes("/preview")
      ? {
          ...revision,
          plan: {
            id: "plan",
            expiresAt: Date.now() + 60_000,
            commands: ["reviewed command"],
            references: [],
            fingerprint: "hash",
            rollback: false,
          },
        }
      : path.includes("/apply")
        ? { ...revision, state: "published" }
        : revision,
  );
  const inventory = {
    device: "lab",
    observedAt: 1,
    sections: Object.fromEntries(
      Object.entries(routingSections).map(([key, path]) => [
        key,
        {
          path,
          state: "ready",
          observedAt: 1,
          rows:
            key === "filters4"
              ? [{ ".id": "*1", "dst-address-list": "old", comment: "Example rule" }]
              : [],
        },
      ]),
    ),
  } as unknown as RouterRoutingSnapshot;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  try {
    await act(async () =>
      root.render(h(AddressSets, { device: "lab", inventory, onBusy: vi.fn() })),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(postJson).not.toHaveBeenCalled();
    await act(async () => button("Save revision").click());
    expect(host.textContent).toContain("Example rule");
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button("Preview publication").click());
    expect(button("Publish revision").disabled).toBe(true);
    expect(vi.mocked(postJson).mock.calls.some(([path]) => path.includes("/apply"))).toBe(false);
    await act(async () =>
      [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!.click(),
    );
    expect(button("Publish revision").disabled).toBe(false);
    await act(async () => button("Publish revision").click());
    expect(postJson).toHaveBeenLastCalledWith("/api/address-sets/apply?device=lab", {
      id: revision.id,
      planId: "plan",
      confirm: true,
    });
    expect(host.textContent).toContain("published");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
