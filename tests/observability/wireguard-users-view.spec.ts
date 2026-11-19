// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
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
          users: [
            {
              user: "alice-phone",
              interface: "wg-rw",
              address: "10.78.78.3/32",
              expires: "2026-12-31",
              expired: false,
              disabled: false,
              lastHandshake: null,
            },
            {
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
  const head = host.querySelector(".wgu-head")!;
  expect([...head.children].map((c) => c.textContent)).toEqual([
    "User",
    "Address",
    "Interface",
    "Last handshake",
    "Access",
    "",
  ]);
  expect(host.querySelector(".wgu-list .wgu-row")!.children).toHaveLength(head.children.length);
});

test("Duplicate puts the user's settings in the form and changes nothing on the router", async () => {
  const duplicate = host.querySelector<HTMLButtonElement>('[aria-label="Duplicate alice-phone"]')!;
  await act(async () => duplicate.click());
  const label = host.querySelector<HTMLInputElement>('.wgu-form input[aria-label="User label"]')!;
  expect(label.value).toBe("alice-phone-3");
  expect(document.activeElement).toBe(label);
  expect(
    host.querySelector<HTMLInputElement>('.wgu-form input[aria-label="Expires (optional)"]')!.value,
  ).toBe("2026-12-31");
  expect(host.querySelector('.wgu-form [role="combobox"]')!.textContent).toContain("wg-rw");
  expect(host.textContent).toContain("Copied from alice-phone");
  expect(postJson).not.toHaveBeenCalled();
});
