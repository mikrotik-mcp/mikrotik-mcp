import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { changePlanTools } from "../src/tools/change-plan";

const mocks = vi.hoisted(() => ({
  enable: vi.fn(),
  execute: vi.fn(),
  rollback: vi.fn(),
  commit: vi.fn(),
  isActive: false,
  device: vi.fn(),
  resolve: vi.fn(),
  /** One-shot connection: exports, the reachability check, direct writes. */
  direct: vi.fn<(command: string, ctx: ToolContext) => Promise<string>>(),
  snapshot: vi.fn(),
}));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: () => mocks }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.direct }));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: mocks.snapshot }));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  getDevice: mocks.device,
  resolveDeviceName: mocks.resolve,
}));
const ctx: ToolContext = { device: "offline", info: vi.fn(), error: vi.fn(), risk: "DANGEROUS" };
const add = "/ip address add address=192.0.2.1/32 interface=lo";
const remove = "/ip address remove [find address=192.0.2.2/32]";
const BEFORE = "/ip address add address=192.0.2.9/32";
const AFTER = `${BEFORE}\n/ip address add address=192.0.2.1/32 interface=lo`;

/** Run a tool call to completion under fake timers (the read-back settle delay). */
async function call(name: string, args: Record<string, unknown>) {
  const tool = changePlanTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  const settled = Promise.resolve(tool.handler(args as never, ctx)).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(10_000);
  const outcome = await settled;
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

/** Exports served by the one-shot connection, in order; the last one repeats. */
function exportsReturn(...bodies: string[]): void {
  let i = 0;
  mocks.direct.mockImplementation(async (command) => {
    if (command === "/export terse") return bodies[Math.min(i++, bodies.length - 1)];
    return "name: offline";
  });
}
const directCommands = () => mocks.direct.mock.calls.map(([command]) => command);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.isActive = false;
  mocks.device.mockReturnValue({ host: "localhost" });
  mocks.resolve.mockReturnValue("offline");
  mocks.enable.mockResolvedValue("Safe Mode enabled");
  mocks.execute.mockResolvedValue("");
  mocks.rollback.mockResolvedValue("rolled back");
  mocks.commit.mockResolvedValue({ ok: true, message: "saved" });
  mocks.snapshot.mockResolvedValue("snap_1");
  exportsReturn(BEFORE, AFTER, BEFORE);
});
afterEach(() => vi.useRealTimers());

test("preview merges array and script, ignores comments, and reorders destructive steps", async () => {
  const result = await call("plan_changes", {
    commands: [` ${remove} `, "  "],
    script: `# note\n${add}`,
  });
  expect(result).toMatchObject({ structuredContent: { counts: { total: 2 }, reordered: true } });
  expect(JSON.stringify(result)).toContain("Plan: +1 to add");
  expect(mocks.enable).not.toHaveBeenCalled();
});

test("empty inputs cause no device or safe-mode work", async () => {
  expect(await call("plan_changes", { script: "# comment" })).toBe("No commands provided to plan.");
  expect(await call("apply_plan", { commands: ["  "] })).toBe("No commands provided to apply.");
  expect(mocks.device).not.toHaveBeenCalled();
});

test("MAC-Telnet target is rejected before enabling Safe Mode", async () => {
  mocks.device.mockReturnValue({ mac: "00:11:22:33:44:55" });
  await expect(call("apply_plan", { commands: [add] })).rejects.toThrow("requires SSH");
  expect(mocks.enable).not.toHaveBeenCalled();
});

test("failed Safe Mode enable is an error with no commands applied", async () => {
  mocks.enable.mockResolvedValue("Error: busy");
  await expect(call("apply_plan", { commands: [add] })).rejects.toThrow("Error: busy");
  expect(mocks.execute).not.toHaveBeenCalled();
});

test("exports and the reachability check never go through the Safe Mode shell", async () => {
  const result = await call("apply_plan", { commands: [remove, add], confirm: false });
  expect(result).toContain("DRY-RUN");
  expect(result).toContain("identical to the pre-change export");
  // Only the writes use the Safe Mode shell, in safe order.
  expect(mocks.execute.mock.calls.map(([cmd]) => cmd)).toEqual([add, remove]);
  expect(directCommands()).toEqual([
    "/export terse",
    "/export terse",
    "/system identity print",
    "/export terse",
  ]);
  // …and they carry READ risk, which is what keeps the connector off that shell.
  expect(mocks.direct.mock.calls.every(([, readCtx]) => readCtx.risk === "READ")).toBe(true);
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
  expect(mocks.commit).not.toHaveBeenCalled();
});

test("step failure closes the session and reports the real device state", async () => {
  mocks.execute.mockResolvedValue("failure: denied");
  exportsReturn(BEFORE);
  const error = await call("apply_plan", { commands: [add], confirm: true }).catch(String);
  expect(error).toMatch(/step .* failed/);
  expect(error).toContain("identical to the pre-change export");
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
  expect(mocks.commit).not.toHaveBeenCalled();
});

