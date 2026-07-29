/**
 * The capability guard, end to end through the registry.
 *
 * `gatingDecision` and the cache are unit-tested elsewhere; this exercises what
 * actually protects a call — registering a tool that declares `requires` and
 * invoking its callback against a device that does not satisfy it. The guard is
 * the safety net (listing behaviour is only UX), so it needs coverage at the
 * layer a real MCP host would hit.
 */
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { READ, defineTool } from "../../src/core/registry";
import type { RegisterableTool } from "../../src/core/registry";
import {
  invalidateCapabilities,
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

/** Register against a fake server, capturing the config and the callback. */
function register(tool: RegisterableTool): {
  cfg: { description?: string };
  call: (args?: Record<string, unknown>) => Promise<CallToolResult>;
  registered: boolean;
} {
  let cfg: { description?: string } = {};
  let cb: ((a: Record<string, unknown>) => Promise<CallToolResult>) | undefined;
  tool.register({
    registerTool: (_name: string, config: unknown, callback: unknown) => {
      cfg = config as typeof cfg;
      cb = callback as (a: Record<string, unknown>) => Promise<CallToolResult>;
    },
  } as never);
  return { cfg, call: (args = {}) => cb!(args), registered: cb !== undefined };
}

let ran = false;

function probeTool(requires: Parameters<typeof defineTool>[0]["requires"]): RegisterableTool {
  return defineTool({
    name: "list_capability_guard_probe",
    title: "Probe",
    description: "Original description.",
    annotations: READ,
    requires,
    inputSchema: {},
    handler: () => {
      ran = true;
      return "handler output";
    },
  });
}

beforeEach(() => {
  ran = false;
  setCapabilityClock(() => 1_000_000);
  // The guard must never trigger a real probe in tests.
  setCapabilityProber(async () => device());
  invalidateCapabilities();
  setConfig(loadConfig(["--host", "127.0.0.1"]));
});

afterEach(() => {
  setCapabilityClock();
  setCapabilityProber();
  invalidateCapabilities();
});

describe("capability guard at call time", () => {
  test("an unmet requirement blocks the handler and explains why", async () => {
    primeCapabilities(undefined, device());
    const res = await register(probeTool({ packages: ["container"] })).call();

    expect(res.isError).toBe(true);
    expect(ran).toBe(false); // the handler never ran — no device round-trip
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("not available on this device");
    expect(text).toContain("container");
  });

  test("a satisfied requirement runs the handler normally", async () => {
    primeCapabilities(undefined, device({ packages: new Set(["routeros", "container"]) }));
    const res = await register(probeTool({ packages: ["container"] })).call();

    expect(res.isError).toBeUndefined();
    expect(ran).toBe(true);
  });

  test("a tool without requires is never guarded", async () => {
    primeCapabilities(undefined, device());
    const res = await register(probeTool(undefined)).call();
    expect(res.isError).toBeUndefined();
    expect(ran).toBe(true);
  });

  test("an unprobeable device does not block — the probe is not an authority", async () => {
    // Probe answers nothing (unreachable, or a router that ignores the commands).
    setCapabilityProber(async () => ({ ...unknownCapabilities(), probedAt: 1_000_000 }));
    const res = await register(probeTool({ minVersion: "7.13" })).call();

    expect(res.isError).toBeUndefined();
    expect(ran).toBe(true);
  });

  test("a probe that throws does not fail the call", async () => {
    setCapabilityProber(async () => {
      throw new Error("device unreachable");
    });
    const res = await register(probeTool({ minVersion: "7.13" })).call();

    // A capability lookup must not be able to fail a call that would have worked.
    expect(res.isError).toBeUndefined();
    expect(ran).toBe(true);
  });

  test("the guard fires before the handler, so no command is built", async () => {
    primeCapabilities(undefined, device({ isRouterBoard: false }));
    await register(probeTool({ routerBoard: true })).call();
    expect(ran).toBe(false);
  });
});

describe("capability annotation at registration", () => {
  test("an unsupported tool keeps its description prefixed with the reason", () => {
    primeCapabilities(undefined, device());
    const { cfg, registered } = register(probeTool({ packages: ["container"] }));

    expect(registered).toBe(true); // annotate is the default — still listed
    expect(cfg.description).toContain("[unavailable on this device:");
    expect(cfg.description).toContain("Original description.");
  });

  test("a cold cache leaves the description untouched", () => {
    // Registration happens at startup, before any probe. Annotating here would
    // penalise a device nothing is known about.
    const { cfg } = register(probeTool({ packages: ["container"] }));
    expect(cfg.description).toBe("Original description.");
  });

  test("filter omits the tool entirely in single-device mode", () => {
    setConfig(loadConfig(["--host", "127.0.0.1", "--capability-gating", "filter"]));
    primeCapabilities(undefined, device());
    expect(register(probeTool({ packages: ["container"] })).registered).toBe(false);
  });
});
