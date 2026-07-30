/**
 * Which devices a sweep actually reads.
 *
 * The subtle case is a device the health probe has NOT reached yet. "Never
 * probed" is not the same as "known offline", and skipping it would be a blind
 * spot that looks exactly like a clean result — so it is scanned.
 */
import { describe, expect, test } from "vite-plus/test";
import { loadConfig } from "../../src/config";
import { setConfig } from "../../src/core/runtime";
import { resolveTargets } from "../../src/attack/session";

const FLEET = JSON.stringify({
  devices: {
    edge: { host: "10.0.0.1" },
    core: { host: "10.0.0.2" },
    branch: { host: "10.0.0.3" },
  },
});

function useFleet(): void {
  setConfig(loadConfig(["--devices", FLEET]));
}

describe("resolveTargets", () => {
  test("defaults to every configured device", () => {
    useFleet();
    const { targets, skipped } = resolveTargets({});
    expect(targets.sort()).toEqual(["branch", "core", "edge"]);
    expect(skipped).toEqual([]);
  });

  test("an explicit list wins over the fleet", () => {
    useFleet();
    expect(resolveTargets({ devices: ["core"] }).targets).toEqual(["core"]);
  });

  test("onlineOnly keeps unprobed devices — never probed is not known-offline", () => {
    // Nothing has been probed in this process, so every device is `null`.
    useFleet();
    const { targets, skipped } = resolveTargets({ onlineOnly: true });
    expect(targets.sort()).toEqual(["branch", "core", "edge"]);
    expect(skipped).toEqual([]);
  });

  test("onlineOnly narrows an explicit list too", () => {
    useFleet();
    const { targets } = resolveTargets({ devices: ["core"], onlineOnly: true });
    expect(targets).toEqual(["core"]);
  });

  test("an empty explicit list is not treated as 'all'", () => {
    // The route maps an empty selection to undefined; if that ever regresses,
    // scanning nothing must not silently become scanning everything.
    useFleet();
    expect(resolveTargets({ devices: [] }).targets).toEqual([]);
  });
});
