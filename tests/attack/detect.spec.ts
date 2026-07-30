/**
 * Detectors and correlation.
 *
 * The two failure modes worth most of these cases:
 *
 * 1. **Firing one event below the threshold.** A detector that trips at nine
 *    when it promised ten is a detector nobody can tune, and every threshold in
 *    here is asserted from both sides.
 * 2. **Reporting a calm network because the input was missing.** A detector
 *    whose source is absent must say `unavailable` and name the fix — silence
 *    reads as safety, and that is the most dangerous output this module has.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_DETECTOR_CONFIG,
  isPublicSource,
  maxInWindow,
  parseFirewallLog,
  runDetectors,
} from "../../src/attack/detectors";
import type { DetectionInput, Signal } from "../../src/attack/detectors";
import { correlate, incidentId, mergeIncident } from "../../src/attack/correlate";
import { parseLog } from "../../src/attack/parse";
import type { LogEvent } from "../../src/attack/parse";
import { API_BRUTE_FORCE } from "./fixtures/logs";

const NOW = Date.UTC(2026, 6, 30, 18, 0, 0);
const MIN = 60_000;

/** A synthetic log event — the detectors only ever see this shape. */
function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    device: "edge",
    ts: NOW,
    timeText: "2026-07-30 18:00:00",
    topics: ["system", "error", "critical"],
    message: "login failure for user admin from 203.0.113.7 via ssh",
    extra: {},
    app: "ssh",
    user: "admin",
    outcome: "failure",
    source: "203.0.113.7",
    key: "k",
    ...over,
  };
}

/** `n` failures spaced `gapMs` apart, ending at NOW. */
function failures(n: number, over: Partial<LogEvent> = {}, gapMs = 10_000): LogEvent[] {
  return Array.from({ length: n }, (_, i) =>
    event({
      ...over,
      ts: NOW - (n - 1 - i) * gapMs,
      key: `k${i}${over.user ?? ""}${over.source ?? ""}`,
    }),
  );
}

function run(over: Partial<DetectionInput> = {}) {
  return runDetectors({ device: "edge", events: [], now: NOW, ...over });
}

const of = (result: { signals: Signal[] }, detector: string): Signal[] =>
  result.signals.filter((s) => s.detector === detector);

describe("helpers", () => {
  test("maxInWindow finds a burst that ended before the poll", () => {
    // A plain "count in the last 5 minutes" would score 0 here; the attacker
    // stopped ten minutes ago, which is exactly when they got in.
    const stamps = Array.from({ length: 12 }, (_, i) => NOW - 10 * MIN + i * 1000);
    expect(maxInWindow(stamps, 5 * MIN)).toBe(12);
  });

  test("maxInWindow does not count across the window edge", () => {
    const stamps = [0, 1000, 10 * MIN, 10 * MIN + 1000];
    expect(maxInWindow(stamps, 5 * MIN)).toBe(2);
  });

  test("isPublicSource rejects RFC1918, loopback and CGNAT", () => {
    for (const a of ["10.0.0.1", "192.168.88.1", "172.16.4.4", "127.0.0.1", "100.64.0.1", "::1"]) {
      expect(isPublicSource(a), a).toBe(false);
    }
    for (const a of ["203.0.113.7", "8.8.8.8", "2001:db8::1"]) {
      expect(isPublicSource(a), a).toBe(true);
    }
  });

  test("parseFirewallLog reads a logged rule hit", () => {
    const hit = parseFirewallLog(
      "input: in:ether1 out:(unknown 0), proto TCP (SYN), 203.0.113.90:51222->192.0.2.1:8291, len 60",
    );
    expect(hit).toMatchObject({
      inInterface: "ether1",
      protocol: "TCP",
      src: "203.0.113.90",
      dstPort: 8291,
    });
  });

  test("parseFirewallLog returns null for anything else, never a guess", () => {
    expect(parseFirewallLog("user admin logged in from 10.0.0.1 via ssh")).toBeNull();
    expect(parseFirewallLog("")).toBeNull();
  });
});

