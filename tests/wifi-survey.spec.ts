import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { runWifiSurvey } from "../src/core/wifi-survey";
import { quoteValue } from "../src/core/routeros";
import type { ToolContext } from "../src/core/context";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: run }));
const ctx: ToolContext = { device: "home-ax3", info: vi.fn(), error: vi.fn() };
const report = "CHANNEL,FLAGS,NETWORKS,LOAD,NOISE-FLOOR\n5745,,2,7,-98";
beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset();
});
afterEach(() => vi.useRealTimers());
function replies(
  options: {
    lostLaunch?: boolean;
    failures?: number;
    header?: boolean;
    pending?: boolean;
    cleanup?: boolean;
  } = {},
) {
  let failures = options.failures ?? 0;
  run.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith(":execute")) {
      if (options.lostLaunch) throw new Error("SSH connection lost: EADDRNOTAVAIL");
      return "*a1";
    }
    if (cmd.startsWith("/file remove")) {
      if (options.cleanup) throw new Error("offline");
      return "";
    }
    if (failures-- > 0) throw new Error("offline");
    if (options.pending) return "MCP-SURVEY-PENDING";
    if (cmd.includes("-status.txt")) return "MCP-SURVEY-DONE\r\n";
    return options.header ? "CHANNEL,FLAGS,NETWORKS,LOAD,NOISE-FLOOR" : report;
  });
}
async function invoke() {
  const promise = runWifiSurvey("/interface wifi", 'wifi "5GHz"', 5, ctx);
  await vi.advanceTimersByTimeAsync(70000);
  return promise;
}
describe("router-owned Wi-Fi survey", () => {
  test("survives lost launch acknowledgement and transient read failures without relaunch", async () => {
    replies({ lostLaunch: true, failures: 3 });
    expect(await invoke()).toContain(report);
    const launches = run.mock.calls.filter(([cmd]) => cmd.startsWith(":execute"));
    expect(launches).toHaveLength(1);
    expect(launches[0][0]).toContain("frequency-scan");
    expect(launches[0][0]).not.toContain("as-string");
    // The script is quoted as a whole, including the already-escaped interface.
    expect(launches[0][0]).toContain(quoteValue(quoteValue('wifi "5GHz"')).slice(1, -1));
    expect(run.mock.calls.filter(([cmd]) => cmd.startsWith("/file remove"))).toHaveLength(2);
  });
  test("deadline preserves files and never deletes or relaunches pending job", async () => {
    replies({ pending: true });
    const result = await invoke();
    expect(result).toContain("recovery deadline");
    expect(result).toContain("-status.txt");
    expect(run.mock.calls.filter(([cmd]) => cmd.startsWith(":execute"))).toHaveLength(1);
    expect(run.mock.calls.some(([cmd]) => cmd.startsWith("/file remove"))).toBe(false);
  });
  test("header-only completed reports are not successful", async () => {
    replies({ header: true });
    expect(await invoke()).toContain("no channel measurements");
  });
  test("cleanup failure retains report and names exact files", async () => {
    replies({ cleanup: true });
    const result = await invoke();
    expect(result).toContain(report);
    expect(result).toContain("manual cleanup");
  });
  test("explicit launch rejection fails without polling or rescanning", async () => {
    run.mockResolvedValue("failure: not enough permissions");
    expect(await invoke()).toContain("Failed to start");
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("background job error is reported rather than a partial report", async () => {
    replies();
    const base = run.getMockImplementation()!;
    run.mockImplementation((cmd: string) =>
      cmd.startsWith(":local") && cmd.includes("-status.txt") ? "MCP-SURVEY-FAILED" : base(cmd),
    );
    expect(await invoke()).toContain("background job failed");
  });
});
