// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { IpNetwork, networkIp } from "../../ui/observability/ip-network";
import { DeviceAddressesEditor } from "../../ui/observability/device-addresses";
import { api } from "../../ui/observability/api";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn() }));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue({
    status: "resolved",
    asn: "AS13335",
    asnOrganization: "Example Network",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("accepts IPv4, IPv6 and CIDRs but not hostnames, URLs, malformed prefixes or short IPv4", () => {
  expect(networkIp(" 8.8.8.8 ")).toBe("8.8.8.8");
  expect(networkIp("8.8.8.8/32")).toBe("8.8.8.8");
  expect(networkIp("2606:4700::1111/128")).toBe("2606:4700::1111");
  for (const value of [
    "",
    "localhost",
    "https://8.8.8.8",
    "8.8.8",
    "999.8.8.8",
    "8.8.8.8/33",
    "2606::1/129",
    "8.8.8.8/path",
  ])
    expect(networkIp(value)).toBeNull();
});

test("debounces edits, displays organization and ASN, and annotates the selected IP only", async () => {
  await act(async () => root.render(h(IpNetwork, { address: "8.8.8.8" })));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => root.render(h(IpNetwork, { address: "1.1.1.1" })));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api).mock.calls[0][0]).toBe("/api/ip-network?ip=1.1.1.1");
  expect(host.textContent).toContain("Example Network");
  expect(host.textContent).toContain("AS13335");
  expect(host.querySelector("[aria-label]")?.getAttribute("aria-label")).toContain("1.1.1.1");
  await act(async () => root.render(h(IpNetwork, { address: "9.9.9.9" })));
  expect(host.textContent).not.toContain("Example Network");
  expect(host.textContent).toContain("Looking up ASN");
});

test("polls pending lookups without blocking and cancels polls on unmount", async () => {
  vi.mocked(api).mockResolvedValueOnce({ status: "pending" });
  await act(async () => root.render(h(IpNetwork, { address: "8.8.8.8/32" })));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(host.textContent).toContain("Looking up ASN");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain("Example Network");
  expect(host.querySelector("[title]")?.getAttribute("title")).toContain(
    "not necessarily the whole subnet",
  );
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(api).toHaveBeenCalledTimes(2);
});

test("discards a late response after changing the IP", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(h(IpNetwork, { address: "8.8.8.8" })));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  await act(async () => root.render(h(IpNetwork, { address: "1.1.1.1" })));
  await act(async () => resolve({ status: "resolved", asnOrganization: "Old network" }));
  expect(host.textContent).not.toContain("Old network");
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(host.textContent).toContain("Example Network");
});

test("shows private and unavailable states without inventing an organization", async () => {
  vi.mocked(api).mockResolvedValueOnce({ status: "private" });
  await act(async () => root.render(h(IpNetwork, { address: "10.0.0.1" })));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(host.textContent).toContain("Private network");
  vi.mocked(api).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(h(IpNetwork, { address: "8.8.8.8" })));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(host.textContent).toContain("ASN unavailable");
  await act(async () => root.render(h(IpNetwork, { address: "router.example" })));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(host.textContent).toBe("");
  expect(api).toHaveBeenCalledTimes(2);
});

test("annotates both primary and fallback device inputs without changing the draft", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      h(DeviceAddressesEditor, {
        host: "8.8.8.8",
        fallbackHosts: ["1.1.1.1"],
        onChange,
      }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(host.textContent?.match(/Example Network/g)).toHaveLength(2);
  expect(onChange).not.toHaveBeenCalled();
});
