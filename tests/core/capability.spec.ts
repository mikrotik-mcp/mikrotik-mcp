import { describe, expect, test } from "vite-plus/test";
import {
  channelOf,
  explainUnmet,
  satisfies,
  unknownCapabilities,
  unmetReasons,
} from "../../src/core/capability";
import type { Capabilities } from "../../src/core/capability";
import {
  normalizeProbe,
  parsePackages,
  parseSettings,
  pickWirelessStack,
} from "../../src/core/capability-probe";
import { parseVersion } from "../../src/core/firmware-lifecycle";

/** A probed device, overridable per test. */
function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    ...unknownCapabilities(),
    version: parseVersion("7.16.2"),
    channel: "stable",
    board: "RB5009UG+S+",
    arch: "arm64",
    isRouterBoard: true,
    packages: new Set(["routeros", "container"]),
    wirelessStack: "wifi",
    probedAt: 1000,
    ...over,
  };
}

describe("version requirements", () => {
  test("meets an inclusive minimum", () => {
    expect(satisfies(caps({ version: parseVersion("7.13") }), { minVersion: "7.13" })).toBe(true);
    expect(satisfies(caps({ version: parseVersion("7.13.2") }), { minVersion: "7.13" })).toBe(true);
  });

  test("fails below the minimum, naming both versions", () => {
    const r = unmetReasons(caps({ version: parseVersion("6.49.7") }), { minVersion: "7.13" });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("≥ 7.13");
    expect(r[0]).toContain("6.49.7");
  });

  test("a pre-release sorts below the matching release", () => {
    expect(satisfies(caps({ version: parseVersion("7.14beta3") }), { minVersion: "7.14" })).toBe(
      false,
    );
    expect(satisfies(caps({ version: parseVersion("7.14beta3") }), { minVersion: "7.13" })).toBe(
      true,
    );
  });

  test("maxVersion is exclusive — the named release is already too new", () => {
    expect(satisfies(caps({ version: parseVersion("7.12") }), { maxVersion: "7.13" })).toBe(true);
    expect(satisfies(caps({ version: parseVersion("7.13") }), { maxVersion: "7.13" })).toBe(false);
  });

  test("an unprobed version never blocks — the probe is an optimisation", () => {
    expect(satisfies(caps({ version: null }), { minVersion: "7.13" })).toBe(true);
  });
});

describe("package requirements", () => {
  test("passes when every named package is enabled", () => {
    expect(satisfies(caps(), { packages: ["container"] })).toBe(true);
  });

  test("fails when one is missing and names it", () => {
    const r = unmetReasons(caps(), { packages: ["container", "user-manager"] });
    expect(r[0]).toContain("user-manager");
    expect(r[0]).not.toContain("container");
  });

  test("pluralises correctly for several missing packages", () => {
    expect(unmetReasons(caps(), { packages: ["iot", "zerotier"] })[0]).toContain("packages");
    expect(unmetReasons(caps(), { packages: ["iot"] })[0]).toContain("package ");
  });

  test("an unprobed device never blocks on packages", () => {
    expect(satisfies(unknownCapabilities(), { packages: ["container"] })).toBe(true);
  });
});

describe("wireless stack requirements", () => {
  test("matches a single stack", () => {
    expect(satisfies(caps({ wirelessStack: "wifi" }), { wirelessStack: "wifi" })).toBe(true);
    expect(satisfies(caps({ wirelessStack: "wireless" }), { wirelessStack: "wifi" })).toBe(false);
  });

  test("matches any of a list", () => {
    expect(
      satisfies(caps({ wirelessStack: "capsman-legacy" }), {
        wirelessStack: ["wireless", "capsman-legacy"],
      }),
    ).toBe(true);
  });

  test("a device with no wireless at all does not block", () => {
    // A wired-only router simply has no stack; blocking here would hide the
    // tool on every device whose probe found nothing.
    expect(satisfies(caps({ wirelessStack: "none" }), { wirelessStack: "wifi" })).toBe(true);
  });
});

describe("board, routerboard and device-mode requirements", () => {
  test("board regex gates a switch-chip menu", () => {
    expect(satisfies(caps({ board: "CRS326-24G-2S+" }), { board: /^CRS3/ })).toBe(true);
    expect(satisfies(caps({ board: "RB5009UG+S+" }), { board: /^CRS3/ })).toBe(false);
  });

  test("an unknown board does not block", () => {
    expect(satisfies(caps({ board: "" }), { board: /^CRS3/ })).toBe(true);
  });

  test("routerBoard excludes CHR and x86", () => {
    expect(satisfies(caps({ isRouterBoard: false }), { routerBoard: true })).toBe(false);
    expect(satisfies(caps({ isRouterBoard: true }), { routerBoard: true })).toBe(true);
  });

  test("device-mode off blocks and explains how to change it", () => {
    const off = caps({ deviceMode: { container: false, scheduler: true, fetch: true } });
    const r = unmetReasons(off, { deviceMode: "container" });
    expect(r[0]).toContain("device-mode");
    expect(r[0]).toContain("reset-button");
  });

  test("pre-7.13 devices have no device-mode menu, so nothing is restricted", () => {
    expect(satisfies(unknownCapabilities(), { deviceMode: "container" })).toBe(true);
  });
});

