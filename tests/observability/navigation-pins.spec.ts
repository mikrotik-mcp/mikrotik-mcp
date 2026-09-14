import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_PINS_KEY,
  parseNavigationPins,
  readNavigationPins,
  saveNavigationPins,
  toggleNavigationPin,
} from "../../ui/observability/navigation-pins";

describe("pinned dashboard pages", () => {
  it("starts empty and ignores corrupt or outdated browser preferences", () => {
    for (const raw of [null, "bad json", "null", "{}", "true", '"overview"'])
      expect(parseNavigationPins(raw)).toEqual([]);
    expect(parseNavigationPins('["clients","removed-page",8,null,"clients","overview"]')).toEqual([
      "clients",
      "overview",
    ]);
  });

  it("preserves pin order and can remove and re-pin a page without mutating state", () => {
    const initial = toggleNavigationPin([], "clients");
    const added = toggleNavigationPin(initial, "overview");
    expect(initial).toEqual(["clients"]);
    expect(added).toEqual(["clients", "overview"]);
    expect(toggleNavigationPin(added, "clients")).toEqual(["overview"]);
    expect(toggleNavigationPin(toggleNavigationPin(added, "clients"), "clients")).toEqual([
      "overview",
      "clients",
    ]);
    expect(toggleNavigationPin(initial, "clients")).toEqual([]);
  });

  it("round-trips only the dedicated preference, including removing the final pin", () => {
    const entries = new Map([["mt-theme", "dark"]]);
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    expect(readNavigationPins(storage)).toEqual([]);
    expect(saveNavigationPins(["devices", "investigations"], storage)).toBe(true);
    expect(entries.get(NAVIGATION_PINS_KEY)).toBe('["devices","investigations"]');
    expect(readNavigationPins(storage)).toEqual(["devices", "investigations"]);
    expect(saveNavigationPins([], storage)).toBe(true);
    expect(readNavigationPins(storage)).toEqual([]);
    expect(entries.get("mt-theme")).toBe("dark");
  });

  it("does not crash when browser storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readNavigationPins(blocked)).toEqual([]);
    expect(saveNavigationPins(["overview"], blocked)).toBe(false);
  });
});
