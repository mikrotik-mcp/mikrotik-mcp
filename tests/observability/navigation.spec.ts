import { expect, test } from "vite-plus/test";
import { NAV_GROUPS, VIEWS, navigationGroups, viewGroup } from "../../ui/observability/navigation";

test("grouped navigation preserves every page exactly once", () => {
  const ids = NAV_GROUPS.flatMap((group) => group.views);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(VIEWS.map((view) => view.id).sort());
  expect(VIEWS).toHaveLength(32);
  expect(viewGroup("home-internet").id).toBe("observe");
  for (const view of VIEWS) expect(viewGroup(view.id).views).toContain(view.id);
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
