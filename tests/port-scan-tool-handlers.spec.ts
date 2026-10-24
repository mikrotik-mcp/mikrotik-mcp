import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { portScanDetectionTools } from "../src/tools/port-scan-detection";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  rules: vi.fn(),
  count: vi.fn(),
  ids: vi.fn(),
  snapshot: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/utils/firewall-query", () => ({
  fetchFilterChainRules: mocks.rules,
  addressListCount: mocks.count,
  filterChainRuleIds: mocks.ids,
}));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: mocks.snapshot }));
vi.mock("../src/utils/safe-mode-apply", () => ({ applyWritesSafely: mocks.apply }));

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();
const args = {
  rule_types: ["psd_generic"],
  trusted_list_name: "Trust-IP",
  address_list_name: "port scanners",
  address_list_timeout: "2w",
  confirm: true,
  confirmed_trusted_list_includes_my_ip: true,
};

async function call(name: string, overrides: Record<string, unknown> = {}) {
  const tool = portScanDetectionTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler({ ...args, ...overrides } as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.rules.mockResolvedValue([]);
  mocks.count.mockResolvedValue(2);
  mocks.ids.mockResolvedValue(["*1", "*2"]);
  mocks.snapshot.mockResolvedValue("snap-1");
  mocks.apply.mockResolvedValue({ safeMode: "committed", applied: 2, total: 2, fellBack: false });
  mocks.command.mockResolvedValue("0 chain=detect-portscan action=add-src-to-address-list");
});
afterEach(() => setConfig(initial));

test("signature catalog marks configured device presence without writing", async () => {
  const output = await call("list_port_scan_detection_signatures");
  expect(output).toContain("psd_generic");
  expect(output).toContain("[not present]");
  expect(mocks.rules).toHaveBeenCalledWith("detect-portscan", ctx);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

test("missing trusted list refuses request before snapshot or Safe Mode", async () => {
  mocks.count.mockResolvedValue(0);
  const output = await call("add_port_scan_detection_rules");
  expect(output).toContain("Port-scan detection refused");
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

test("approved request snapshots, applies scoped tag rules and reports verification", async () => {
  const output = await call("add_port_scan_detection_rules");
  expect(output).toContain("snapshot=snap-1");
  expect(output).toContain("Signatures added (1): psd_generic");
  expect(output).toContain("NO default-deny");
  expect(mocks.snapshot).toHaveBeenCalledWith(ctx, "pre-add_port_scan_detection_rules");
  expect(mocks.apply).toHaveBeenCalledOnce();
  const [deviceContext, device, commands, options] = mocks.apply.mock.calls[0];
  expect(deviceContext).toBe(ctx);
  expect(device).toBe("fixture");
  expect(commands).toHaveLength(2);
  expect(commands.join("\n")).toContain("add-src-to-address-list");
  expect(commands.join("\n")).toContain("!Trust-IP");
  expect(options).toEqual({ allowDirectFallback: true });
});

test("fallback and partial failure are disclosed with the snapshot rollback point", async () => {
  mocks.apply.mockResolvedValueOnce({ safeMode: "direct", applied: 2, total: 2, fellBack: true });
  expect(await call("add_port_scan_detection_rules")).toContain("Safe Mode was not usable");
  mocks.apply.mockResolvedValueOnce({
    safeMode: "direct",
    applied: 1,
    total: 2,
    fellBack: true,
    error: "link lost",
  });
  const failure = await call("add_port_scan_detection_rules");
  expect(failure).toContain("FAILED after 1/2 write(s): link lost");
  expect(failure).toContain("Partial state may be applied");
  expect(failure).toContain("snap-1");
});