describe("combining requirements", () => {
  test("every unmet requirement is reported, not just the first", () => {
    const r = unmetReasons(caps({ version: parseVersion("7.1"), isRouterBoard: false }), {
      minVersion: "7.13",
      packages: ["iot"],
      routerBoard: true,
    });
    expect(r).toHaveLength(3);
  });

  test("explainUnmet joins them into one sentence; empty when satisfied", () => {
    expect(explainUnmet(caps(), { packages: ["container"] })).toBe("");
    expect(explainUnmet(caps(), { packages: ["iot"], routerBoard: false })).toContain("iot");
  });

  test("an absent requires is always satisfied", () => {
    expect(satisfies(caps(), undefined)).toBe(true);
    expect(unmetReasons(caps(), undefined)).toEqual([]);
  });
});

describe("channelOf", () => {
  test("classifies suffixes", () => {
    expect(channelOf(parseVersion("7.16.2"))).toBe("stable");
    expect(channelOf(parseVersion("7.17beta3"))).toBe("development");
    expect(channelOf(parseVersion("7.17rc1"))).toBe("testing");
    expect(channelOf(null)).toBe("unknown");
  });
});

describe("probe parsing", () => {
  test("parseSettings reads a padded key: value print", () => {
    const out = parseSettings(
      "               uptime: 1w2d\n              version: 7.16.2 (stable)\n           board-name: RB5009UG+S+",
    );
    expect(out.version).toBe("7.16.2 (stable)");
    expect(out["board-name"]).toBe("RB5009UG+S+");
  });

  test("parsePackages excludes disabled packages", () => {
    const text = [
      " # NAME                 VERSION",
      " 0 routeros             7.16.2",
      " 1 X container          7.16.2",
      " 2 user-manager         7.16.2",
    ].join("\n");
    const pkgs = parsePackages(text);
    expect(pkgs.has("routeros")).toBe(true);
    expect(pkgs.has("user-manager")).toBe(true);
    // A disabled package cannot serve its menu — treating it as present would
    // reintroduce the exact failure this feature removes.
    expect(pkgs.has("container")).toBe(false);
  });

  test("pickWirelessStack prefers the modern stack when both answer", () => {
    expect(pickWirelessStack({ wifi: true, wireless: true, capsmanLegacy: false })).toBe("wifi");
    expect(pickWirelessStack({ wifi: false, wireless: true, capsmanLegacy: false })).toBe(
      "wireless",
    );
    expect(pickWirelessStack({ wifi: false, wireless: false, capsmanLegacy: true })).toBe(
      "capsman-legacy",
    );
    expect(pickWirelessStack({ wifi: false, wireless: false, capsmanLegacy: false })).toBe("none");
  });

  test("normalizeProbe builds the model from raw text", () => {
    const c = normalizeProbe({
      resource: "  version: 7.16.2 (stable)\n  board-name: RB5009UG+S+\n  architecture-name: arm64",
      packages: " 0 routeros 7.16.2\n 1 container 7.16.2",
      routerboard: "  routerboard: yes\n  model: RB5009",
      deviceMode: "  mode: enterprise\n  container: no\n  scheduler: yes",
      wifi: true,
      wireless: false,
      capsmanLegacy: false,
      now: 42,
    });
    expect(c.version?.raw).toBe("7.16.2");
    expect(c.board).toBe("RB5009UG+S+");
    expect(c.arch).toBe("arm64");
    expect(c.isRouterBoard).toBe(true);
    expect(c.packages.has("container")).toBe(true);
    expect(c.deviceMode.container).toBe(false);
    expect(c.deviceMode.fetch).toBe(true); // absent key keeps the permissive default
    expect(c.wirelessStack).toBe("wifi");
    expect(c.probedAt).toBe(42);
  });

  test("a device that answers nothing yields an unknown-but-probed model", () => {
    const c = normalizeProbe({
      resource: null,
      packages: null,
      routerboard: null,
      deviceMode: null,
      wifi: false,
      wireless: false,
      capsmanLegacy: false,
      now: 7,
    });
    expect(c.version).toBeNull();
    expect(c.isRouterBoard).toBe(false);
    // Absent device-mode menu means unrestricted, never forbidden.
    expect(c.deviceMode).toEqual({ container: true, scheduler: true, fetch: true });
    expect(c.probedAt).toBe(7);
  });
});
