import { expect, test } from "vite-plus/test";
import { diffLines } from "../src/core/diff";
import { analyzeDrift, attributeChanges, driftScore, renderDriftReport } from "../src/drift/engine";

test("section analysis assigns edits to RouterOS paths and weights firewall drift", () => {
  const before =
    "/ip firewall filter\nadd chain=input action=accept\n/ip address\nadd address=192.0.2.1/24";
  const after =
    "/ip firewall filter\nadd chain=input action=drop\n/ip address\nadd address=192.0.2.1/24\nadd address=192.0.2.2/24";
  const report = analyzeDrift(diffLines(before, after), "lab", "baseline-1", 1);
  expect(report.identical).toBe(false);
  expect(report.sections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "/ip firewall filter", added: 1, removed: 1 }),
      expect.objectContaining({ path: "/ip address", added: 1, removed: 0 }),
    ]),
  );
  expect(report.score).toBeGreaterThan(0);
  expect(report.sections.find((s) => s.path === "/ip firewall filter")?.hunks).toContain(
    "action=drop",
  );
  expect(driftScore(report.sections)).toBe(report.score);
});

test("unchanged exports report in-sync status without drift sections", () => {
  const exportText = "/ip address\nadd address=192.0.2.1/24";
  const report = analyzeDrift(diffLines(exportText, exportText), "lab", "baseline-1", 1);
  expect(report.identical).toBe(true);
  expect(report.sections).toEqual([]);
  expect(report.score).toBe(0);
  expect(renderDriftReport(report, 50)).toContain("No differences");
});

test("attribution correlates config changes to section and user, ignoring login-only logs", () => {
  const sections = [{ path: "/ip firewall filter", added: 1, removed: 0, hunks: "" }];
  const logs =
    "jul/04/2025 10:30:05 system,info firewall filter changed by admin\njul/04/2025 10:31:00 account user admin logged in";
  const attributed = attributeChanges(sections, logs);
  expect(attributed).toHaveLength(1);
  expect(attributed[0]).toMatchObject({
    section: "/ip firewall filter",
    user: "admin",
    action: "changed",
    timestamp: "jul/04/2025 10:30:05",
  });
  expect(attributeChanges(sections, " ")).toEqual([]);
});

test("report includes attribution and truncates a long unified diff at its line budget", () => {
  const report = analyzeDrift(
    diffLines("/ip firewall filter\nadd action=accept", "/ip firewall filter\nadd action=drop"),
    "lab",
    "baseline-1",
    1,
  );
  report.attributions = attributeChanges(
    report.sections,
    "jul/04/2025 10:30:05 firewall changed by admin",
  );
  report.unified = Array.from({ length: 100 }, (_, i) => `+line-${i}`).join("\n");
  const rendered = renderDriftReport(report, 10);
  expect(rendered).toContain("DRIFTED");
  expect(rendered).toContain("by admin");
  expect(rendered).toContain("diff truncated");
  expect(rendered).not.toContain("line-99");
  expect(driftScore([{ path: "/ip firewall filter", added: 50, removed: 50, hunks: "" }])).toBe(
    100,
  );
});
