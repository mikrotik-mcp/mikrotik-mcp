/**
 * The two guards the registry applies to every call BEFORE a handler runs:
 * fail-closed device targeting, and rejection of HTML-escaped write values.
 *
 * Both exist because the failure they prevent is silent. An unknown device name
 * used to fall back to the default router — the call succeeded, against the
 * wrong hardware. HTML-escaped text used to be stored verbatim, so the write
 * succeeded and only later exact-match lookups failed. Neither is visible in a
 * handler unit test, so they are covered here, at the layer a real MCP host hits.
 */
import { beforeEach, describe, expect, test } from "vite-plus/test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { READ, WRITE, defineTool } from "../../src/core/registry";
import type { RegisterableTool } from "../../src/core/registry";
import { MikrotikConfigSchema } from "../../src/config";
import type { MikrotikConfig } from "../../src/config";
import { setConfig } from "../../src/core/runtime";

/** Register against a fake server, capturing the tool callback. */
function register(
  tool: RegisterableTool,
  deviceNames?: string[],
): (args?: Record<string, unknown>) => Promise<CallToolResult> {
  let cb: ((a: Record<string, unknown>) => Promise<CallToolResult>) | undefined;
  tool.register(
    {
      registerTool: (_name: string, _config: unknown, callback: unknown) => {
        cb = callback as (a: Record<string, unknown>) => Promise<CallToolResult>;
      },
    } as never,
    { deviceNames },
  );
  return (args = {}) => cb!(args);
}

const text = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

const TWO_DEVICES: MikrotikConfig = MikrotikConfigSchema.parse({
  devices: {
    home: { host: "10.0.0.1" },
    branch: { host: "10.0.0.2", description: "Branch Office" },
  },
  defaultDevice: "home",
});

beforeEach(() => setConfig(TWO_DEVICES));

describe("fail-closed device targeting", () => {
  // Records which device the handler actually saw, so a silent fallback is
  // detectable rather than merely assumed absent.
  const spy = (): { tool: RegisterableTool; seen: () => string | undefined } => {
    let seen: string | undefined;
    let ran = false;
    const tool = defineTool({
      name: "probe_target",
      title: "Probe",
      annotations: READ,
      description: "d",
      handler(_a, ctx) {
        ran = true;
        seen = ctx.device;
        return "ok";
      },
    });
    return { tool, seen: () => (ran ? (seen ?? "(default)") : undefined) };
  };

  test("an unknown device name is an error, NOT a fall back to the default", async () => {
    const { tool, seen } = spy();
    const res = await register(tool, ["home", "branch"])({ device: "ghost" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Unknown device 'ghost'");
    // The point of the whole guard: the handler must never have run.
    expect(seen()).toBeUndefined();
  });

  test("the error says the call did not silently retarget", async () => {
    const res = await register(spy().tool, ["home", "branch"])({ device: "ghost" });
    expect(text(res)).toContain("NOT run against the default device");
  });

  test("a real key and a friendly label both pass through", async () => {
    for (const name of ["branch", "Branch Office"]) {
      const { tool, seen } = spy();
      const res = await register(tool, ["home", "branch"])({ device: name });
      expect(res.isError).toBeFalsy();
      expect(seen()).toBe(name);
    }
  });

  test("omitting the device still uses the default", async () => {
    const { tool, seen } = spy();
    const res = await register(tool, ["home", "branch"])({});
    expect(res.isError).toBeFalsy();
    expect(seen()).toBe("(default)");
  });
});

describe("HTML-escaped write values are rejected", () => {
  const writer = defineTool({
    name: "probe_write",
    title: "Write",
    annotations: WRITE,
    description: "d",
    handler: () => "wrote",
  });
  const reader = defineTool({
    name: "probe_read",
    title: "Read",
    annotations: READ,
    description: "d",
    handler: () => "read",
  });

  test("a comment carrying an entity is refused before the write", async () => {
    const res = await register(writer)({ comment: "Guest &amp; IoT" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("'comment' contains HTML-escaped text");
    expect(text(res)).toContain("&amp;");
  });

  test("every entity a model reaches for is caught", async () => {
    for (const v of ["a &lt; b", "a &gt; b", "say &quot;hi&quot;", "it&#39;s", "it&apos;s"]) {
      const res = await register(writer)({ comment: v });
      expect(res.isError).toBe(true);
    }
  });

  test("plain text and a bare ampersand pass", async () => {
    for (const v of ["Guest & IoT", "uplink <-> core", "normal comment"]) {
      const res = await register(writer)({ comment: v });
      expect(res.isError).toBeFalsy();
    }
  });

  test("reads are not filtered — a search may legitimately look for the literal", async () => {
    const res = await register(reader)({ comment_filter: "&amp;" });
    expect(res.isError).toBeFalsy();
  });
});
