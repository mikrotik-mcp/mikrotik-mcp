import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { gatingDecision } from "../../src/core/registry";
import {
  CAPABILITY_TTL_MS,
  getCapabilities,
  invalidateCapabilities,
  peekCapabilities,
  primeCapabilities,
  setCapabilityClock,
  setCapabilityProber,
} from "../../src/core/capability-cache";
import { unknownCapabilities } from "../../src/core/capability";
import type { Capabilities } from "../../src/core/capability";
import { parseVersion } from "../../src/core/firmware-lifecycle";
import { loadConfig } from "../../src/config";
import { setConfig } from "../../src/core/runtime";

function device(over: Partial<Capabilities> = {}): Capabilities {
  return {
    ...unknownCapabilities(),
    version: parseVersion("7.16.2"),
    board: "RB5009UG+S+",
    isRouterBoard: true,
    packages: new Set(["routeros"]),
    probedAt: 1,
    ...over,
  };
}

/** Install a config with the given gating mode. */
function useGating(mode: "off" | "annotate" | "filter"): void {
  setConfig(loadConfig(["--host", "127.0.0.1", "--capability-gating", mode]));
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  setCapabilityClock(() => now);
  invalidateCapabilities();
  useGating("annotate");
});

afterEach(() => {
  setCapabilityClock();
  setCapabilityProber();
  invalidateCapabilities();
});

describe("gatingDecision", () => {
  test("a tool without requires is never touched", () => {
    primeCapabilities(undefined, device());
    expect(gatingDecision(undefined, false)).toEqual({});
  });

  test("a cold cache lists everything — no probe means no information", () => {
    // The critical case: descriptions register at startup, before any probe.
    // Hiding or annotating here would penalise a device we know nothing about.
    expect(gatingDecision({ packages: ["container"] }, false)).toEqual({});
  });

  test("annotate prefixes the description with the reason", () => {
    primeCapabilities(undefined, device());
    const d = gatingDecision({ packages: ["container"] }, false);
    expect(d.hide).toBeUndefined();
    expect(d.prefix).toContain("unavailable on this device");
    expect(d.prefix).toContain("container");
  });

  test("a satisfied requirement produces no annotation", () => {
    primeCapabilities(undefined, device({ packages: new Set(["routeros", "container"]) }));
    expect(gatingDecision({ packages: ["container"] }, false)).toEqual({});
  });

  test("off disables annotation entirely", () => {
    useGating("off");
    primeCapabilities(undefined, device());
    expect(gatingDecision({ packages: ["container"] }, false)).toEqual({});
  });

  test("filter hides the tool in single-device mode", () => {
    useGating("filter");
    primeCapabilities(undefined, device());
    expect(gatingDecision({ packages: ["container"] }, false)).toEqual({ hide: true });
  });

  test("filter degrades to annotate in multi-device mode", () => {
    // The tool list is global while capabilities are per-device: hiding a tool
    // unsupported on the default router would remove it for every other one.
    useGating("filter");
    primeCapabilities(undefined, device());
    const d = gatingDecision({ packages: ["container"] }, true);
    expect(d.hide).toBeUndefined();
    expect(d.prefix).toContain("unavailable");
  });
});

describe("capability cache", () => {
  test("concurrent callers share one probe rather than each firing their own", async () => {
    let probes = 0;
    setCapabilityProber(async () => {
      probes++;
      return device();
    });
    const all = await Promise.all([getCapabilities(), getCapabilities(), getCapabilities()]);
    expect(probes).toBe(1);
    expect(all[0]).toBe(all[2]);
  });

  test("a second call inside the TTL reuses the cached probe", async () => {
    let probes = 0;
    setCapabilityProber(async () => {
      probes++;
      return device();
    });
    await getCapabilities();
    now += CAPABILITY_TTL_MS - 1;
    await getCapabilities();
    expect(probes).toBe(1);
  });

  test("the probe is repeated once the TTL expires", async () => {
    let probes = 0;
    setCapabilityProber(async () => {
      probes++;
      return device();
    });
    await getCapabilities();
    now += CAPABILITY_TTL_MS;
    await getCapabilities();
    expect(probes).toBe(2);
  });

  test("freshness is measured from probe START, so a slow probe cannot extend itself", async () => {
    setCapabilityProber(async () => {
      now += CAPABILITY_TTL_MS; // probe takes a full TTL to answer
      return device();
    });
    await getCapabilities();
    expect(peekCapabilities()).toBeUndefined();
  });

  test("a failing probe never rejects and is not cached", async () => {
    let probes = 0;
    setCapabilityProber(async () => {
      probes++;
      throw new Error("device unreachable");
    });
    const caps = await getCapabilities();
    // Resolves to an unknown model — a capability lookup must not be able to
    // fail a tool call that would otherwise have worked.
    expect(caps.version).toBeNull();
    await getCapabilities();
    expect(probes).toBe(2); // retried, not served from a poisoned entry
  });

  test("invalidate forces a reprobe", async () => {
    let probes = 0;
    setCapabilityProber(async () => {
      probes++;
      return device();
    });
    await getCapabilities();
    invalidateCapabilities();
    await getCapabilities();
    expect(probes).toBe(2);
  });

  test("peek is undefined until the probe resolves, then mirrors it", async () => {
    setCapabilityProber(async () => device({ board: "CRS326" }));
    expect(peekCapabilities()).toBeUndefined();
    await getCapabilities();
    expect(peekCapabilities()?.board).toBe("CRS326");
  });

  test("peek expires with the TTL", async () => {
    setCapabilityProber(async () => device());
    await getCapabilities();
    expect(peekCapabilities()).toBeDefined();
    now += CAPABILITY_TTL_MS;
    expect(peekCapabilities()).toBeUndefined();
  });
});
