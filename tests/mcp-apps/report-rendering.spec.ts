// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { buildReportView, REPORT_VIEW_TOOLS } from "../../src/core/report-views";
import type { ReportView } from "../../src/core/report-views";
import { renderReport, jsonEvidence, statusBadge } from "../../ui/shared/report";
import { VIEW_FIXTURES } from "./view-fixtures";

describe("evidence rendering", () => {
  it.each(Object.keys(REPORT_VIEW_TOOLS))("renders %s with no executable action", (kind) => {
    const root = renderReport(VIEW_FIXTURES[kind] as unknown as ReportView);
    expect(root.textContent?.length).toBeGreaterThan(50);
    expect(root.querySelector("a,form,script")).toBeNull();
  });
  it("keeps unknown separate from pass and modelled", () => {
    expect(statusBadge("unknown").className).toContain("is-warn");
    expect(statusBadge("pass").className).toContain("is-good");
    expect(statusBadge("modelled").className).toContain("is-info");
  });
  it("shows exact ingress/egress and simulation boundaries", () => {
    const rendered = renderReport(VIEW_FIXTURES["round-trip"] as unknown as ReportView);
    expect(rendered.textContent).toContain("wg-transit");
    expect(rendered.textContent).toContain("NAT boundary");
    expect(rendered.textContent).toContain("not a live trace");
    expect(rendered.querySelectorAll(".path-hop")).toHaveLength(3);
  });
  it("escapes JSON strings while coloring keys and values", () => {
    const rendered = jsonEvidence({
      "<img>": "<script>alert(1)</script>",
      count: 0,
      active: false,
    });
    expect(rendered.querySelector("img,script")).toBeNull();
    expect(rendered.querySelector(".json-string")?.textContent).toContain("<script>");
    expect(rendered.querySelector(".json-number")?.textContent).toBe("0");
  });
  it("renders plain text without guessing health", () => {
    const view = buildReportView(
      "reports",
      "diagnose",
      "Diagnosis",
      "lab",
      "Evidence unavailable.\n\nDo not infer success.",
    );
    expect(renderReport(view).textContent).toContain("Do not infer success");
    expect(renderReport(view).querySelector(".is-good")).toBeNull();
  });
  it("searches dedicated visuals and reports an unmatched query", () => {
    const view = VIEW_FIXTURES["round-trip"] as unknown as ReportView;
    expect(renderReport(view, "wg-transit").textContent).toContain("wg-transit");
    expect(renderReport(view, "wg-transit").textContent).not.toContain("bridge-lan");
    expect(renderReport(view, "not-a-real-interface").textContent).toContain("No evidence matches");
  });
  it("does not present an unavailable check as zero-ms latency", () => {
    const root = renderReport(VIEW_FIXTURES["service-health"] as unknown as ReportView);
    expect(root.textContent).toContain("Not measured");
  });
  it.each([false, 0, "Result", {}])("renders scalar and empty structured results: %s", (data) => {
    const view = buildReportView("reports", "diagnose", "Diagnosis", "lab", JSON.stringify(data));
    expect(renderReport(view).textContent?.length).toBeGreaterThan(0);
  });
});