test("a timeout during a step reports a change that is still on the device", async () => {
  mocks.execute.mockRejectedValue(new Error("did not return a recognized prompt"));
  exportsReturn(BEFORE, AFTER); // read-back keeps showing the change
  const error = await call("apply_plan", { commands: [add], confirm: true }).catch(String);
  expect(error).toContain("did not return a recognized prompt");
  expect(error).toContain("differs from the pre-change export (+1/-0)");
  expect(error).toContain("+/ip address add address=192.0.2.1/32 interface=lo");
});

test("an unreadable device after a failure is reported as such, not as reverted", async () => {
  mocks.execute.mockRejectedValue(new Error("timeout"));
  mocks.direct.mockResolvedValueOnce(BEFORE).mockRejectedValue(new Error("connect ECONNREFUSED"));
  const error = await call("apply_plan", { commands: [add], confirm: true }).catch(String);
  expect(error).toContain("could not be read");
});

test("unreachable device rolls back rather than committing", async () => {
  mocks.direct.mockImplementation(async (command) => {
    if (command === "/system identity print") throw new Error("connect timeout");
    return BEFORE;
  });
  await expect(call("apply_plan", { commands: [add], confirm: true })).rejects.toThrow("ABORTED");
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
  expect(mocks.commit).not.toHaveBeenCalled();
});

test("successful commit reports COMMITTED and leaves the session alone", async () => {
  expect(await call("apply_plan", { commands: [add], confirm: true })).toContain("COMMITTED");
  expect(mocks.rollback).not.toHaveBeenCalled();
});

test("a commit whose confirmation is lost is verified by read-back: change kept", async () => {
  mocks.commit.mockResolvedValue({ ok: false, message: "no prompt seen after commit" });
  exportsReturn(BEFORE, AFTER); // still applied after the session closed
  const result = await call("apply_plan", { commands: [add], confirm: true });
  expect(result).toContain("COMMITTED: the commit confirmation was lost");
  expect(result).toContain("the change IS on the device");
});

test("a commit whose confirmation is lost is verified by read-back: change reverted", async () => {
  mocks.commit.mockResolvedValue({ ok: false, message: "no prompt seen after commit" });
  exportsReturn(BEFORE, AFTER, BEFORE);
  const error = await call("apply_plan", { commands: [add], confirm: true }).catch(String);
  expect(error).toContain("COMMIT FAILED");
  expect(error).toContain("identical to the pre-change export");
  // The message must not tell the client to call a recovery tool.
  expect(error).not.toMatch(/rollback_safe_mode|commit_safe_mode|safe_mode_status/);
});

test("a commit that does not take is retried once, then the session is closed", async () => {
  mocks.isActive = true; // still in Safe Mode after each failed commit
  mocks.commit.mockResolvedValue({ ok: false, message: "still in Safe Mode" });
  exportsReturn(BEFORE, AFTER, BEFORE);
  await expect(call("apply_plan", { commands: [add], confirm: true })).rejects.toThrow(
    "COMMIT FAILED",
  );
  expect(mocks.commit).toHaveBeenCalledTimes(2);
  expect(mocks.rollback).toHaveBeenCalledTimes(1);
});

test("use_safe_mode=false needs confirm=true and applies nothing without it", async () => {
  const result = await call("apply_plan", { commands: [add], use_safe_mode: false });
  expect(result).toContain("NOT APPLIED");
  expect(mocks.direct).not.toHaveBeenCalled();
  expect(mocks.snapshot).not.toHaveBeenCalled();
});

test("use_safe_mode=false snapshots first, writes directly, then reads back", async () => {
  const result = await call("apply_plan", { commands: [add], use_safe_mode: false, confirm: true });
  expect(mocks.enable).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  expect(mocks.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.direct.mock.invocationCallOrder[0],
  );
  expect(directCommands()).toEqual(["/export terse", add, "/export terse"]);
  expect(result).toContain("Restore point: snapshot snap_1");
  expect(result).toContain("differs from the pre-change export (+1/-0)");
  expect(result).toContain("APPLIED");
});

test("use_safe_mode=false stops at the first failed step and says what stayed applied", async () => {
  mocks.direct.mockImplementation(async (command) => {
    if (command === "/export terse") return BEFORE;
    return command === remove ? "failure: no such item" : "";
  });
  const error = await call("apply_plan", {
    commands: [add, remove],
    use_safe_mode: false,
    confirm: true,
  }).catch(String);
  expect(error).toContain("Executed 1 of 2 step(s)");
  expect(error).toMatch(/step 2 failed/);
  expect(error).toContain("nothing was rolled back");
});

test("use_safe_mode=false refuses while a Safe Mode session is open", async () => {
  mocks.isActive = true;
  await expect(
    call("apply_plan", { commands: [add], use_safe_mode: false, confirm: true }),
  ).rejects.toThrow("Safe Mode session is open");
  expect(mocks.direct).not.toHaveBeenCalled();
});
