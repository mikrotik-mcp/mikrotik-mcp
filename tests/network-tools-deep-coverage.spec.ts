import { beforeEach, expect, test, vi } from "vite-plus/test";
import { networkToolTools } from "../src/tools/network-tools";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));

const ctx = { device: "lab", info: vi.fn() };
async function call(name: string, args: Record<string, unknown>) {
  const tool = networkToolTools.find((item) => item.name === name);
  if (!tool) throw new Error(`${name} missing`);
  return tool.handler(args as never, ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue("");
});

test("ping bounds execution time and reports success, empty response, and router error", async () => {
  execute.mockResolvedValueOnce("sent=2 received=2 avg-rtt=12ms");
  expect(await call("ping", { address: "192.0.2.1", count: 2, interface: "ether2" })).toContain(
    "avg-rtt=12ms",
  );
  expect(execute).toHaveBeenCalledWith(expect.stringContaining("count=2"), ctx, { maxMs: 9000 });
  expect(execute.mock.calls[0][0]).toContain("interface=ether2");
  expect(await call("ping", { address: "192.0.2.1", count: 1 })).toContain("No response");
  execute.mockResolvedValueOnce("failure: no route");
  expect(await call("ping", { address: "192.0.2.1", count: 1 })).toContain("Failed to ping");
});

test("traceroute requests DNS names and has a bounded read even if router streams forever", async () => {
  execute.mockResolvedValueOnce("1 10.0.0.1 1ms");
  expect(await call("traceroute", { address: "example.test", count: 2, use_dns: true })).toContain(
    "1 10.0.0.1",
  );
  expect(execute).toHaveBeenCalledWith(expect.stringContaining("use-dns"), ctx, { maxMs: 36_000 });
  expect(await call("traceroute", { address: "example.test", count: 1 })).toContain(
    "No route information",
  );
});

test("bandwidth test keeps credentials in command, caps runtime and handles unavailable peer", async () => {
  execute.mockResolvedValueOnce("rx-current=10Mbps");
  expect(
    await call("bandwidth_test", {
      address: "192.0.2.2",
      duration: 3,
      direction: "receive",
      protocol: "tcp",
      user: "tester",
      password: "secret",
    }),
  ).toContain("10Mbps");
  expect(execute).toHaveBeenCalledWith(expect.stringContaining("duration=3s"), ctx, {
    maxMs: 15_000,
  });
  expect(execute.mock.calls[0][0]).toContain("user=tester");
  expect(
    await call("bandwidth_test", {
      address: "192.0.2.2",
      duration: 3,
      direction: "both",
      protocol: "udp",
    }),
  ).toContain("No bandwidth test results");
  execute.mockResolvedValueOnce("failure: refused");
  expect(
    await call("bandwidth_test", {
      address: "192.0.2.2",
      duration: 3,
      direction: "both",
      protocol: "udp",
    }),
  ).toContain("Failed to run bandwidth test");
});

test("DNS command prints resolver expression and distinguishes empty result from failure", async () => {
  execute.mockResolvedValueOnce("203.0.113.7");
  expect(await call("resolve_dns", { name: "example.test", server: "1.1.1.1" })).toContain(
    "203.0.113.7",
  );
  expect(execute.mock.calls[0][0]).toContain(":put [");
  expect(execute.mock.calls[0][0]).toContain("server=1.1.1.1");
  expect(await call("resolve_dns", { name: "example.test" })).toContain("returned no address");
  execute.mockResolvedValueOnce("failure: dns unavailable");
  expect(await call("resolve_dns", { name: "example.test" })).toContain("Failed to resolve");
});

test("netwatch CRUD checks existence before deletion and verifies additions", async () => {
  execute.mockResolvedValueOnce("").mockResolvedValueOnce("host=192.0.2.3 status=up");
  expect(await call("add_netwatch", { host: "192.0.2.3", disabled: false })).toContain(
    "added successfully",
  );
  expect(execute.mock.calls[0][0]).toContain("/tool netwatch add");
  expect(await call("list_netwatch", { host_filter: "missing" })).toContain("No netwatch entries");
  expect(await call("get_netwatch", { host: "missing" })).toContain("not found");
  execute.mockResolvedValueOnce("0");
  expect(await call("remove_netwatch", { host: "missing" })).toContain("not found");
  execute.mockResolvedValueOnce("1").mockResolvedValueOnce("");
  expect(await call("remove_netwatch", { host: "192.0.2.3" })).toContain("removed successfully");
  expect(execute.mock.calls.at(-1)?.[0]).toContain("/tool netwatch remove");
});
