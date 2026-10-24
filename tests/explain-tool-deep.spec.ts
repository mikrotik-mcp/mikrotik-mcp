import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { explainTools } from "../src/tools/explain";

const mocks = vi.hoisted(() => ({
  command: vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>(),
  get: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/core/runtime", async (original) => ({
  ...(await original<typeof import("../src/core/runtime")>()),
  resolveDeviceName: () => "fixture",
}));
vi.mock("../src/snapshots/store", () => ({ openSnapshotStore: async () => ({ get: mocks.get }) }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = explainTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args) as never, ctx);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.command.mockResolvedValue("/system identity\nset name=fixture");
});

describe("explanation tools", () => {
  test("inline config takes precedence and avoids router and snapshot store", async () => {
    const text = await run("explain_device", {
      config_text: "/system identity\nset name=inline",
      snapshot_id: "other",
      diagram: false,
    });
    expect(typeof text).toBe("string");
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  test("missing snapshot and live export errors are returned", async () => {
    expect(await run("explain_section", { section: "firewall", snapshot_id: "missing" })).toContain(
      "No snapshot 'missing'",
    );
    mocks.command.mockResolvedValueOnce("failure: denied").mockResolvedValueOnce(" ");
    expect(await run("explain_device")).toContain("Could not read the configuration");
    expect(await run("explain_device")).toContain("empty export");
    expect(mocks.command.mock.calls.map(([cmd]) => cmd)).toEqual(["/export", "/export"]);
  });

  test("section and diff render from inline exports without router I/O", async () => {
    const before = "/system identity\nset name=before";
    const after = "/system identity\nset name=after";
    expect(
      typeof (await run("explain_section", { section: "identity", config_text: before })),
    ).toBe("string");
    expect(
      typeof (await run("diff_explanations", { before_text: before, after_text: after })),
    ).toBe("string");
    expect(mocks.command).not.toHaveBeenCalled();
  });

  test("diff requires a baseline before any read and labels source errors", async () => {
    expect(await run("diff_explanations")).toContain("diff needs a baseline");
    expect(mocks.command).not.toHaveBeenCalled();
    expect(await run("diff_explanations", { before_snapshot_id: "missing" })).toContain(
      "Before: No snapshot",
    );
    mocks.command.mockResolvedValueOnce("failure: denied");
    expect(await run("diff_explanations", { before_text: "/system identity" })).toContain(
      "After: Could not read",
    );
  });

  test("section validation blocks invalid area", async () => {
    await expect(run("explain_section", { section: "invalid", config_text: "" })).rejects.toThrow();
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
