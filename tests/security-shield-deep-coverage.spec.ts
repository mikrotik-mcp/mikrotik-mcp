import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { securityShieldTools } from "../src/tools/security-shield";

const mocks = vi.hoisted(() => ({
  command: vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>(),
  enable: vi.fn<() => Promise<string>>(),
  execute: vi.fn<(cmd: string) => Promise<string>>(),
  rollback: vi.fn<() => Promise<void>>(),
  commit: vi.fn<() => Promise<{ ok: boolean; message: string }>>(),
  mac: false,
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  resolveDeviceName: () => "fixture",
  getDevice: () => ({ mac: mocks.mac ? "00:11:22:33:44:55" : undefined }),
}));
vi.mock("../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => mocks,
}));

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = securityShieldTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  const parsed =
    name === "harden_firewall"
      ? {
          ...z.object(tool.inputSchema ?? {}).parse({ ...args, protections: undefined }),
          protections: args.protections,
        }
      : z.object(tool.inputSchema ?? {}).parse(args);
  return tool.handler(parsed as never, ctx);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mac = false;
  mocks.command.mockResolvedValue("");
  mocks.enable.mockResolvedValue("Safe Mode enabled");
  mocks.execute.mockResolvedValue("");
  mocks.commit.mockResolvedValue({ ok: true, message: "committed" });
});

describe("Security Shield handlers", () => {
  test("preview orders trusted accept before drops and never touches device", async () => {
    const result = await run("harden_firewall", { preset: "basic", trusted_sources: "admins" });
    if (typeof result !== "string") throw new Error("Expected a preview string");
    expect(result).toContain("DRY RUN");
    expect(result.indexOf("# trusted")).toBeLessThan(result.indexOf("# state_hygiene"));
    expect(result).toContain("src-address-list=admins");
    expect(result).toContain("security-shield:");
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  test("rejects missing WAN and unsafe drops before applying", async () => {
    expect(
      await run("harden_firewall", { preset: "custom", protections: { anti_spoof: true } }),
    ).toContain("requires `wan_interface`");
    expect(await run("harden_firewall", { preset: "basic", apply: true })).toContain(
      "Refusing to apply input-chain drops",
    );
    expect(mocks.command).not.toHaveBeenCalled();
  });

  test("empty custom selection has no device side effects", async () => {
    expect(await run("harden_firewall", { preset: "custom", apply: true })).toContain(
      "No protections selected",
    );
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  test("safe mode commits all generated commands in order", async () => {
    const result = await run("harden_firewall", {
      preset: "custom",
      protections: { icmp_limit: true },
      apply: true,
    });
    expect(result).toContain("2 rule(s)");
    expect(result).toContain("committed via Safe Mode");
    expect(mocks.execute.mock.calls.map(([cmd]) => cmd)).toEqual([
      expect.stringContaining("action=accept"),
      expect.stringContaining("action=drop"),
    ]);
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.command).not.toHaveBeenCalled();
  });

  test("failed rule rolls back and does not commit", async () => {
    mocks.execute.mockResolvedValueOnce("").mockResolvedValueOnce("failure: denied");
    const result = await run("harden_firewall", {
      preset: "custom",
      protections: { icmp_limit: true },
      apply: true,
    });
    expect(result).toContain("Applied 1/2 rules, then FAILED");
    expect(result).toContain("rolled back");
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  test("failed safe mode entry and failed commit are reported", async () => {
    mocks.enable.mockResolvedValueOnce("Error: unavailable");
    expect(
      await run("harden_firewall", {
        preset: "custom",
        protections: { icmp_limit: true },
        apply: true,
      }),
    ).toContain("Could not enter Safe Mode");
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.commit.mockResolvedValueOnce({ ok: false, message: "lost session" });
    expect(
      await run("harden_firewall", {
        preset: "custom",
        protections: { icmp_limit: true },
        apply: true,
      }),
    ).toContain("COMMIT FAILED");
  });

  test("MAC device applies directly and reports partial failure", async () => {
    mocks.mac = true;
    mocks.command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: denied");
    const result = await run("harden_firewall", {
      preset: "custom",
      protections: { icmp_limit: true },
      apply: true,
    });
    expect(result).toContain("Partial rules remain");
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.command).toHaveBeenCalledTimes(2);
  });

  test("audit checks both tables and reports detected protections", async () => {
    mocks.command
      .mockResolvedValueOnce("security-shield: brute-force\nconnection-state=established")
      .mockResolvedValueOnce("security-shield: raw drop");
    const result = await run("audit_firewall_hardening");
    expect(result).toContain("✅ Brute-force ladder");
    expect(result).toContain("✅ Raw pre-conntrack drops");
    expect(result).toContain("❌ Management lock-down");
    expect(mocks.command.mock.calls.map(([cmd]) => cmd)).toEqual([
      "/ip firewall filter print",
      "/ip firewall raw print",
    ]);
  });

  test("removal counts both tables and stops on device error", async () => {
    mocks.command
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("");
    expect(await run("remove_firewall_hardening")).toContain("Removed 3 Security Shield rule(s)");
    expect(mocks.command.mock.calls[1]?.[0]).toContain("filter remove [find comment~");
    expect(mocks.command.mock.calls[3]?.[0]).toContain("raw remove [find comment~");
    mocks.command.mockClear();
    mocks.command.mockResolvedValueOnce("2").mockResolvedValueOnce("failure: denied");
    expect(await run("remove_firewall_hardening")).toContain("Failed removing filter rules");
    expect(mocks.command).toHaveBeenCalledTimes(2);
  });

  test("zero or invalid counts do not issue remove commands", async () => {
    mocks.command.mockResolvedValueOnce("0").mockResolvedValueOnce("not a number");
    expect(await run("remove_firewall_hardening")).toContain("No Security Shield rules found");
    expect(mocks.command.mock.calls.every(([cmd]) => cmd.includes("count-only"))).toBe(true);
  });
});
