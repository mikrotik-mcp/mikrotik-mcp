import { describe, expect, it } from "vite-plus/test";
import {
  blankFlight,
  logEvidence,
  trimFlight,
  freezeFlight,
  detectFlightIncident,
  recorderInput,
} from "../src/flight-recorder/model";
import type { FlightSample } from "../src/flight-recorder/model";
const sample = (at: number, reachable: boolean | null = true): FlightSample => ({
  at,
  finishedAt: at,
  reachable,
  interfaces: [],
  gaps: [],
});
describe("flight recorder evidence", () => {
  it("starts disabled and bounds collection settings", () => {
    expect(blankFlight("lab", 0).enabled).toBe(false);
    expect(recorderInput.safeParse({ enabled: true, intervalSeconds: 1 }).success).toBe(false);
    expect(recorderInput.safeParse({ enabled: true, retentionDays: 31 }).success).toBe(false);
  });
  it("never persists raw log messages or arbitrary credentials", () => {
    const e = logEvidence(
      {
        message: "user changed password=hunter2 token=secret",
        time: "12:00:00",
        topics: "system,info",
      },
      100,
    );
    expect(e.title).toContain("Configuration activity");
    expect(JSON.stringify(e)).not.toMatch(/hunter2|secret|password=/);
    expect(e.routerTime).toBe("12:00:00");
    expect(e.at).toBe(100);
    expect(logEvidence({ message: "link down" }, 1).id).toBe(
      logEvidence({ message: "link down" }, 2).id,
    );
  });
  it("requires two failures, never converts unknown into an outage", () => {
    const r = blankFlight("lab", 0);
    r.samples = [sample(1, false), sample(2, null)];
    expect(detectFlightIncident(r)).toBeUndefined();
    r.samples.push(sample(3, false));
    expect(detectFlightIncident(r)).toBeUndefined();
    r.samples.push(sample(4, false));
    expect(detectFlightIncident(r)?.trigger).toBe("management");
  });
  it("detects a down transition, not a port that has always been unused", () => {
    const r = blankFlight("lab", 0);
    r.samples = [
      { ...sample(1), interfaces: [{ name: "wan", running: true }] },
      { ...sample(2), interfaces: [{ name: "wan", running: false }] },
    ];
    expect(detectFlightIncident(r)?.trigger).toBe("interface");
    r.samples[0].interfaces[0].running = false;
    expect(detectFlightIncident(r)).toBeUndefined();
  });
  it("freezes independent evidence with a bounded post-window", () => {
    const r = blankFlight("lab", 0);
    r.enabled = true;
    r.samples = [sample(1)];
    const i = freezeFlight(r, "Example", "manual", 100);
    expect(i.until).toBe(120100);
    r.samples[0].reachable = false;
    expect(i.samples[0].reachable).toBe(true);
    trimFlight(r, 120101);
    expect(i.complete).toBe(true);
  });
  it("prunes by both age and count, and finalizes paused windows", () => {
    const r = blankFlight("lab", 1000000);
    r.samples = Array.from({ length: 800 }, (_, i) => sample(1000000 + i));
    r.events = Array.from({ length: 600 }, (_, i) => ({
      id: String(i),
      at: 1000000,
      source: "mcp" as const,
      title: "update_route",
    }));
    for (let i = 0; i < 40; i++) freezeFlight(r, "incident", "manual", 1000000 + i);
    trimFlight(r, 1000800);
    expect(r.samples).toHaveLength(720);
    expect(r.events).toHaveLength(500);
    expect(r.incidents).toHaveLength(30);
    trimFlight(r, 1000800 + 31 * 86400000);
    expect(r.samples).toHaveLength(0);
    expect(r.incidents).toHaveLength(0);
  });
});
