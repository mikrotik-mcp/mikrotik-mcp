import { beforeEach, expect, test, vi } from "vite-plus/test";
import { routingIgmpProxyTools } from "../src/tools/routing-igmp-proxy";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));
const ctx = { device: "lab", info: vi.fn() };
async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = routingIgmpProxyTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} missing`);
  return tool.handler(args as never, ctx as never);
}
beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue("");
});

test("read tools distinguish unsupported menus, empty data and live forwarding", async () => {
  execute.mockResolvedValueOnce("bad command name igmp-proxy");
  expect(await call("get_igmp_proxy_settings")).toContain("not available");
  expect(await call("get_igmp_proxy_settings")).toContain("No IGMP proxy settings");
  execute.mockResolvedValueOnce("source=192.0.2.3 group=239.1.1.1");
  expect(await call("list_igmp_proxy_mfc")).toContain("239.1.1.1");
});

test("global updates reject no-op and read back accepted settings", async () => {
  expect(await call("update_igmp_proxy_settings")).toBe("No updates specified.");
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce("").mockResolvedValueOnce("quick-leave=yes");
  expect(
    await call("update_igmp_proxy_settings", { quick_leave: true, query_interval: "125s" }),
  ).toContain("quick-leave=yes");
  expect(execute.mock.calls[0][0]).toContain("query-interval=125s");
});

test("interface add and update include correct multicast role and verify result", async () => {
  expect(
    await call("add_igmp_proxy_interface", {
      interface: "ether1",
      upstream: true,
      disabled: false,
    }),
  ).toContain("added successfully");
  expect(execute.mock.calls[0][0]).toContain("upstream=yes");
  expect(await call("update_igmp_proxy_interface", { interface: "ether1" })).toBe(
    "No updates specified.",
  );
  execute.mockResolvedValueOnce("").mockResolvedValueOnce("interface=ether1 upstream=no");
  expect(
    await call("update_igmp_proxy_interface", { interface: "ether1", upstream: false }),
  ).toContain("updated successfully");
  expect(execute.mock.calls.at(-2)?.[0]).toContain("upstream=no");
});

test("toggle and removal report router failures without false success", async () => {
  execute.mockResolvedValueOnce("failure: busy");
  expect(
    await call("set_igmp_proxy_interface_enabled", { interface: "ether1", enabled: false }),
  ).toContain("Failed to update");
  expect(execute.mock.calls[0][0]).toContain("disabled=yes");
  execute.mockResolvedValueOnce("failure: denied");
  expect(await call("remove_igmp_proxy_interface", { interface: "ether1" })).toContain(
    "Failed to remove",
  );
});
