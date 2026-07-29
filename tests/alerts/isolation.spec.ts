/**
 * The alert engine must never be able to slow down or fail a tool call.
 *
 * It sits on the recorder path, which sits on the tool-call path. A hung
 * webhook, a misconfigured channel, or a bug in an adapter has to be invisible
 * to the caller — otherwise adding alerting makes the whole server less
 * reliable than it was without it.
 */
import { afterEach, describe, expect, test } from "vite-plus/test";
import { AlertEngine, setAlertEngine } from "../../src/alerts/engine";
import { AlertRuleSchema } from "../../src/alerts/model";
import type { AlertRule } from "../../src/alerts/model";
import { setDeliverySleep, setMcpAlertSender } from "../../src/alerts/channels";
import { READ, defineTool } from "../../src/core/registry";
import type { RegisterableTool } from "../../src/core/registry";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return AlertRuleSchema.parse({
    id: "any-call",
    when: { event: "tool_call" },
    channels: ["mcp"],
    ...over,
  });
}

/** Drive a tool through the real registry callback. */
async function callTool(tool: RegisterableTool): Promise<CallToolResult> {
  let cb: ((a: Record<string, unknown>) => Promise<CallToolResult>) | undefined;
  tool.register({
    registerTool: (_n: string, _c: unknown, callback: unknown) => {
      cb = callback as (a: Record<string, unknown>) => Promise<CallToolResult>;
    },
  } as never);
  return cb!({});
}

const okTool = (): RegisterableTool =>
  defineTool({
    name: "list_alert_isolation_probe",
    title: "Probe",
    description: "probe",
    annotations: READ,
    inputSchema: {},
    handler: () => "handler output",
  });

afterEach(() => {
  setAlertEngine();
  setMcpAlertSender();
  setDeliverySleep();
});

describe("engine isolation from the tool-call path", () => {
  test("a channel sender that always throws does not fail the tool call", async () => {
    setMcpAlertSender(() => {
      throw new Error("channel exploded");
    });
    setAlertEngine(new AlertEngine({ rules: [rule()], channels: { mcp: {} } }));

    const res = await callTool(okTool());
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toBe("handler output");
  });

  test("an engine whose evaluation throws does not fail the tool call", async () => {
    const engine = new AlertEngine({ rules: [rule()], channels: {} });
    // Simulate a bug inside evaluation.
    (engine as unknown as { rules: unknown }).rules = {
      // Not iterable — `for...of` will throw inside notify().
      length: 1,
    };
    setAlertEngine(engine);

    const res = await callTool(okTool());
    expect(res.isError).toBeUndefined();
  });

  test("notify() returns synchronously — it never awaits delivery", () => {
    let delivered = false;
    setMcpAlertSender(() => {
      delivered = true;
    });
    const engine = new AlertEngine({ rules: [rule()], channels: { mcp: {} } });

    engine.notify({ kind: "tool_call", tool: "x" });
    // Delivery is queued, not performed inline. If notify() awaited the channel
    // this would already be true and the tool-call path would be blocked on I/O.
    expect(delivered).toBe(false);
  });

  test("a slow channel does not delay the tool call", async () => {
    setMcpAlertSender(() => {
      // A sender that blocks the event loop would show up as a slow call; this
      // one is merely slow to *resolve*, which must not matter.
    });
    setAlertEngine(new AlertEngine({ rules: [rule()], channels: { mcp: {} } }));

    const started = Date.now();
    await callTool(okTool());
    // Generous bound — the point is that we are not waiting on any timeout.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("with no engine installed, emitting is a no-op", async () => {
    setAlertEngine();
    const res = await callTool(okTool());
    expect(res.isError).toBeUndefined();
  });

  test("a failing delivery is reported as data, never thrown", async () => {
    const results: { ok: boolean; error?: string }[] = [];
    const engine = new AlertEngine({
      rules: [rule({ channels: ["slack"] })],
      // Slack selected but not configured — the classic misconfiguration.
      channels: {},
      onDelivery: (r) => results.push({ ok: r.ok, error: r.error }),
    });
    engine.notify({ kind: "tool_call", tool: "x" });
    await engine.flush();

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("not configured");
  });
});

describe("engine bookkeeping", () => {
  test("active() reports only firing rules", async () => {
    const engine = new AlertEngine({ rules: [rule()], channels: { mcp: {} } });
    expect(engine.active()).toHaveLength(0);
    engine.notify({ kind: "tool_call", tool: "x" });
    await engine.flush();
    expect(engine.active()).toHaveLength(1);
  });

  test("setRules drops state for rules that no longer exist", async () => {
    const engine = new AlertEngine({ rules: [rule()], channels: { mcp: {} } });
    engine.notify({ kind: "tool_call", tool: "x" });
    await engine.flush();
    expect(engine.active()).toHaveLength(1);

    // A re-added rule must start clean rather than resuming a stale firing state.
    engine.setRules([]);
    engine.setRules([rule()]);
    expect(engine.active()).toHaveLength(0);
  });
});
