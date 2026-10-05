// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { AaaView } from "../../ui/observability/aaa";
import { api, postJson } from "../../ui/observability/api";
import { limitationRate } from "../../ui/observability/format";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.mock("../../ui/observability/um-reports", () => ({ UmReports: () => null }));
vi.mock("../../ui/observability/toast-action", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.hoisted(() => Reflect.deleteProperty(Element.prototype, "animate"));

test.each([
  ["10000000B", "1.25 MB/s"],
  ["5000000B", "0.625 MB/s"],
  ["25000000B", "3.125 MB/s"],
  ["50000000B", "6.25 MB/s"],
  ["10M", "1.25 MB/s"],
  ["10MB", "1.25 MB/s"],
  ["2.5m", "0.3125 MB/s"],
  ["512k", "0.064 MB/s"],
  ["1Gbps", "125 MB/s"],
  ["10000000", "1.25 MB/s"],
  [" 10M ", "1.25 MB/s"],
  ["0B", "Unlimited"],
  ["0", "Unlimited"],
  ["0M", "Unlimited"],
  ["1", "<0.000001 MB/s"],
  [undefined, "—"],
  ["", "—"],
  [" ", "—"],
  ["unavailable", "unavailable"],
  ["10M/5M", "10M/5M"],
  ["-1", "-1"],
  ["10garbage", "10garbage"],
])("formats limitation rate %s as %s without inventing a value", (raw, expected) => {
  expect(limitationRate(raw)).toBe(expected);
});

test("formats only rate cells and preserves raw values when editing and saving", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/devices") return { defaultDevice: "home", devices: [{ name: "home" }] };
    return {
      available: true,
      rows: [
        {
          name: "10m",
          "rate-limit-rx": "10000000B",
          "rate-limit-tx": "5000000B",
          "transfer-limit": "1000000000B",
          "uptime-limit": "1d",
        },
        { name: "unlimited", "rate-limit-rx": "0B", "rate-limit-tx": "0B" },
        { name: "unknown" },
      ],
    };
  });
  vi.mocked(postJson).mockResolvedValue({ ok: true, message: "Updated" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const click = async (el: HTMLElement) => {
    await act(async () => el.click());
  };
  try {
    await act(async () => root.render(h(AaaView)));
    await click(button("Limitations"));
    const headers = [...host.querySelectorAll("th")].map((el) => el.textContent);
    expect(headers).toContain("Rate ↓ (MB/s)");
    expect(headers).toContain("Rate ↑ (MB/s)");
    const rows = [...host.querySelectorAll("tbody tr")];
    const cells = [...rows[0].querySelectorAll("td")];
    expect(cells.map((cell) => cell.textContent).slice(0, 5)).toEqual([
      "10m",
      "1.25 MB/s",
      "0.625 MB/s",
      "1000000000B",
      "1d",
    ]);
    expect(cells[1].title).toBe("10000000B");
    expect(rows[1].textContent).toContain("Unlimited");
    expect([...rows[2].querySelectorAll("td")].slice(1, 3).map((el) => el.textContent)).toEqual([
      "—",
      "—",
    ]);
    expect(postJson).not.toHaveBeenCalled();
    await click(button("Edit"));
    const input = [...host.querySelectorAll("label")]
      .find((el) => el.textContent?.startsWith("Download rate"))!
      .querySelector("input")!;
    expect(input.value).toBe("10000000B");
    await click(button("Save"));
    expect(postJson).toHaveBeenCalledWith("/api/aaa/update", {
      device: "home",
      slug: "um-limitations",
      id: "10m",
      fields: {
        name: "10m",
        "rate-limit-rx": "10000000B",
        "rate-limit-tx": "5000000B",
        "transfer-limit": "1000000000B",
        "uptime-limit": "1d",
      },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
