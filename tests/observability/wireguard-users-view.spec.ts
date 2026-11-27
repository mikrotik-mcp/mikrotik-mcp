// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ratePoint } from "../../ui/observability/wireguard-traffic";
import type { Peer } from "../../ui/observability/wireguard-traffic";
import { api, postJson } from "../../ui/observability/api";
import { WireguardUsersView, copyLabel } from "../../ui/observability/wireguard-users";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));

let host: HTMLElement;
let root: Root;
beforeEach(async () => {
  vi.mocked(api).mockImplementation(async (path: string) =>
    path.startsWith("/api/devices")
      ? { devices: [{ name: "home" }], defaultDevice: "home" }
      : {
          device: "home",
          interfaces: ["wg-a", "wg-rw"],
          observedAt: Date.now(),
          interfaceOptions: [
            { name: "wg-a", endpoint: "vpn.example:51820", disabled: false },
            { name: "wg-rw", endpoint: "vpn.example:51821", disabled: false },
          ],
          peers: [
            {
              id: "a",
              rx: 0,
              tx: 0,
              handshakeAt: null,
              managed: true,
              user: "alice-phone",
              interface: "wg-rw",
              address: "10.78.78.3/32",
              expires: "2026-12-31",
              expired: false,
              disabled: false,
              lastHandshake: null,
            },
            {
              id: "b",
              rx: 256,
              tx: 1024,
              handshakeAt: Date.now() - 45000,
              managed: true,
              user: "alice-phone-2",
              interface: "wg-rw",
              address: "10.78.78.4/32",
              expires: null,
              expired: false,
              disabled: false,
              lastHandshake: "45s",
            },
          ],
        },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(WireguardUsersView)));
  await act(async () => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test("a copy gets the next free number", () => {
  expect(copyLabel("alice", [])).toBe("alice-2");
  expect(copyLabel("alice", ["alice", "alice-2"])).toBe("alice-3");
  // A copy of a copy counts on, it does not become "alice-2-2".
  expect(copyLabel("alice-2", ["alice", "alice-2"])).toBe("alice-3");
  expect(copyLabel("x".repeat(63), []).length).toBeLessThanOrEqual(63);
});

test("the list has a column head with one label for each cell", () => {
  expect(host.querySelectorAll("thead th")).toHaveLength(7);
  expect(host.textContent).toContain("45s ago");
  expect(host.textContent).toContain("Not reported");
  expect(host.textContent).toContain("1.3 KB");
});

test("Duplicate puts the user's settings in the form and changes nothing on the router", async () => {
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Inspect alice-phone"]')!.click(),
  );
  const duplicate = document.querySelector<HTMLButtonElement>(
    '[aria-label="Duplicate alice-phone"]',
  )!;
  await act(async () => duplicate.click());
  const label = document.querySelector<HTMLInputElement>(
    '.wgu-form input[aria-label="Peer name"]',
  )!;
  expect(label.value).toBe("alice-phone-3");

  expect(document.querySelector(".wgu-form details")?.textContent).toContain("Dec 31, 2026");
  expect(document.querySelector('.wgu-form [role="combobox"]')!.textContent).toContain("wg-rw");
  expect(document.body.textContent).toContain("Copied from alice-phone");
  expect(postJson).not.toHaveBeenCalled();
});

test("create peer opens immediately, explains missing inputs and submits the selected endpoint once", async () => {
  const { typeInto } = await import("../_stubs/kit");
  const add = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add peer")!;
  expect(add.disabled).toBe(false);
  await act(async () => add.click());
  const form = document.querySelector<HTMLFormElement>("#wgu-create")!;
  const submit = () =>
    act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  await submit();
  expect(form.textContent).toContain("Enter a peer name");
  expect(postJson).not.toHaveBeenCalled();
  await typeInto(form.querySelector<HTMLInputElement>('[aria-label="Peer name"]')!, "tablet");
  vi.mocked(postJson).mockResolvedValueOnce({
    ok: true,
    config: "[Interface]\nPrivateKey = fixture",
  });
  await submit();
  expect(postJson).toHaveBeenCalledWith(
    "/api/wireguard/onboard",
    expect.objectContaining({
      device: "home",
      user: "tablet",
      interface: "wg-rw",
      endpoint: "vpn.example:51821",
    }),
  );
  expect(document.body.textContent).toContain("Profile for tablet");
});

test("live rates use elapsed time and break on resets, replacement peers and missing counters", () => {
  const peer = { id: "alpha", rx: 100, tx: 200 } as Peer;
  const a = { observedAt: 1000, peers: [peer] };
  const rate = (changes: Partial<Peer>) =>
    ratePoint(a, { observedAt: 3000, peers: [{ ...peer, ...changes }] });
  expect(rate({ rx: 250100, tx: 500200 })).toMatchObject({ rx: 1, tx: 2 });
  expect(rate({ rx: 0, tx: null })).toMatchObject({ rx: null, tx: null });
  expect(rate({ id: "other" })).toMatchObject({ rx: null, tx: null });
  expect(ratePoint(a, { ...a, observedAt: 180000 })).toMatchObject({ rx: null, tx: null });
});
