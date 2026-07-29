import { describe, expect, test } from "vite-plus/test";
import {
  absenceMet,
  AlertRuleSchema,
  eventMet,
  initialState,
  isMuted,
  metricMet,
  parseDuration,
  parseRules,
  step,
} from "../../src/alerts/model";
import type { AlertRule, AlertState, EventTriggerT } from "../../src/alerts/model";

const MIN = 60_000;

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return AlertRuleSchema.parse({
    id: "r1",
    when: { event: "device_state", to: "offline" },
    channels: ["slack"],
    ...over,
  });
}

/** Drive the machine over a script of [met, at] and collect the actions. */
function run(r: AlertRule, script: [boolean, number][]): string[] {
  let state: AlertState = initialState(0);
  const out: string[] = [];
  for (const [met, now] of script) {
    const res = step(r, state, met, now);
    state = res.state;
    if (res.action.type !== "none") out.push(res.action.type);
  }
  return out;
}

describe("parseDuration", () => {
  test("parses each unit", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(5 * MIN);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  test("rejects anything else", () => {
    for (const v of ["", "5", "m", "5x", "-5m", "1.5h", "5 m"]) {
      expect(parseDuration(v)).toBeNull();
    }
  });
});

describe("metric conditions", () => {
  const t = { metric: "error_rate", window: "5m", above: 0.15, minCalls: 20 } as const;

  test("fires above the threshold", () => {
    expect(metricMet(t, { calls: 100, errors: 20, avgDurationMs: 0, p95DurationMs: 0 })).toBe(true);
  });

  test("does not fire at or below the threshold", () => {
    expect(metricMet(t, { calls: 100, errors: 15, avgDurationMs: 0, p95DurationMs: 0 })).toBe(
      false,
    );
    expect(metricMet(t, { calls: 100, errors: 5, avgDurationMs: 0, p95DurationMs: 0 })).toBe(false);
  });

  test("minCalls suppresses a 100% rate from a tiny sample", () => {
    // One failure on an idle server is a 100% error rate. Paging on that is the
    // fastest way to get an alerting system muted.
    expect(metricMet(t, { calls: 1, errors: 1, avgDurationMs: 0, p95DurationMs: 0 })).toBe(false);
  });

  test("a rule with no bound never fires rather than always firing", () => {
    const none = { metric: "calls", window: "5m", minCalls: 0 } as const;
    expect(metricMet(none, { calls: 999, errors: 0, avgDurationMs: 0, p95DurationMs: 0 })).toBe(
      false,
    );
  });

  test("below-bound and latency metrics", () => {
    expect(
      metricMet(
        { metric: "calls", window: "5m", below: 5, minCalls: 0 },
        { calls: 2, errors: 0, avgDurationMs: 0, p95DurationMs: 0 },
      ),
    ).toBe(true);
    expect(
      metricMet(
        { metric: "p95_duration_ms", window: "5m", above: 1000, minCalls: 0 },
        { calls: 10, errors: 0, avgDurationMs: 100, p95DurationMs: 2000 },
      ),
    ).toBe(true);
  });

  test("zero calls is a zero rate, not a division by zero", () => {
    expect(
      metricMet(
        { metric: "error_rate", window: "5m", above: 0.1, minCalls: 0 },
        { calls: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0 },
      ),
    ).toBe(false);
  });
});

describe("event conditions", () => {
  test("kind must match", () => {
    expect(eventMet({ event: "drift" }, { kind: "drift" })).toBe(true);
    expect(eventMet({ event: "drift" }, { kind: "tool_call" })).toBe(false);
  });

  test("absent matchers match anything", () => {
    expect(eventMet({ event: "tool_call" }, { kind: "tool_call", device: "x", risk: "READ" })).toBe(
      true,
    );
  });

  test("risk matching is case-insensitive, since presets are upper and config is lower", () => {
    expect(
      eventMet(
        { event: "tool_call", risk: ["destructive"] },
        { kind: "tool_call", risk: "DESTRUCTIVE" },
      ),
    ).toBe(true);
  });

  test("device and tool lists are membership tests", () => {
    const t: EventTriggerT = { event: "tool_call", device: ["core-rtr"] };
    expect(eventMet(t, { kind: "tool_call", device: "core-rtr" })).toBe(true);
    expect(eventMet(t, { kind: "tool_call", device: "lab" })).toBe(false);
    // A matcher present but the event carrying no value cannot match.
    expect(eventMet(t, { kind: "tool_call" })).toBe(false);
  });

  test("isError distinguishes false from absent", () => {
    expect(
      eventMet({ event: "tool_call", isError: false }, { kind: "tool_call", isError: false }),
    ).toBe(true);
    expect(
      eventMet({ event: "tool_call", isError: true }, { kind: "tool_call", isError: false }),
    ).toBe(false);
  });
});

describe("absence conditions", () => {
  test("never seen counts as absent", () => {
    expect(absenceMet({ absence: "snapshot", within: "24h" }, undefined, 0)).toBe(true);
  });

  test("within the window is not absent; beyond it is", () => {
    const t = { absence: "snapshot", within: "1h" } as const;
    expect(absenceMet(t, 0, 30 * MIN)).toBe(false);
    expect(absenceMet(t, 0, 61 * MIN)).toBe(true);
  });
});

describe("fire / resolve machine", () => {
  test("fires immediately with no `for`", () => {
    expect(run(rule(), [[true, 0]])).toEqual(["fire"]);
  });

  test("`for` delays the fire until the condition has held long enough", () => {
    const r = rule({ for: "2m" });
    expect(
      run(r, [
        [true, 0],
        [true, 1 * MIN],
      ]),
    ).toEqual([]);
    expect(
      run(r, [
        [true, 0],
        [true, 1 * MIN],
        [true, 2 * MIN],
      ]),
    ).toEqual(["fire"]);
  });

  test("a condition that clears before `for` elapses never fires", () => {
    expect(
      run(rule({ for: "2m" }), [
        [true, 0],
        [false, 1 * MIN],
        [true, 2 * MIN],
      ]),
    ).toEqual([]);
  });

  test("resolve is emitted once when a firing condition clears", () => {
    expect(
      run(rule(), [
        [true, 0],
        [false, 1 * MIN],
      ]),
    ).toEqual(["fire", "resolve"]);
  });

  test("staying firing emits nothing further", () => {
    expect(
      run(rule(), [
        [true, 0],
        [true, 1 * MIN],
        [true, 2 * MIN],
      ]),
    ).toEqual(["fire"]);
  });

  test("cooldown suppresses a re-fire", () => {
    // fire, clear (resolve), then re-met inside the 15m cooldown.
    expect(
      run(rule(), [
        [true, 0],
        [false, 1 * MIN],
        [true, 2 * MIN],
        [true, 3 * MIN],
      ]),
    ).toEqual(["fire", "resolve"]);
  });

  test("a re-fire is allowed once the cooldown has expired", () => {
    expect(
      run(rule({ cooldown: "5m" }), [
        [true, 0],
        [false, 1 * MIN],
        [true, 6 * MIN],
      ]),
    ).toEqual(["fire", "resolve", "fire"]);
  });

  test("flapping ten times inside the cooldown yields exactly one fire and one resolve", () => {
    // The headline behaviour: an alerting system that fires 400 times for one
    // flapping link is worse than none, because people mute it and then miss
    // the real one.
    const script: [boolean, number][] = [];
    for (let i = 0; i < 10; i++) {
      script.push([true, i * 2 * 1000], [false, i * 2 * 1000 + 1000]);
    }
    expect(run(rule(), script)).toEqual(["fire", "resolve"]);
  });

  test("leaving suppression does not emit a second resolve", () => {
    const r = rule();
    let s = initialState(0);
    s = step(r, s, true, 0).state; // fire
    s = step(r, s, false, 1000).state; // resolve
    s = step(r, s, true, 2000).state; // suppressed (inside cooldown)
    expect(s.status).toBe("suppressed");
    const out = step(r, s, false, 3000);
    expect(out.action.type).toBe("none");
    expect(out.state.status).toBe("clear");
  });

  test("a muted rule emits nothing but keeps its state", () => {
    const r = rule({ mutedUntil: 10 * MIN });
    expect(
      run(r, [
        [true, 0],
        [false, 1 * MIN],
      ]),
    ).toEqual([]);
    // Un-muting does not replay what happened while quiet.
    expect(
      run(rule({ mutedUntil: 1 * MIN }), [
        [true, 0],
        [true, 2 * MIN],
      ]),
    ).toEqual(["fire"]);
  });

  test("a disabled rule never emits", () => {
    expect(
      run(rule({ enabled: false }), [
        [true, 0],
        [false, 1 * MIN],
      ]),
    ).toEqual([]);
  });

  test("isMuted respects the boundary", () => {
    const r = rule({ mutedUntil: 1000 });
    expect(isMuted(r, 999)).toBe(true);
    expect(isMuted(r, 1000)).toBe(false);
    expect(isMuted(rule(), 0)).toBe(false);
  });
});

describe("rule parsing", () => {
  test("defaults are applied", () => {
    const r = rule();
    expect(r.severity).toBe("medium");
    expect(r.cooldown).toBe("15m");
    expect(r.enabled).toBe(true);
  });

  test("an unknown trigger kind is rejected at parse time", () => {
    expect(() =>
      AlertRuleSchema.parse({ id: "x", when: { nonsense: true }, channels: ["slack"] }),
    ).toThrow();
  });

  test("a malformed duration is rejected", () => {
    expect(() =>
      AlertRuleSchema.parse({
        id: "x",
        when: { event: "drift" },
        channels: ["slack"],
        for: "soon",
      }),
    ).toThrow();
  });

  test("an unknown channel is rejected", () => {
    expect(() =>
      AlertRuleSchema.parse({ id: "x", when: { event: "drift" }, channels: ["carrier-pigeon"] }),
    ).toThrow();
  });

  test("at least one channel is required — a rule nobody hears is a bug", () => {
    expect(() =>
      AlertRuleSchema.parse({ id: "x", when: { event: "drift" }, channels: [] }),
    ).toThrow();
  });

  test("duplicate ids are rejected, since ids key mute and history", () => {
    const one = { id: "dup", when: { event: "drift" }, channels: ["slack"] };
    expect(() => parseRules([one, { ...one }])).toThrow(/Duplicate alert rule id: dup/);
  });

  test("a valid list parses", () => {
    expect(parseRules([{ id: "a", when: { event: "drift" }, channels: ["mcp"] }])).toHaveLength(1);
  });
});
