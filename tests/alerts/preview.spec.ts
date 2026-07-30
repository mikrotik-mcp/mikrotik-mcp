/**
 * The rule preview — "this rule would have fired N times over the last 24 h".
 *
 * That number is the whole point of the preview: it is what stops someone
 * shipping a rule that pages 400 times. So it has to be the number the LIVE
 * engine would produce, which means replaying the real state machine over the
 * stored events rather than counting matches — and that is exactly what these
 * cases pin.
 *
 * `previewRule` is pure, so none of this needs a route, a store or a clock.
 */
import { describe, expect, test } from "vite-plus/test";
import { AlertRuleSchema, ruleWarnings } from "../../src/alerts/model";
import type { AlertRule } from "../../src/alerts/model";
import { previewRule } from "../../src/observability/alert-routes";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

function rule(over: Record<string, unknown> = {}): AlertRule {
  return AlertRuleSchema.parse({
    id: "destructive-on-prod",
    when: { event: "tool_call", risk: ["destructive"] },
    severity: "medium",
    channels: ["slack"],
    ...over,
  });
}

interface Ev {
  ts: number;
  tool: string;
  device?: string;
  risk: string;
  isError: boolean;
}

function ev(minute: number, over: Partial<Ev> = {}): Ev {
  return {
    ts: T0 + minute * MINUTE,
    tool: "remove_route",
    device: "core-rtr",
    risk: "destructive",
    isError: false,
    ...over,
  };
}

describe("counting", () => {
  test("a matching event fires once", () => {
    expect(previewRule(rule(), [ev(0)])).toMatchObject({ fires: 1, matched: 1 });
  });

  test("no events means nothing fires", () => {
    expect(previewRule(rule(), [])).toEqual({ fires: 0, resolves: 0, matched: 0 });
  });

  test("non-matching events are counted as neither matched nor fired", () => {
    const events = [ev(0, { risk: "read" }), ev(1, { risk: "write" })];
    expect(previewRule(rule(), events)).toMatchObject({ fires: 0, matched: 0 });
  });

  test("`matched` counts every match, `fires` counts what would page you", () => {
    // Ten destructive calls a minute apart, under the default 15m cooldown.
    const events = Array.from({ length: 10 }, (_, i) => ev(i));
    const result = previewRule(rule(), events);
    expect(result.matched).toBe(10);
    // THE point of the preview: matches ≫ fires, because cooldown collapses them.
    expect(result.fires).toBe(1);
  });
});

describe("cooldown", () => {
  test("a condition that never clears fires ONCE, however many events match", () => {
    // Every event matches, so the machine stays `firing` throughout — cooldown
    // governs re-firing, and there is nothing to re-fire from.
    const events = Array.from({ length: 20 }, (_, i) => ev(i));
    expect(previewRule(rule(), events)).toMatchObject({ matched: 20, fires: 1, resolves: 0 });
  });

  test("a burst, a clear, then another burst is two incidents", () => {
    // The clear is a non-matching event: that is what resolves the condition and
    // lets the next burst count as new.
    const events = [ev(0), ev(1), ev(30, { risk: "read" }), ev(60), ev(61)];
    const result = previewRule(rule({ cooldown: "15m" }), events);
    expect(result.matched).toBe(4);
    expect(result.fires).toBe(2);
    expect(result.resolves).toBe(1);
  });

  test("a cooldown longer than the gap suppresses the second incident", () => {
    // Same timeline, but the second burst lands inside a 2h cooldown — it is
    // held quiet, which is the flap suppression the preview must reflect.
    const events = [ev(0), ev(30, { risk: "read" }), ev(60)];
    expect(previewRule(rule({ cooldown: "2h" }), events).fires).toBe(1);
    expect(previewRule(rule({ cooldown: "15m" }), events).fires).toBe(2);
  });
});

describe("filters", () => {
  test("the device filter narrows what counts as a match", () => {
    const events = [ev(0, { device: "core-rtr" }), ev(1, { device: "branch-01" })];
    const scoped = rule({
      when: { event: "tool_call", risk: ["destructive"], device: ["core-rtr"] },
    });
    expect(previewRule(scoped, events).matched).toBe(1);
  });

  test("risk matching is case-insensitive, as the live engine's is", () => {
    // Risk presets are upper-case; config is written lower-case.
    expect(previewRule(rule(), [ev(0, { risk: "DESTRUCTIVE" })]).matched).toBe(1);
  });

  test("an isError filter matches only failures", () => {
    const errors = rule({ when: { event: "tool_call", isError: true } });
    const events = [ev(0, { isError: false }), ev(1, { isError: true })];
    expect(previewRule(errors, events).matched).toBe(1);
  });
});

describe("ordering and shape", () => {
  test("events are replayed oldest-first regardless of input order", () => {
    // The machine is a timeline: fed newest-first, `for`/cooldown arithmetic
    // would run backwards and the count would be meaningless.
    const forward = previewRule(rule(), [ev(0), ev(1), ev(2)]);
    const reversed = previewRule(rule(), [ev(2), ev(1), ev(0)]);
    expect(reversed).toEqual(forward);
  });

  test("a metric rule previews as zero rather than guessing", () => {
    // Preview replays tool-call events; a metric rule needs window aggregates
    // that the event log alone cannot reconstruct, so it reports nothing rather
    // than a number someone might trust.
    const metric = AlertRuleSchema.parse({
      id: "error-spike",
      when: { metric: "error_rate", window: "5m", above: 0.15 },
      channels: ["slack"],
    });
    expect(previewRule(metric, [ev(0)])).toEqual({ fires: 0, resolves: 0, matched: 0 });
  });

  test("an absence rule likewise previews as zero", () => {
    const absence = AlertRuleSchema.parse({
      id: "no-snapshot",
      when: { absence: "snapshot", within: "24h" },
      channels: ["slack"],
    });
    expect(previewRule(absence, [ev(0)])).toEqual({ fires: 0, resolves: 0, matched: 0 });
  });
});

describe("rule warnings", () => {
  test("a stateful event rule with no `to` is flagged as never-resolving", () => {
    const drift = AlertRuleSchema.parse({
      id: "drift-detected",
      when: { event: "drift" },
      channels: ["slack"],
    });
    const warnings = ruleWarnings(drift);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("never");
    expect(warnings[0]).toContain("to: detected");
  });

  test("device_state without `to` is flagged too, suggesting offline", () => {
    const down = AlertRuleSchema.parse({
      id: "device-down",
      when: { event: "device_state" },
      channels: ["slack"],
    });
    expect(ruleWarnings(down)[0]).toContain("to: offline");
  });

  test("the same rules WITH a `to` filter are clean", () => {
    for (const when of [
      { event: "drift", to: "detected" },
      { event: "device_state", to: "offline" },
    ]) {
      const ok = AlertRuleSchema.parse({ id: "ok", when, channels: ["slack"] });
      expect(ruleWarnings(ok)).toEqual([]);
    }
  });

  test("a stateless event kind needs no `to` and is not flagged", () => {
    expect(ruleWarnings(rule())).toEqual([]);
    const txn = AlertRuleSchema.parse({
      id: "txn-partial",
      when: { event: "transaction" },
      channels: ["slack"],
    });
    expect(ruleWarnings(txn)).toEqual([]);
  });

  test("metric and absence rules are never flagged", () => {
    const metric = AlertRuleSchema.parse({
      id: "m",
      when: { metric: "calls", window: "5m", above: 100 },
      channels: ["slack"],
    });
    expect(ruleWarnings(metric)).toEqual([]);
  });
});
