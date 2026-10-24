import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { routingSettingsTools } from "../src/tools/routing-settings";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) =>
  routingSettingsTools.find((t) => t.name === name)!.handler(args as never, ctx);
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

test("read distinguishes unsupported, empty and populated settings", async () => {
  command
    .mockResolvedValueOnce("bad command name settings")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("ipv4-multipath-hash-policy: l4");
  expect(await run("get_routing_settings")).toContain("not available");
  expect(await run("get_routing_settings")).toBe("No routing settings reported.");
  expect(await run("get_routing_settings")).toContain("ipv4-multipath-hash-policy: l4");
  expect(command).toHaveBeenCalledTimes(3);
});

test("no-op update avoids I/O and full update retains false", async () => {
  expect(await run("update_routing_settings")).toBe("No updates specified.");
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce("").mockResolvedValueOnce("updated");
  expect(
    await run("update_routing_settings", {
      ipv4_multipath_hash_policy: "l4",
      ipv6_multipath_hash_policy: "l3-inner",
      ipv4_vrf_as_interface: false,
    }),
  ).toContain("updated");
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    "/routing settings set ipv4-multipath-hash-policy=l4 ipv6-multipath-hash-policy=l3-inner ipv4-vrf-as-interface=no",
    "/routing settings print",
  ]);
});

test("unsupported and generic write errors stop before verification", async () => {
  command
    .mockResolvedValueOnce("bad command name settings")
    .mockResolvedValueOnce("failure: denied");
  expect(await run("update_routing_settings", { ipv4_vrf_as_interface: true })).toContain(
    "not available",
  );
  expect(await run("update_routing_settings", { ipv4_vrf_as_interface: true })).toContain(
    "Failed to update routing settings",
  );
  expect(command).toHaveBeenCalledTimes(2);
});