describe("brute-force", () => {
  test("fires at the threshold", () => {
    const r = run({ events: failures(DEFAULT_DETECTOR_CONFIG.bruteForce.failures) });
    expect(of(r, "brute-force")).toHaveLength(1);
  });

  test("does NOT fire one event below it", () => {
    const r = run({ events: failures(DEFAULT_DETECTOR_CONFIG.bruteForce.failures - 1) });
    expect(of(r, "brute-force")).toEqual([]);
  });

  test("does not fire when the same count is spread beyond the window", () => {
    const r = run({ events: failures(10, {}, 2 * MIN) });
    expect(of(r, "brute-force")).toEqual([]);
  });

  test("counts each source separately", () => {
    const r = run({
      events: [...failures(10), ...failures(9, { source: "198.51.100.5" })],
    });
    const hits = of(r, "brute-force");
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("203.0.113.7");
  });

  test("a sustained attack is high, not medium", () => {
    expect(of(run({ events: failures(60, {}, 1000) }), "brute-force")[0].severity).toBe("high");
  });

  test("carries the usernames and services as evidence", () => {
    const signal = of(run({ events: failures(10) }), "brute-force")[0];
    expect(signal.users).toEqual(["admin"]);
    expect(signal.apps).toEqual(["ssh"]);
    expect(signal.evidence.length).toBeGreaterThan(0);
    expect(signal.evidence[0].message).toContain("login failure");
  });

  test("is never marked spoofable — an authentication attempt completed a handshake", () => {
    expect(of(run({ events: failures(10) }), "brute-force")[0].spoofable).toBe(false);
  });
});

describe("credential-spray", () => {
  test("fires on three usernames from one source", () => {
    const events = ["root", "oracle", "sync"].flatMap((user) => failures(2, { user }));
    expect(of(run({ events }), "credential-spray")).toHaveLength(1);
  });

  test("does not fire on two", () => {
    const events = ["root", "oracle"].flatMap((user) => failures(4, { user }));
    expect(of(run({ events }), "credential-spray")).toEqual([]);
  });

  test("names the usernames tried", () => {
    const events = ["root", "oracle", "sync"].flatMap((user) => failures(2, { user }));
    const signal = of(run({ events }), "credential-spray")[0];
    expect(signal.users).toContain("oracle");
    expect(signal.summary).toContain("3 different usernames");
  });
});

describe("successful-after-fail — the one that pages a human", () => {
  const success = event({
    outcome: "success",
    message: "user admin logged in from 203.0.113.7 via ssh",
    key: "ok",
  });

  test("fires when a success follows failures from the same source", () => {
    const r = run({ events: [...failures(3, {}, MIN), success] });
    const hits = of(r, "successful-after-fail");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("critical");
    expect(hits[0].summary).toContain("compromised");
  });

  test("does not fire when the failures were long ago", () => {
    const old = failures(3, {}, MIN).map((e) => ({ ...e, ts: (e.ts as number) - 60 * MIN }));
    expect(of(run({ events: [...old, success] }), "successful-after-fail")).toEqual([]);
  });

  test("does not fire for a success from a source that never failed", () => {
    const other = { ...success, source: "198.51.100.9", key: "ok2" };
    expect(of(run({ events: [...failures(3, {}, MIN), other] }), "successful-after-fail")).toEqual(
      [],
    );
  });
});

describe("new-admin-source and the learning window", () => {
  const success = event({
    outcome: "success",
    message: "user admin logged in from 203.0.113.50 via ssh",
    source: "203.0.113.50",
    key: "ok",
  });

  test("reports itself UNAVAILABLE while learning rather than firing on everything", () => {
    const r = run({ events: [success] });
    expect(of(r, "new-admin-source")).toEqual([]);
    expect(r.unavailable.some((u) => u.detector === "new-admin-source")).toBe(true);
  });

  test("fires for an unknown public source once the baseline is ready", () => {
    const r = run({ events: [success], baseline: { sources: ["198.51.100.1"], ready: true } });
    expect(of(r, "new-admin-source")).toHaveLength(1);
  });

  test("does not fire for a source already in the baseline", () => {
    const r = run({ events: [success], baseline: { sources: ["203.0.113.50"], ready: true } });
    expect(of(r, "new-admin-source")).toEqual([]);
  });

  test("never fires for a private source — the LAN is not a new admin location", () => {
    const lan = { ...success, source: "192.168.88.20", key: "lan" };
    const r = run({ events: [lan], baseline: { sources: [], ready: true } });
    expect(of(r, "new-admin-source")).toEqual([]);
  });
});

describe("the monitoring must not alert on itself", () => {
  test("the MCP server's own management logins produce no signal at all", () => {
    // Found on a live device: the health probe logs a successful SSH login every
    // few seconds. A detector that finds this interesting alerts forever.
    const ours = Array.from({ length: 50 }, (_, i) =>
      event({
        outcome: "success",
        source: "10.64.60.2",
        message: "user admin logged in from 10.64.60.2 via ssh",
        ts: NOW - i * 10_000,
        key: `own${i}`,
      }),
    );
    const r = run({
      events: ours,
      trusted: ["10.64.60.2"],
      baseline: { sources: [], ready: true },
    });
    expect(r.signals).toEqual([]);
  });

  test("a trusted source is excluded even when it looks exactly like an attack", () => {
    const r = run({ events: failures(50, {}, 1000), trusted: ["203.0.113.7"] });
    expect(r.signals).toEqual([]);
  });
});

