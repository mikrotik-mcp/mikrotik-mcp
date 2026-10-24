import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { ipCloudTools } from "../src/tools/ip-cloud";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) =>
  ipCloudTools.find((t) => t.name === name)!.handler(args as never, ctx);
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

test("read reports empty and populated cloud state", async () => {
  expect(await run("get_ip_cloud")).toBe("No IP cloud information returned.");
  command.mockResolvedValueOnce("dns-name: router.sn.mynetname.net");
  expect(await run("get_ip_cloud")).toContain("router.sn.mynetname.net");
  expect(command.mock.calls.map(([text]) => text)).toEqual(["/ip cloud print", "/ip cloud print"]);
});

test("set skips empty update and preserves explicit false and interval", async () => {
  expect(await run("set_ip_cloud")).toBe("No updates specified.");
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce("").mockResolvedValueOnce("ddns-enabled: no");
  expect(
    await run("set_ip_cloud", {
      ddns_enabled: false,
      update_time: true,
      ddns_update_interval: "1h",
    }),
  ).toContain("ddns-enabled: no");
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    "/ip cloud set ddns-enabled=no update-time=yes ddns-update-interval=1h",
    "/ip cloud print",
  ]);
});

test("all write failures suppress status read", async () => {
  for (const [name, args] of [
    ["set_ip_cloud", { ddns_enabled: true }],
    ["force_cloud_update", {}],
    ["set_ip_cloud_advanced", { use_local_address: false }],
  ] as const) {
    command.mockReset().mockResolvedValue("failure: denied");
    expect(await run(name, args)).toContain("failure: denied");
    expect(command).toHaveBeenCalledOnce();
  }
});

test("force update and advanced option read status after success", async () => {
  command
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("status: updated")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("use-local-address: no");
  expect(await run("force_cloud_update")).toContain("status: updated");
  expect(await run("set_ip_cloud_advanced", { use_local_address: false })).toContain(
    "use-local-address: no",
  );
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    "/ip cloud force-update",
    "/ip cloud print",
    "/ip cloud advanced set use-local-address=no",
    "/ip cloud print",
  ]);
});
