import { describe, expect, test } from "vite-plus/test";
import { deviceTone, fleetSummary, fleetTone, resourceMeter } from "../raycast/src/lib/fleet-model";
import type { DeviceInfo } from "../raycast/src/lib/types";

const device = (
  name: string,
  reachable: boolean | undefined,
  cpuLoad = 0,
  disabled = false,
): DeviceInfo =>
  ({
    name,
    disabled,
    status: { reachable, cpuLoad },
  }) as DeviceInfo;

describe("Fleet Menu Bar model", () => {
  test("ranks attention before healthy routers without mutating input", () => {
    const devices = [
      device("healthy", true),
      device("unknown", undefined),
      device("hot", true, 90),
      device("offline", false),
      device("disabled", false, 0, true),
    ];
    const result = fleetSummary(devices);
    expect(result.sorted.map((d) => d.name)).toEqual(["offline", "hot", "unknown", "healthy"]);
    expect(result).toMatchObject({
      total: 4,
      online: 2,
      offline: 1,
      unknown: 1,
      stressed: 1,
      disabled: 1,
    });
    expect(devices[0].name).toBe("healthy");
  });
  test("does not count stale hot metrics on an offline router twice", () => {
    expect(fleetSummary([device("offline", false, 99)])).toMatchObject({ offline: 1, stressed: 0 });
    expect(deviceTone(device("pending", undefined, 99))).toBe("unknown");
  });
  test("handles absent and out-of-range resource samples", () => {
    expect(resourceMeter(undefined)).toBe("Not measured");
    expect(resourceMeter(Number.NaN)).toBe("Not measured");
    expect(resourceMeter(150)).toBe("▰▰▰▰▰  100%");
    expect(resourceMeter(-1)).toBe("▱▱▱▱▱  0%");
  });
  const base = {
    unavailable: false,
    stale: false,
    partial: false,
    total: 2,
    offline: 0,
    unknown: 0,
    stressed: 0,
    critical: false,
    warning: false,
  };
  test("never presents missing or failed observations as healthy", () => {
    expect(fleetTone(base)).toBe("healthy");
    expect(fleetTone({ ...base, total: 0 })).toBe("unknown");
    expect(fleetTone({ ...base, unknown: 1 })).toBe("unknown");
    expect(fleetTone({ ...base, stale: true })).toBe("warning");
    expect(fleetTone({ ...base, partial: true })).toBe("warning");
  });
  test("critical observations take precedence over warnings", () => {
    expect(fleetTone({ ...base, critical: true, warning: true })).toBe("critical");
    expect(fleetTone({ ...base, offline: 1 })).toBe("critical");
    expect(fleetTone({ ...base, unavailable: true })).toBe("critical");
  });
});
