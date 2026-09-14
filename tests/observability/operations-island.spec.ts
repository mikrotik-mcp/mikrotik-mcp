import { describe, expect, test } from "vite-plus/test";
import {
  islandSignal,
  isFreshSample,
  islandDeviceState,
  islandRecentEvents,
  islandAge,
} from "../../ui/observability/operations-island-model";
import type { DeviceInfo, SSHPoolPayload, ToolEvent } from "../../ui/observability/types";

const now = 1_800_000_000_000;
const event = (overrides: Partial<ToolEvent> = {}): ToolEvent => ({
  id: "event-1",
  ts: now,
  tool: "get_identity",
  title: "Get identity",
  risk: "READ",
  durationMs: 0,
  isError: false,
  input: "{}",
  output: "",
  outputBytes: 0,
  hasStructured: false,
  truncated: false,
  ...overrides,
});
const base = {
  mode: "ws" as const,
  paused: false,
  now,
  liveEvent: null,
  liveEventAt: now,
  pool: null,
  poolAt: null,
  alerts: null,
  alertsAt: null,
};
const pool: SSHPoolPayload = {
  enabled: true,
  config: { keepAlive: true, keepAliveInterval: 1, idleTimeout: 1 },
  devices: [],
  aggregate: { totalInflight: 3, totalBusy: 2, totalConnections: 2, totalIdle: 0 },
};

describe("Operations Island evidence and priorities", () => {
  test("offline and pause take precedence over stale successful events", () => {
    expect(islandSignal({ ...base, mode: "off", liveEvent: event() }).kind).toBe("offline");
    expect(islandSignal({ ...base, paused: true, liveEvent: event() }).kind).toBe("paused");
  });
  test("only a recent stream completion triggers a completion or error signal", () => {
    expect(islandSignal({ ...base, liveEvent: event() }).kind).toBe("completed");
    expect(islandSignal({ ...base, liveEvent: event({ isError: true }) }).kind).toBe("error");
    for (const liveEventAt of [null, now - 10_001, now + 1, Number.NaN])
      expect(islandSignal({ ...base, liveEventAt, liveEvent: event() }).kind).toBe("listening");
    expect(
      islandSignal({
        ...base,
        liveEvent: event({ ts: now - 240_000, durationMs: 240_000, isError: true }),
      }).kind,
    ).toBe("error");
  });
  test("alerts and inflight channels require fresh, positive observations", () => {
    expect(islandSignal({ ...base, alerts: 2, alertsAt: now }).count).toBe(2);
    expect(islandSignal({ ...base, alerts: 2, alertsAt: now - 45_001 }).kind).toBe("listening");
    expect(islandSignal({ ...base, pool, poolAt: now })).toMatchObject({ kind: "busy", count: 3 });
    expect(islandSignal({ ...base, pool, poolAt: now - 30_001 }).kind).toBe("listening");
    expect(islandSignal({ ...base, pool: { ...pool, enabled: false }, poolAt: now }).kind).toBe(
      "listening",
    );
  });
  test("missing, stale, future and disconnected device checks are not healthy", () => {
    const router = { status: { reachable: true, checkedAt: now } } as DeviceInfo;
    expect(islandDeviceState(router, now, true)).toBe("reachable");
    expect(islandDeviceState(router, now, false)).toBe("unknown");
    expect(islandDeviceState({ ...router, disabled: true }, now, true)).toBe("disabled");
    for (const checkedAt of [null, now - 120_001, now + 1])
      expect(
        islandDeviceState({ ...router, status: { ...router.status, checkedAt } }, now, true),
      ).toBe("unknown");
    expect(
      islandDeviceState({ ...router, status: { ...router.status, reachable: false } }, now, true),
    ).toBe("unreachable");
  });
  test("completion history is bounded, sorted and deduplicated without mutating the feed", () => {
    const feed = [
      event({ id: "old", ts: now - 100 }),
      event(),
      event(),
      event({ id: "future", ts: now + 1 }),
      ...[1, 2, 3, 4].map((i) => event({ id: String(i), ts: now - i })),
    ];
    expect(islandRecentEvents(feed, now).map((e) => e.id)).toEqual(["event-1", "1", "2", "3"]);
    expect(feed[0]?.id).toBe("old");
  });
  test("freshness and age never manufacture a timestamp", () => {
    for (const ts of [undefined, null, Number.NaN, 0, now + 1]) {
      expect(isFreshSample(ts, now)).toBe(false);
      expect(islandAge(ts, now)).toBe("Not observed");
    }
    expect(islandAge(now - 90_000, now)).toBe("1m ago");
    expect(islandAge(now, now)).toBe("Just now");
  });
});
