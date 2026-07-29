/**
 * Drift → alert emission.
 *
 * A drift check runs on demand, often repeatedly while someone investigates. So
 * the interesting behaviour is not "does it emit" but "does it emit exactly
 * once per state change" — the same discipline the health probe follows.
 */
import { afterEach, describe, expect, test } from "vite-plus/test";
import { noteDriftResult, resetDriftAlertState } from "../../src/drift/alert";
import type { DriftReport } from "../../src/drift/engine";
import { AlertEngine, setAlertEngine } from "../../src/alerts/engine";
import { AlertRuleSchema } from "../../src/alerts/model";
import { setMcpAlertSender } from "../../src/alerts/channels";

function report(over: Partial<DriftReport> = {}): DriftReport {
  return {
    device: "core-rtr",
    baselineId: "snap_1",
    baselineTs: 0,
    capturedAt: 0,
    identical: true,
    score: 0,
    summary: { added: 0, removed: 0, unchanged: 100 },
    sections: [],
    attributions: [],
    unified: "",
    ...over,
  };
}

const DRIFTED = report({
  identical: false,
  score: 42,
  summary: { added: 3, removed: 1, unchanged: 90 },
  sections: [{ path: "/ip/firewall/filter", added: 3, removed: 1, severity: "high" }] as never,
});

/** An engine wired to catch drift events, returning the collected notifications. */
function collect(): { events: { kind: string; detail: string; device?: string }[] } {
  const events: { kind: string; detail: string; device?: string }[] = [];
  setAlertEngine(
    new AlertEngine({
      rules: [
        AlertRuleSchema.parse({
          id: "any-drift",
          // `to: "detected"` matters. Without it the rule also matches the
          // `resolved` event, which re-satisfies the condition and keeps the
          // rule firing — so it would never emit a resolve.
          when: { event: "drift", to: "detected" },
          channels: ["mcp"],
          cooldown: "0s",
        }),
      ],
      channels: { mcp: {} },
      onAlert: (n) => events.push({ kind: n.kind, detail: n.body, device: n.device }),
    }),
  );
  return { events };
}

afterEach(() => {
  resetDriftAlertState();
  setAlertEngine();
  setMcpAlertSender();
});

describe("noteDriftResult", () => {
  test("a first check that finds drift emits", () => {
    const { events } = collect();
    noteDriftResult(DRIFTED);
    expect(events).toHaveLength(1);
    expect(events[0].device).toBe("core-rtr");
    expect(events[0].detail).toContain("3 added");
  });

  test("a first check that finds nothing is not news", () => {
    // Unlike drift appearing, "we looked and it was fine" on the very first
    // check is not worth an alert.
    const { events } = collect();
    noteDriftResult(report());
    expect(events).toHaveLength(0);
  });

  test("re-checking a drifted device does NOT re-emit", () => {
    // The behaviour that matters: someone investigating runs the check three
    // more times, and gets no extra alerts for it.
    const { events } = collect();
    noteDriftResult(DRIFTED);
    noteDriftResult(DRIFTED);
    noteDriftResult(DRIFTED);
    expect(events).toHaveLength(1);
  });

  test("clearing the drift emits a resolve, once", () => {
    const { events } = collect();
    noteDriftResult(DRIFTED);
    noteDriftResult(report());
    noteDriftResult(report());
    expect(events.map((e) => e.kind)).toEqual(["fire", "resolve"]);
  });

  test("drift returning after a resolve emits again", () => {
    const { events } = collect();
    noteDriftResult(DRIFTED);
    noteDriftResult(report());
    noteDriftResult(DRIFTED);
    expect(events.map((e) => e.kind)).toEqual(["fire", "resolve", "fire"]);
  });

  test("drift state is tracked per device", () => {
    // The tracker itself is per-device: edge-rtr drifting is a state change for
    // edge-rtr regardless of what core-rtr is doing, so it emits an event.
    const seen: string[] = [];
    setAlertEngine(
      new AlertEngine({
        rules: [],
        channels: {},
        // No rules — observe the raw emissions rather than what a rule made of
        // them, since RULE state is keyed by rule id, not by device (see the
        // next test).
        onAlert: () => undefined,
      }),
    );
    const engine = new AlertEngine({ rules: [], channels: {} });
    engine.notify = ((e: { device?: string }) => {
      if (e.device) seen.push(e.device);
    }) as never;
    setAlertEngine(engine);

    noteDriftResult(DRIFTED);
    noteDriftResult({ ...DRIFTED, device: "edge-rtr" });
    expect(seen).toEqual(["core-rtr", "edge-rtr"]);
  });

  test("one rule reports EVERY device that drifts, not just the first", () => {
    // Rule state is keyed by (rule, subject), so a single "any drift" rule
    // already firing for core-rtr still fires for edge-rtr. Keying by rule id
    // alone folded the second device into the first alert — which made a
    // fleet-wide rule structurally unable to report a fleet.
    const { events } = collect();
    noteDriftResult(DRIFTED);
    noteDriftResult({ ...DRIFTED, device: "edge-rtr" });
    expect(events.map((e) => e.device)).toEqual(["core-rtr", "edge-rtr"]);
  });

  test("each device resolves independently", () => {
    const { events } = collect();
    noteDriftResult(DRIFTED);
    noteDriftResult({ ...DRIFTED, device: "edge-rtr" });
    // core-rtr is fixed; edge-rtr is still drifted and must stay firing.
    noteDriftResult(report({ device: "core-rtr" }));
    expect(events.map((e) => `${e.kind}:${e.device}`)).toEqual([
      "fire:core-rtr",
      "fire:edge-rtr",
      "resolve:core-rtr",
    ]);
  });

  test("with no engine installed it is a silent no-op", () => {
    setAlertEngine();
    expect(() => noteDriftResult(DRIFTED)).not.toThrow();
  });
});
