import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { hotspotBuilderTools } from "../src/tools/hotspot-builder";

const mocks = vi.hoisted(() => ({
  command: vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };

async function run(name: string, args: Record<string, unknown>) {
  const tool = hotspotBuilderTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args) as never, ctx);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.command.mockResolvedValue("");
});

describe("hotspot builder", () => {
  test("previews default network and optional garden without router I/O", async () => {
    const text = await run("build_guest_hotspot", {
      interface: "guest bridge",
      walled_garden: ["pay.example", "*.login.example"],
    });
    expect(text).toContain("DRY RUN");
    expect(text).toContain("8 command(s)");
    expect(text).toContain("ranges=10.5.50.10-10.5.50.254");
    expect(text).toContain('interface="guest bridge"');
    expect(text).toContain("dst-host=pay.example");
    expect(mocks.command).not.toHaveBeenCalled();
  });

  test("applies all commands in order with custom network", async () => {
    const text = await run("build_guest_hotspot", {
      interface: "guest",
      subnet: "192.0.2.0/24",
      gateway: "192.0.2.1",
      pool_range: "192.0.2.20-192.0.2.30",
      dns_name: "guest.example",
      rate_limit: "2M/2M",
      apply: true,
    });
    expect(text).toContain("Guest hotspot built");
    expect(mocks.command).toHaveBeenCalledTimes(6);
    expect(mocks.command.mock.calls[0]?.[0]).toContain("address=192.0.2.1/24");
    expect(mocks.command.mock.calls[1]?.[0]).toContain("ranges=192.0.2.20-192.0.2.30");
    expect(mocks.command.mock.calls[4]?.[0]).toContain("dns-name=guest.example");
  });

  test("stops after partial device failure", async () => {
    mocks.command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: pool conflict");
    expect(await run("build_guest_hotspot", { interface: "guest", apply: true })).toContain(
      "Built 1/6 commands, then FAILED",
    );
    expect(mocks.command).toHaveBeenCalledTimes(2);
  });

  test("voucher preview and applied codes use one code as name and password", async () => {
    expect(await run("generate_hotspot_vouchers", { count: 2 })).toContain(
      "DRY RUN — 2 voucher(s)",
    );
    expect(mocks.command).not.toHaveBeenCalled();
    const text = await run("generate_hotspot_vouchers", {
      count: 2,
      code_prefix: "vip-",
      uptime_limit: "1h",
      profile: "visitors",
      apply: true,
    });
    expect(text).toContain("Created 2 hotspot voucher(s) (1h each)");
    expect(mocks.command).toHaveBeenCalledTimes(2);
    for (const [cmd] of mocks.command.mock.calls) {
      const code = cmd.match(/name=(vip-[a-f0-9]{6})/)?.[1];
      expect(code).toBeDefined();
      expect(cmd).toContain(`password=${code}`);
      expect(cmd).toContain("limit-uptime=1h");
      expect(cmd).toContain("profile=visitors");
    }
  });

  test("voucher failure reports created count and count validation blocks I/O", async () => {
    mocks.command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: no space");
    expect(await run("generate_hotspot_vouchers", { count: 3, apply: true })).toContain(
      "Created 1/3 vouchers, then FAILED",
    );
    expect(mocks.command).toHaveBeenCalledTimes(2);
    await expect(run("generate_hotspot_vouchers", { count: 201, apply: true })).rejects.toThrow();
    expect(mocks.command).toHaveBeenCalledTimes(2);
  });
});
