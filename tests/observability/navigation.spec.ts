import { expect, test } from "vite-plus/test";
import {
  NAV_GROUPS,
  VIEWS,
  navigationGroups,
  parseViewHash,
  viewGroup,
} from "../../ui/observability/navigation";
import type { ViewId } from "../../ui/observability/navigation";

test("grouped navigation preserves every page exactly once", () => {
  const ids = NAV_GROUPS.flatMap((group) => group.views);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(VIEWS.map((view) => view.id).sort());
  expect(VIEWS).toHaveLength(42);
  expect(NAV_GROUPS).toHaveLength(8);
  expect(new Set(NAV_GROUPS.map((group) => group.id)).size).toBe(NAV_GROUPS.length);
  for (const group of NAV_GROUPS) {
    expect(group.views.length).toBeGreaterThan(0);
    expect(group.description.length).toBeGreaterThan(0);
  }
  for (const view of VIEWS) expect(viewGroup(view.id).views).toContain(view.id);
});

const expectedSections: [string, ViewId[]][] = [
  [
    "monitoring",
    ["overview", "home-internet", "service-contracts", "flows", "feed", "alerts", "schedules"],
  ],
  ["network", ["devices", "interfaces", "topology", "fabric", "capsman", "service-routing"]],
  ["users-vpn", ["clients", "openvpn", "aaa"]],
  [
    "diagnostics",
    [
      "investigations",
      "ip-intelligence",
      "client-checks",
      "round-trip",
      "simulator",
      "packets",
      "flight-recorder",
      "support-bundles",
    ],
  ],
  ["security", ["attacks", "vulns", "policies"]],
  ["configuration", ["explain", "plan", "txn", "drift"]],
  ["recovery", ["snapshots", "backups", "s3", "router-migration", "recovery-lab"]],
  ["workspace", ["prompts", "memory", "modules", "access", "config", "releases"]],
];
test.each(expectedSections)("%s groups pages by the operator's task", (section, pages) => {
  expect(NAV_GROUPS.find((group) => group.id === section)?.views).toEqual(pages);
  for (const page of pages) {
    expect(viewGroup(page).id).toBe(section);
    expect(parseViewHash(`#${page}`)).toBe(page);
    expect(parseViewHash(`#/${page}`)).toBe(page);
  }
});

test("navigation search finds labels, descriptions and groups without changing route ids", () => {
  expect(navigationGroups("  ROUND-TRIP  ")[0].items.map((view) => view.id)).toEqual([
    "round-trip",
  ]);
  expect(navigationGroups("netflow")[0].items[0].id).toBe("flows");
  expect(navigationGroups("workspace")[0].items.map((view) => view.id)).toContain("config");
  expect(navigationGroups("forward snapshots")[0].items[0].id).toBe("round-trip");
  expect(navigationGroups("not-a-page")).toEqual([]);
  expect(navigationGroups(" ").flatMap((group) => group.items)).toHaveLength(VIEWS.length);
});

test.each([
  ["ipquery", "ip-intelligence"],
  ["wifi", "capsman"],
  ["wireless", "capsman"],
  ["user manager", "aaa"],
  ["mcp permissions", "access"],
  ["service probes", "config"],
  ["cloud bucket", "s3"],
  ["cron", "schedules"],
])("navigation understands %s without changing page names", (query, page) => {
  expect(navigationGroups(query).flatMap((group) => group.items.map((item) => item.id))).toContain(
    page,
  );
});

test("category search returns exactly that category in its configured order", () => {
  for (const label of [
    "Monitoring",
    "Users & VPN",
    "Diagnostics",
    "Backup & recovery",
    "MCP workspace",
  ]) {
    const section = NAV_GROUPS.find((group) => group.label === label)!;
    expect(navigationGroups(label).flatMap((group) => group.items.map((item) => item.id))).toEqual(
      section.views,
    );
  }
});
