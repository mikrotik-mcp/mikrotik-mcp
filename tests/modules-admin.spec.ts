/**
 * Offline tests for the dashboard's tool-module surface helpers. These pin the
 * toggle semantics (deny wins, allow-list gates) so the Modules page checkbox
 * and the actually-registered surface can never disagree.
 */
import { describe, expect, test } from "vite-plus/test";
import { ToolFilterSchema } from "../src/config";
import { selectToolModules } from "../src/tools";
import { applyModuleToggle, isModuleEnabled, moduleSurface } from "../src/observability/modules";

const empty = (): ReturnType<typeof ToolFilterSchema.parse> => ToolFilterSchema.parse({});

describe("moduleSurface", () => {
  test("default filter exposes every module", () => {
    const s = moduleSurface(empty());
    expect(s.total).toBeGreaterThan(100);
    expect(s.enabledModules).toBe(s.total);
    expect(s.enabledTools).toBe(s.totalTools);
    expect(s.hasAllowList).toBe(false);
    expect(s.modules.every((m) => m.enabled)).toBe(true);
  });

  test("disabledModules hides exactly that module", () => {
    const f = ToolFilterSchema.parse({ disabledModules: ["dns"] });
    const s = moduleSurface(f);
    expect(s.modules.find((m) => m.slug === "dns")?.enabled).toBe(false);
    expect(s.enabledModules).toBe(s.total - 1);
  });

  test("enabledModules allow-list hides everything else (but keeps the always-on modules)", () => {
    const f = ToolFilterSchema.parse({ enabledModules: ["dns", "routes"] });
    const s = moduleSurface(f);
    expect(s.hasAllowList).toBe(true);
    // The allow-listed two PLUS every ALWAYS_ON_MODULES entry survive.
    expect(
      s.modules
        .filter((m) => m.enabled)
        .map((m) => m.slug)
        .sort(),
    ).toEqual(["access", "dns", "memory", "routes", "safe-mode", "server-pulse", "tool-gateway"]);
  });
});

describe("applyModuleToggle", () => {
  test("disable from the full surface adds to disabledModules", () => {
    const next = applyModuleToggle(empty(), "dns", false);
    expect(next.disabledModules).toContain("dns");
    expect(isModuleEnabled(ToolFilterSchema.parse(next), "dns", "Networking")).toBe(false);
  });

  test("re-enabling drops it back out of disabledModules (idempotent)", () => {
    const off = applyModuleToggle(empty(), "dns", false);
    const on = applyModuleToggle(ToolFilterSchema.parse(off), "dns", true);
    expect(on.disabledModules).not.toContain("dns");
    expect(on.enabledModules).toEqual([]); // no allow-list was in force
  });

  test("disabling is idempotent — no duplicate entries", () => {
    let f = empty();
    f = ToolFilterSchema.parse(applyModuleToggle(f, "dns", false));
    f = ToolFilterSchema.parse(applyModuleToggle(f, "dns", false));
    expect(f.disabledModules.filter((s) => s === "dns")).toHaveLength(1);
  });

  test("under an allow-list, enabling adds to enabledModules so it surfaces", () => {
    const f = ToolFilterSchema.parse({ enabledModules: ["routes"] });
    const next = applyModuleToggle(f, "dns", true);
    expect(next.enabledModules).toContain("dns");
    expect(isModuleEnabled(ToolFilterSchema.parse(next), "dns", "anything")).toBe(true);
  });

  test("under an allow-list, disabling a listed module removes it from the allow-list", () => {
    const f = ToolFilterSchema.parse({ enabledModules: ["dns", "routes"] });
    const next = applyModuleToggle(f, "dns", false);
    expect(next.enabledModules).not.toContain("dns");
    expect(next.disabledModules).toContain("dns");
  });

  test("toggle result matches selectToolModules for the same filter", () => {
    // Disable two modules and confirm the registered surface really drops them.
    let f = empty();
    f = ToolFilterSchema.parse(applyModuleToggle(f, "container", false));
    f = ToolFilterSchema.parse(applyModuleToggle(f, "disk", false));
    const registered = selectToolModules(f);
    const surface = moduleSurface(f);
    // selectToolModules returns the surviving modules' tool arrays.
    expect(registered.length).toBe(surface.enabledModules);
  });
});
