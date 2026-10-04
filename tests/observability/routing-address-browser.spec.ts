// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  RoutingAddressBrowser,
  routingAddressCache,
} from "../../ui/observability/service-routing-address-browser";
import { api } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn() }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const rows = Array.from({ length: 201 }, (_, i) => ({
  ".id": `*${i}`,
  address: `192.0.2.${i}`,
  list: i === 200 ? "Google" : "Office",
  comment: i === 200 ? "Google production" : "Office network",
}));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  routingAddressCache.clear();
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) => {
      const params = new URL(path, "http://localhost").searchParams;
      const offset = Number(params.get("offset")),
        family = params.get("family");
      const source =
        family === "ipv6"
          ? [{ ".id": "*1", address: "2001:db8::1", list: "Other", comment: "Claude downloads" }]
          : rows;
      return {
        device: params.get("device"),
        family,
        offset,
        total: source.length,
        rows: source.slice(offset, offset + 200),
        nextOffset: offset + 200 < source.length ? offset + 200 : undefined,
      };
    });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  routingAddressCache.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(device = "lab") {
  await act(async () =>
    root.render(
      h(RoutingAddressBrowser, { device, references: ["Google"], referenceFamily: "ipv4" }),
    ),
  );
}
async function search(value: string) {
  const input = host.querySelector('input[aria-label="Search IP, comment or address list"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
test("referenced lists include members after the first page and fuzzy input never fetches again", async () => {
  await mount();
  expect(host.textContent).toContain("201 entries indexed");
  expect(host.textContent).toContain("192.0.2.200");
  expect(host.querySelector('[aria-label="Address search results"]')?.children).toHaveLength(1);
  await search("gogle production");
  expect(host.textContent).toContain("Approximate");
  expect(host.textContent).toContain("192.0.2.200");
  expect(api).toHaveBeenCalledTimes(2);
  await search("nothing-to-match");
  expect(host.textContent).toContain("No matching addresses");
  await act(async () =>
    (host.querySelector('[aria-label="Clear address search"]') as HTMLButtonElement).click(),
  );
  expect(host.textContent).toContain("192.0.2.200");
});
test("all-router scope includes unreferenced IPv6 lists and cached results are reused on reopen", async () => {
  await mount();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("All router lists"))!
      .click(),
  );
  await search("cluade");
  expect(host.textContent).toContain("2001:db8::1");
  expect(host.textContent).toContain("Other");
  expect(host.textContent).toContain("Approximate");
  expect(api).toHaveBeenCalledTimes(3);
  await act(async () => root.render(null));
  await mount();
  expect(api).toHaveBeenCalledTimes(3);
});
test("read failures show incomplete coverage, not an empty list", async () => {
  vi.mocked(api).mockRejectedValue(new Error("Device disconnected"));
  await mount();
  expect(host.textContent).toContain("Device disconnected");
  expect(host.textContent).toContain("Search coverage is incomplete");
  expect(host.textContent).not.toContain("No matching addresses");
  expect(
    (host.querySelector('[aria-label="Refresh address search"]') as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("keeps full row details and copies only the selected address", async () => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await mount();
  const details = host.querySelector('summary[aria-label="Details for 192.0.2.200"]');
  expect(details?.closest("details")?.textContent).toContain("Google production");
  await act(async () =>
    (host.querySelector('button[aria-label="Copy 192.0.2.200"]') as HTMLButtonElement).click(),
  );
  expect(write).toHaveBeenCalledWith("192.0.2.200");
  write.mockRejectedValue(new Error("denied"));
  await act(async () =>
    (host.querySelector('button[aria-label="Copy 192.0.2.200"]') as HTMLButtonElement).click(),
  );
  expect(host.textContent).toContain("Clipboard unavailable");
});
