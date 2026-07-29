/**
 * Metric-rule sampling.
 *
 * `event` rules are pushed in from the tool-call path; `metric` rules only ever
 * fire because something evaluates them on a schedule. This covers the wiring
 * that does it — and the per-window behaviour, which is the part that is easy to
 * get quietly wrong.
 */
import { afterEach, describe, expect, test } from "vite-plus/test";
import { AlertEngine, setAlertEngine } from "../../src/alerts/engine";
import { AlertRuleSchema } from "../../src/alerts/model";
import type { AlertRule, MetricSample } from "../../src/alerts/model";
import { setMcpAlertSender } from "../../src/alerts/channels";
import { sampleAlertsOnce } from "../../src/alerts/sampler";

function metricRule(over: Partial<AlertRule> & { window?: string } = {}): AlertRule {
  const { window = "5m", ...rest } = over;
  return AlertRuleSchema.parse({
    id: `r-${window}`,
    when: { metric: "error_rate", window, above: 0.15, minCalls: 10 },
    channels: ["mcp"],
    ...rest,
  });
}

const sample = (over: Partial<MetricSample> = {}): MetricSample => ({
  calls: 100,
  errors: 0,
  avgDurationMs: 10,
  p95DurationMs: 20,
  ...over,
});

afterEach(() => {
  setAlertEngine();
  setMcpAlertSender();
});

describe("engine.sample computes per rule window", () => {
  test("each distinct window is computed exactly once, not once per rule", () => {
    const asked: number[] = [];
    const engine = new AlertEngine({
      rules: [
        metricRule({ id: "a", window: "5m" }),
        metricRule({ id: "b", window: "5m" }),
        metricRule({ id: "c", window: "1h" }),
      ],
      channels: { mcp: {} },
    });

    engine.sample((ms) => {
      asked.push(ms);
      return sample();
    });

    // Two rules share 5m, so three rules need only two aggregates.
    expect(asked.sort((x, y) => x - y)).toEqual([300_000, 3_600_000]);
  });

  test("a rule is evaluated against ITS OWN window, not a shared one", () => {
    // The bug this guards: one aggregate applied to every rule. Here the 5m
    // window is quiet and the 1h window is on fire — only the 1h rule may fire.
    const fired: string[] = [];
    const engine = new AlertEngine({
      rules: [metricRule({ id: "five", window: "5m" }), metricRule({ id: "hour", window: "1h" })],
      channels: { mcp: {} },
      onAlert: (n) => fired.push(n.ruleId),
    });

    engine.sample((ms) => (ms === 300_000 ? sample({ errors: 0 }) : sample({ errors: 90 })));

    expect(fired).toEqual(["hour"]);
  });

  test("event rules are untouched by sampling", () => {
    const fired: string[] = [];
    const engine = new AlertEngine({
      rules: [AlertRuleSchema.parse({ id: "ev", when: { event: "tool_call" }, channels: ["mcp"] })],
      channels: { mcp: {} },
      onAlert: (n) => fired.push(n.ruleId),
    });
    engine.sample(() => sample({ errors: 100 }));
    expect(fired).toEqual([]);
  });

  test("hasMetricRules lets the timer skip work entirely", () => {
    expect(new AlertEngine({ rules: [], channels: {} }).hasMetricRules()).toBe(false);
    expect(
      new AlertEngine({
        rules: [AlertRuleSchema.parse({ id: "e", when: { event: "drift" }, channels: ["mcp"] })],
        channels: {},
      }).hasMetricRules(),
    ).toBe(false);
    expect(new AlertEngine({ rules: [metricRule()], channels: {} }).hasMetricRules()).toBe(true);
  });

  test("a compute function that throws does not escape", () => {
    const engine = new AlertEngine({ rules: [metricRule()], channels: {} });
    // Sampling runs on a timer; an escaping throw would kill the interval and
    // silently stop every metric rule for the life of the process.
    expect(() =>
      engine.sample(() => {
        throw new Error("store exploded");
      }),
    ).not.toThrow();
  });
});

describe("metric rules fire and resolve over successive ticks", () => {
  test("crossing the threshold fires; dropping back resolves", () => {
    const fired: string[] = [];
    let now = 0;
    const engine = new AlertEngine({
      rules: [metricRule({ id: "spike" })],
      channels: { mcp: {} },
      now: () => now,
      onAlert: (n) => fired.push(`${n.kind}:${n.ruleId}`),
    });

    engine.sample(() => sample({ errors: 0 }));
    expect(fired).toEqual([]);

    now = 30_000;
    engine.sample(() => sample({ errors: 90 }));
    expect(fired).toEqual(["fire:spike"]);

    now = 60_000;
    engine.sample(() => sample({ errors: 0 }));
    expect(fired).toEqual(["fire:spike", "resolve:spike"]);
  });

  test("`for` spans ticks — a single bad sample does not fire", () => {
    const fired: string[] = [];
    let now = 0;
    const engine = new AlertEngine({
      rules: [metricRule({ id: "sustained", for: "2m" })],
      channels: { mcp: {} },
      now: () => now,
      onAlert: (n) => fired.push(n.ruleId),
    });

    engine.sample(() => sample({ errors: 90 })); // t=0 → pending
    now = 30_000;
    engine.sample(() => sample({ errors: 90 })); // 30s — not yet 2m
    expect(fired).toEqual([]);

    now = 120_000;
    engine.sample(() => sample({ errors: 90 })); // 2m held
    expect(fired).toEqual(["sustained"]);
  });

  test("minCalls keeps a quiet window from firing on a tiny sample", () => {
    const fired: string[] = [];
    const engine = new AlertEngine({
      rules: [metricRule({ id: "quiet" })],
      channels: { mcp: {} },
      onAlert: (n) => fired.push(n.ruleId),
    });
    // 1 call, 1 error — a 100% error rate, but below the 10-call floor.
    engine.sample(() => sample({ calls: 1, errors: 1 }));
    expect(fired).toEqual([]);
  });
});

describe("sampleAlertsOnce", () => {
  test("is a no-op with no engine installed", () => {
    setAlertEngine();
    expect(() => sampleAlertsOnce()).not.toThrow();
  });

  test("is a no-op when no rule needs metric sampling", () => {
    let asked = false;
    const engine = new AlertEngine({
      rules: [AlertRuleSchema.parse({ id: "e", when: { event: "drift" }, channels: ["mcp"] })],
      channels: {},
    });
    // Patch to observe whether the aggregate is ever computed.
    const original = engine.sample.bind(engine);
    engine.sample = (fn): void => {
      asked = true;
      original(fn);
    };
    setAlertEngine(engine);
    sampleAlertsOnce();
    expect(asked).toBe(false);
  });
});
