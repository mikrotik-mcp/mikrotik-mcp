import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createContext } from "../../src/core/context";
import { readCapsmanManagers, setCapsmanManager } from "../../src/observability/capsman-manager";

const { run, snapshot, apply, session } = vi.hoisted(() => ({
  run: vi.fn(),
  snapshot: vi.fn(),
  apply: vi.fn(),
  session: { isActive: false },
}));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: run }));
vi.mock("../../src/snapshots/capture", () => ({ captureSnapshot: snapshot }));
vi.mock("../../src/utils/safe-mode-apply", () => ({ applyWritesSafely: apply }));
vi.mock("../../src/ssh/safe-mode", () => ({ getSafeModeManager: () => session }));
vi.mock("../../src/core/runtime", () => ({
  resolveDeviceName: (name: string) => {
    if (!["home", "remote"].includes(name)) throw new Error("Unknown device");
    return name;
  },
}));
const ctx = createContext(undefined, "remote");
const input = { device: "remote", path: "/interface wifi capsman", enabled: true, confirm: true };
beforeEach(() => {
  vi.clearAllMocks();
  session.isActive = false;
  run.mockReset();
  snapshot.mockReset().mockResolvedValue("snapshot-test");
  apply.mockReset().mockResolvedValue({ committed: true, applied: 1, safeMode: "committed" });
});

test("discovers independent modern and legacy managers, including a disabled manager", async () => {
  run.mockResolvedValueOnce("enabled: no\r\n").mockResolvedValueOnce("enabled: yes");
  expect(await readCapsmanManagers(ctx)).toEqual([
    { path: "/interface wifi capsman", label: "WiFi CAPsMAN", enabled: false },
    { path: "/caps-man manager", label: "Legacy CAPsMAN", enabled: true },
  ]);
  expect(run.mock.calls.map(([cmd]) => cmd)).toEqual([
    "/interface wifi capsman print",
    "/caps-man manager print",
  ]);
  expect(run.mock.calls.every(([, context]) => context === ctx)).toBe(true);
});
test("supports wifiwave2 and returns no controls on an unsupported router", async () => {
  run
    .mockResolvedValueOnce("bad command name wifi")
    .mockResolvedValueOnce("enabled: no")
    .mockResolvedValueOnce("bad command name caps-man");
  expect(await readCapsmanManagers(ctx)).toEqual([
    { path: "/interface wifiwave2 capsman", label: "WiFiWave2 CAPsMAN", enabled: false },
  ]);
  run.mockResolvedValue("bad command name");
  expect(await readCapsmanManagers(ctx)).toEqual([]);
});
test.each(["", "failure: not enough permissions", "enabled: unknown", "expected end of command"])(
  "does not report unreadable status as disabled: %s",
  async (out) => {
    run.mockResolvedValue(out);
    await expect(readCapsmanManagers(ctx)).rejects.toThrow();
  },
);
test("preserves connection errors for the shared device-disconnected response", async () => {
  const error = new Error("Device disconnected");
  run.mockRejectedValue(error);
  await expect(readCapsmanManagers(ctx)).rejects.toBe(error);
});
test.each(["/interface wifi capsman", "/interface wifiwave2 capsman", "/caps-man manager"])(
  "snapshots, applies only the enabled flag in Safe Mode and verifies %s",
  async (path) => {
    run.mockResolvedValueOnce("enabled: yes").mockResolvedValueOnce("enabled: no");
    expect(await setCapsmanManager(ctx, { ...input, path, enabled: false })).toMatchObject({
      ok: true,
      snapshotId: "snapshot-test",
      manager: { enabled: false },
    });
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(ctx, "pre-capsman-manager", true);
    expect(apply).toHaveBeenCalledExactlyOnceWith(ctx, "remote", [`${path} set enabled=no`], {
      allowDirectFallback: false,
    });
    expect(snapshot.mock.invocationCallOrder[0]).toBeLessThan(apply.mock.invocationCallOrder[0]);
    expect(run.mock.calls.map(([cmd]) => cmd)).toEqual([`${path} print`, `${path} print`]);
  },
);
test("enables and treats the same desired state as a no-op", async () => {
  run.mockResolvedValueOnce("enabled: no").mockResolvedValue("enabled: yes");
  expect(await setCapsmanManager(ctx, input)).toMatchObject({ ok: true });
  expect(apply.mock.calls[0][2]).toEqual(["/interface wifi capsman set enabled=yes"]);
  vi.clearAllMocks();
  expect(await setCapsmanManager(ctx, input)).toMatchObject({ ok: true, applied: 0 });
  expect(snapshot).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});
test.each([
  { device: "" },
  { device: "typo" },
  { device: "home" },
  { confirm: false },
  { enabled: "yes" },
  { path: "/system reboot" },
])("refuses unsafe or mismatched input %j before I/O", async (change) => {
  await expect(setCapsmanManager(ctx, { ...input, ...change })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});
test("requires supported settings, a complete snapshot and no existing Safe Mode session", async () => {
  run.mockResolvedValueOnce("bad command name");
  expect(await setCapsmanManager(ctx, input)).toMatchObject({ ok: false });
  run.mockResolvedValue("enabled: no");
  session.isActive = true;
  expect(await setCapsmanManager(ctx, input)).toMatchObject({
    ok: false,
    error: expect.stringContaining("active Safe Mode"),
  });
  session.isActive = false;
  snapshot.mockRejectedValue(new Error("Incomplete export"));
  await expect(setCapsmanManager(ctx, input)).rejects.toThrow("Incomplete export");
  expect(apply).not.toHaveBeenCalled();
});
test("does not verify or retry after a Safe Mode failure or uncertain commit", async () => {
  run.mockResolvedValue("enabled: no");
  apply.mockResolvedValue({ committed: false, safeMode: "commit unclear" });
  expect(await setCapsmanManager(ctx, input)).toMatchObject({ ok: false, error: "commit unclear" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
});
test.each(["mismatch", "disconnected"])(
  "reports uncertain readback without replay: %s",
  async (failure) => {
    run.mockResolvedValueOnce("enabled: no");
    if (failure === "disconnected") run.mockRejectedValueOnce(new Error("disconnected"));
    else run.mockResolvedValueOnce("enabled: no");
    expect(await setCapsmanManager(ctx, input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Refresh before trying again"),
    });
    expect(apply).toHaveBeenCalledTimes(1);
  },
);