describe("port-scan reads the device's own verdict", () => {
  test("unavailable when the address list was not read", () => {
    expect(run().unavailable.some((u) => u.detector === "port-scan")).toBe(true);
  });

  test("one signal per tagged address", () => {
    const r = run({ scanList: ["203.0.113.1", "203.0.113.2"] });
    expect(of(r, "port-scan")).toHaveLength(2);
  });

  test("a trusted address is not reported even if the device tagged it", () => {
    const r = run({ scanList: ["203.0.113.1"], trusted: ["203.0.113.1"] });
    expect(of(r, "port-scan")).toEqual([]);
  });
});

describe("firewall-derived detectors", () => {
  const fwLine = (src: string, port: number, i: number, ts = NOW): LogEvent =>
    event({
      ts,
      outcome: undefined,
      user: undefined,
      app: undefined,
      source: src,
      topics: ["firewall", "info"],
      message: `input: in:ether1 out:(unknown 0), proto TCP (SYN), ${src}:5122${i}->192.0.2.1:${port}, len 60`,
      key: `fw${src}${i}${ts}`,
    });

  test("both report unavailable when no rule logs its hits", () => {
    const r = run({ events: failures(2) });
    const ids = r.unavailable.map((u) => u.detector);
    expect(ids).toContain("firewall-drop-storm");
    expect(ids).toContain("service-exposure-hit");
    expect(r.unavailable.find((u) => u.detector === "firewall-drop-storm")?.fix).toContain(
      "log=yes",
    );
  });

  test("a drop storm fires at the threshold and is marked SPOOFABLE", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      fwLine("203.0.113.90", 445, i, NOW - i * 1000),
    );
    const signal = of(run({ events }), "firewall-drop-storm")[0];
    expect(signal).toBeDefined();
    // The whole point: a flood's source is whatever the attacker wrote.
    expect(signal.spoofable).toBe(true);
  });

  test("a drop storm does not fire one event below the threshold", () => {
    const events = Array.from({ length: 99 }, (_, i) =>
      fwLine("203.0.113.90", 445, i, NOW - i * 1000),
    );
    expect(of(run({ events }), "firewall-drop-storm")).toEqual([]);
  });

  test("a management port reached from the internet is high severity", () => {
    const signal = of(
      run({ events: [fwLine("203.0.113.90", 8291, 1)] }),
      "service-exposure-hit",
    )[0];
    expect(signal.severity).toBe("high");
    expect(signal.summary).toContain("8291");
  });

  test("a LAN source reaching a management port is not exposure", () => {
    expect(of(run({ events: [fwLine("192.168.88.5", 8291, 1)] }), "service-exposure-hit")).toEqual(
      [],
    );
  });

  test("a non-management port is not exposure", () => {
    expect(of(run({ events: [fwLine("203.0.113.90", 51820, 1)] }), "service-exposure-hit")).toEqual(
      [],
    );
  });
});

describe("post-compromise", () => {
  test("unavailable with no drift source — RouterOS does not audit config changes", () => {
    const u = run().unavailable.find((x) => x.detector === "post-compromise");
    expect(u).toBeDefined();
    expect(u?.fix).toContain("config_set_baseline");
  });

  test("fires on an unexplained change to a sensitive menu", () => {
    const r = run({ configChanges: [{ section: "/user", detail: "user 'backup' added" }] });
    const signal = of(r, "post-compromise")[0];
    expect(signal.severity).toBe("critical");
  });

  test("a change THIS server made is not a compromise", () => {
    const r = run({
      configChanges: [{ section: "/user", detail: "user added", byThisServer: true }],
    });
    expect(of(r, "post-compromise")).toEqual([]);
  });

  test("a change to an unremarkable menu is not a compromise", () => {
    const r = run({ configChanges: [{ section: "/system/note", detail: "note changed" }] });
    expect(of(r, "post-compromise")).toEqual([]);
  });
});

describe("clockless events", () => {
  test("are counted and excluded from windowed detection, never guessed at", () => {
    const noClock = failures(20).map((e) => ({ ...e, ts: null }));
    const r = run({ events: noClock });
    expect(r.clocklessEvents).toBe(20);
    expect(of(r, "brute-force")).toEqual([]);
  });
});

describe("real fixtures", () => {
  test("the observed API brute force parses and scores as one source", () => {
    const { events } = parseLog(API_BRUTE_FORCE, "netherlands");
    const r = runDetectors({
      device: "netherlands",
      events,
      now: Date.UTC(2026, 6, 30, 17, 18, 0),
      config: { ...DEFAULT_DETECTOR_CONFIG, bruteForce: { failures: 3, windowMs: 5 * MIN } },
    });
    const hits = of(r, "brute-force");
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("198.51.100.22");
    expect(hits[0].apps).toEqual(["api"]);
  });
});

