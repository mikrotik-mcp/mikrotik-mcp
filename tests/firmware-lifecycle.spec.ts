import { describe, expect, test } from "vite-plus/test";
import type { FirmwareState, HealthSnapshot } from "../src/core/firmware-lifecycle";
import {
  assessUpgradeReadiness,
  compareHealthSnapshots,
  compareVersions,
  isUpgradeAvailable,
  parseVersion,
  renderFirmwareStatus,
  renderFleetFirmwareCheck,
  renderHealthDiff,
  renderHealthSnapshot,
  renderReadiness,
} from "../src/core/firmware-lifecycle";

function firmware(): FirmwareState {
  return {
    rosVersion: "7.16.2",
    architecture: "arm64",
    boardName: "hAP ax3",
    uptime: "3d",
    cpuLoad: "12%",
    freeMemory: "400MiB",
    totalMemory: "1GiB",
    packages: [
      { name: "routeros", version: "7.16.2", disabled: false },
      { name: "wifi", version: "7.16.2", disabled: true },
    ],
    routerboard: {
      model: "hAP ax3",
      serialNumber: "TEST",
      currentFirmware: "7.16.2",
      upgradeFirmware: "7.16.2",
      firmwareUpgradeAvailable: false,
    },
    updateInfo: {
      channel: "stable",
      installedVersion: "7.16.2",
      latestVersion: "7.17",
      updateAvailable: true,
    },
  };
}

function snapshot(): HealthSnapshot {
  return {
    timestamp: "2026-10-24T00:00:00Z",
    version: "7.16.2",
    uptime: "3d",
    cpuLoad: "10%",
    freeMemory: "400MiB",
    totalMemory: "1GiB",
    routeCount: 100,
    activeInterfaces: 8,
    totalInterfaces: 10,
    healthSensors: "",
    pppSessions: 5,
    dhcpLeases: 20,
  };
}

describe("firmware lifecycle decisions", () => {
  test("parses stable and prerelease versions and rejects malformed input", () => {
    expect(parseVersion(" 7.16.2 (stable) ")).toMatchObject({
      major: 7,
      minor: 16,
      patch: 2,
      suffix: "",
      raw: "7.16.2",
    });
    expect(parseVersion("7.17beta3")).toMatchObject({ patch: 0, suffix: "beta3" });
    expect(parseVersion("7.17-rc1")).toMatchObject({ suffix: "rc1" });
    expect(parseVersion("7.17.testing")).toMatchObject({ suffix: "testing" });
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion("broken")).toBeNull();
  });

  test("compares major, minor, patch and prerelease ordering without treating equality as an update", () => {
    const v = (raw: string) => parseVersion(raw)!;
    expect(compareVersions(v("6.49.17"), v("7.1"))).toBeLessThan(0);
    expect(compareVersions(v("7.15"), v("7.16"))).toBeLessThan(0);
    expect(compareVersions(v("7.16.1"), v("7.16.2"))).toBeLessThan(0);
    expect(compareVersions(v("7.17beta3"), v("7.17rc1"))).toBeLessThan(0);
    expect(compareVersions(v("7.17rc1"), v("7.17"))).toBeLessThan(0);
    expect(compareVersions(v("7.17"), v("7.17"))).toBe(0);
    expect(isUpgradeAvailable(v("7.16"), v("7.17"))).toBe(true);
    expect(isUpgradeAvailable(v("7.17"), v("7.17"))).toBe(false);
    expect(isUpgradeAvailable(null, v("7.17"))).toBe(false);
    expect(isUpgradeAvailable(v("7.17"), null)).toBe(false);
  });

  test("readiness stays blocked without verified availability, even when CPU and memory are healthy", () => {
    const state = firmware();
    state.updateInfo = null;
    const checks = assessUpgradeReadiness(state);
    expect(checks.find((c) => c.label === "Update availability")?.status).toBe("blocked");
    expect(renderReadiness(checks)).toContain("UPGRADE READINESS: BLOCKED");
    state.updateInfo = {
      channel: "stable",
      installedVersion: "7.16.2",
      latestVersion: "7.16.2",
      updateAvailable: false,
    };
    expect(assessUpgradeReadiness(state)[0]).toMatchObject({ status: "blocked" });
  });

  test("readiness warns for high CPU, low free memory, major version jumps and board firmware", () => {
    const state = firmware();
    state.cpuLoad = "81%";
    state.freeMemory = "100MiB";
    state.updateInfo!.latestVersion = "8.0";
    state.routerboard!.firmwareUpgradeAvailable = true;
    state.routerboard!.upgradeFirmware = "8.0";
    const checks = assessUpgradeReadiness(state);
    expect(checks.filter((c) => c.status === "caution").map((c) => c.label)).toEqual([
      "CPU load",
      "Free memory",
      "Major version jump",
      "RouterBOARD firmware",
    ]);
    expect(renderReadiness(checks)).toContain("PROCEED WITH CAUTION");
    expect(renderReadiness([{ label: "update", status: "ready" }])).toContain(
      "UPGRADE READINESS: READY",
    );
  });

  test("unparseable memory does not invent a memory warning", () => {
    const state = firmware();
    state.freeMemory = "unknown";
    state.totalMemory = "unknown";
    expect(assessUpgradeReadiness(state).some((c) => c.label === "Free memory")).toBe(false);
  });

  test("health comparison tolerates small route drift but detects meaningful loss", () => {
    const pre = snapshot();
    const post = { ...pre, version: "7.17", routeCount: 91, dhcpLeases: 19 };
    const okay = compareHealthSnapshots(pre, post);
    expect(okay.healthy).toBe(true);
    expect(okay.neutral).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Route count stable"),
        expect.stringContaining("DHCP leases"),
      ]),
    );
    expect(okay.improvements).toEqual(
      expect.arrayContaining([expect.stringContaining("RouterOS version")]),
    );
    const bad = compareHealthSnapshots(pre, {
      ...post,
      activeInterfaces: 7,
      routeCount: 80,
      pppSessions: 4,
    });
    expect(bad.healthy).toBe(false);
    expect(bad.issues).toHaveLength(3);
    expect(renderHealthDiff(bad)).toContain("ISSUES DETECTED");
    expect(renderHealthSnapshot(post, "AFTER")).toContain("91");
  });

  test("status and fleet reports keep update, package and failure evidence distinct", () => {
    const state = firmware();
    const status = renderFirmwareStatus(state, "home");
    expect(status).toContain("FIRMWARE STATUS — home");
    expect(status).toContain("UPDATE AVAILABLE");
    expect(status).toContain("wifi");
    expect(status).toContain("(disabled)");
    const fleet = renderFleetFirmwareCheck([
      { name: "home", state },
      { name: "offline", state: null, error: "SSH timeout" },
      { name: "unknown", state: null },
      {
        name: "current",
        state: { ...state, updateInfo: { ...state.updateInfo!, updateAvailable: false } },
      },
    ]);
    expect(fleet).toContain("Needs update:      1");
    expect(fleet).toContain("Errors:            2");
    expect(fleet).toContain("SSH timeout");
    expect(fleet).toContain("No data");
    expect(fleet).toContain("UPGRADE CANDIDATES");
  });
});