describe("correlation", () => {
  const signal = (over: Partial<Signal>): Signal => ({
    detector: "brute-force",
    device: "edge",
    source: "203.0.113.7",
    firstTs: NOW - MIN,
    lastTs: NOW,
    count: 10,
    severity: "medium",
    spoofable: false,
    summary: "10 failed logins",
    evidence: [],
    ...over,
  });

  test("one source on three devices is ONE incident, not three", () => {
    // The pattern no single router can see, and the argument for the host.
    const incidents = correlate(
      [signal({ device: "a" }), signal({ device: "b" }), signal({ device: "c" })],
      { now: NOW },
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0].devices).toEqual(["a", "b", "c"]);
  });

  test("different sources are different incidents", () => {
    const incidents = correlate([signal({}), signal({ source: "198.51.100.9" })], { now: NOW });
    expect(incidents).toHaveLength(2);
  });

  test("the stage is the furthest one reached", () => {
    const incidents = correlate(
      [
        signal({ detector: "port-scan" }),
        signal({ detector: "brute-force" }),
        signal({ detector: "post-compromise", severity: "critical" }),
      ],
      { now: NOW },
    );
    expect(incidents[0].stage).toBe("persistence");
  });

  test("confirmed requires a breach or a foothold — volume never confirms", () => {
    const loud = correlate([signal({ count: 100000 })], { now: NOW });
    expect(loud[0].confidence).not.toBe("confirmed");

    const breached = correlate(
      [signal({ detector: "successful-after-fail", severity: "critical" })],
      { now: NOW },
    );
    expect(breached[0].confidence).toBe("confirmed");
  });

  test("corroboration raises confidence", () => {
    expect(correlate([signal({})], { now: NOW })[0].confidence).toBe("low");
    expect(
      correlate([signal({}), signal({ detector: "port-scan" })], { now: NOW })[0].confidence,
    ).toBe("medium");
  });

  test("the narrative reads in kill-chain order", () => {
    const incidents = correlate(
      [
        signal({ detector: "brute-force", summary: "tried 200 passwords" }),
        signal({ detector: "port-scan", summary: "scanned the box" }),
      ],
      { now: NOW },
    );
    expect(incidents[0].narrative.indexOf("scanned")).toBeLessThan(
      incidents[0].narrative.indexOf("passwords"),
    );
  });

  test("recommendations name real tools, never freeform advice", () => {
    const incidents = correlate([signal({})], { now: NOW });
    expect(incidents[0].recommendations[0]).toContain("harden_firewall");
  });

  test("an incident of only spoofable signals is flagged as un-actionable", () => {
    const incidents = correlate([signal({ detector: "firewall-drop-storm", spoofable: true })], {
      now: NOW,
    });
    expect(incidents[0].spoofableOnly).toBe(true);
  });

  test("one spoofable signal among real ones does not make it un-actionable", () => {
    const incidents = correlate(
      [signal({ detector: "firewall-drop-storm", spoofable: true }), signal({})],
      { now: NOW },
    );
    expect(incidents[0].spoofableOnly).toBe(false);
  });

  test("the id is stable across runs for the same source and day", () => {
    const a = correlate([signal({})], { now: NOW })[0].id;
    const b = correlate([signal({})], { now: NOW })[0].id;
    expect(a).toBe(b);
    expect(a).toBe(incidentId("203.0.113.7", Math.floor((NOW - MIN) / 86_400_000)));
  });

  test("worst first", () => {
    const incidents = correlate(
      [
        signal({ source: "1.1.1.1", severity: "low", detector: "port-scan" }),
        signal({ source: "2.2.2.2", severity: "critical", detector: "successful-after-fail" }),
      ],
      { now: NOW },
    );
    expect(incidents[0].severity).toBe("critical");
  });

  test("merging escalates and never regresses the stage", () => {
    const breached = correlate(
      [signal({ detector: "successful-after-fail", severity: "critical" })],
      { now: NOW },
    )[0];
    const laterScan = correlate([signal({ detector: "port-scan", severity: "low" })], {
      now: NOW,
    })[0];
    const merged = mergeIncident(breached, laterScan);
    // An attacker who got in yesterday did not un-get-in today.
    expect(merged.stage).toBe("breach");
    expect(merged.confidence).toBe("confirmed");
    expect(merged.severity).toBe("critical");
  });

  test("merging de-duplicates evidence", () => {
    const withEvidence = correlate(
      [
        signal({
          evidence: [{ ts: NOW, device: "edge", message: "same", detector: "brute-force" }],
        }),
      ],
      { now: NOW },
    )[0];
    const merged = mergeIncident(withEvidence, withEvidence);
    expect(merged.evidence).toHaveLength(1);
  });
});
