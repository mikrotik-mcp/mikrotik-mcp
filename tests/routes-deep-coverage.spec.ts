import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { routeTools } from "../src/tools/routes";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const caps = vi.hoisted(() => vi.fn());
vi.mock("../src/core/capability-cache", () => ({ getCapabilities: caps }));
const ctx: ToolContext = { device: "routes-deep", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = routeTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(args as never, ctx);
};
const issued = () => command.mock.calls.map(([text]) => text);

beforeEach(() => {
  command.mockReset();
  caps.mockReset().mockResolvedValue({ version: { major: 7 } });
});

test("add route builds optional fields and verifies returned ID", async () => {
  command
    .mockResolvedValueOnce("*A")
    .mockResolvedValueOnce("*A dst-address=192.0.2.0/24 gateway=10.0.0.1");
  const out = await run("add_route", {
    dst_address: "192.0.2.0/24",
    gateway: "10.0.0.1",
    routing_mark: "VPN",
    comment: "backup link",
    disabled: true,
    type: "blackhole",
  });
  expect(issued()[0]).toContain("routing-table=VPN");
  expect(issued()[0]).toContain('comment="backup link"');
  expect(issued()[0]).toContain("blackhole");
  expect(issued()[1]).toBe("/ip route print detail where .id=*A");
  expect(out).toContain("Route added successfully");
});

test("add route reports an unverified empty response and a device failure", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce("");
  expect(await run("add_route", { dst_address: "192.0.2.0/24", gateway: "10.0.0.1" })).toContain(
    "unable to verify",
  );
  expect(issued()[1]).toContain('where dst-address="192.0.2.0/24" and gateway="10.0.0.1"');
  command.mockClear().mockResolvedValueOnce("failure: denied");
  expect(await run("add_route", { dst_address: "192.0.2.0/24", gateway: "10.0.0.1" })).toContain(
    "Failed to add route: failure: denied",
  );
  expect(command).toHaveBeenCalledTimes(1);
});

test("update resolves row ID, clears fields and verifies the concrete route", async () => {
  command
    .mockResolvedValueOnce("*B")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("*B dst-address=198.51.100.0/24 gateway=10.0.0.2");
  const out = await run("update_route", {
    route_id: "0",
    routing_table: "",
    pref_src: "",
    comment: "new note",
  });
  expect(
    issued().some(
      (text) =>
        text.includes("/ip route set *B") &&
        text.includes("!routing-table") &&
        text.includes("!pref-src"),
    ),
  ).toBe(true);
  expect(out).toContain("Route *B updated successfully");
});

test("update distinguishes no changes, write error and failed read-back", async () => {
  command.mockResolvedValueOnce("*A dst-address=192.0.2.0/24");
  expect(await run("update_route", { route_id: "*A" })).toBe("No updates specified.");
  expect(issued().filter((text) => text.includes(" set "))).toHaveLength(0);
  command
    .mockReset()
    .mockResolvedValueOnce("*A dst-address=192.0.2.0/24")
    .mockResolvedValueOnce("failure: denied");
  expect(await run("update_route", { route_id: "*A", gateway: "10.0.0.2" })).toContain(
    "Failed to update route: failure: denied",
  );
  command
    .mockReset()
    .mockResolvedValueOnce("*A dst-address=192.0.2.0/24")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("");
  await expect(run("update_route", { route_id: "*A", gateway: "10.0.0.2" })).rejects.toThrow(
    "change may already be applied",
  );
});

test.each([
  ["v7", { version: { major: 7 } }],
  ["an unknown version", { version: null }],
])("check_route_path on %s never sends `/ip route check`", async (_label, capabilities) => {
  caps.mockResolvedValue(capabilities);
  command.mockResolvedValueOnce("*A dst-address=0.0.0.0/0 active=yes");
  expect(await run("check_route_path", { destination: "8.8.8.8", routing_table: "VPN" })).toContain(
    "ROUTE PATH TO 8.8.8.8",
  );
  expect(issued()).toEqual([
    "/ip route print detail where 8.8.8.8 in dst-address active=yes routing-table=VPN",
  ]);
});

test("check_route_path does not send `/ip route check` when the version probe fails", async () => {
  caps.mockRejectedValue(new Error("probe failed"));
  command.mockResolvedValueOnce("*A dst-address=0.0.0.0/0 active=yes");
  await run("check_route_path", { destination: "1.1.1.1" });
  expect(issued().some((text) => text.includes("route check"))).toBe(false);
});

test("check_route_path uses `/ip route check` on v6 and falls back when it is unsupported", async () => {
  caps.mockResolvedValue({ version: { major: 6 } });
  command.mockResolvedValueOnce("status: ok\ninterface: ether1\nnexthop: 10.0.0.1");
  expect(await run("check_route_path", { destination: "8.8.8.8" })).toContain("nexthop: 10.0.0.1");
  expect(issued()).toEqual(["/ip route check 8.8.8.8"]);
  command
    .mockReset()
    .mockResolvedValueOnce("bad command name check")
    .mockResolvedValueOnce("*A dst-address=0.0.0.0/0 active=yes");
  await run("check_route_path", { destination: "8.8.8.8" });
  expect(issued()[1]).toBe("/ip route print detail where 8.8.8.8 in dst-address active=yes");
});

test("route cache uses the v7 fallback only when the v6 command is unsupported", async () => {
  command.mockResolvedValueOnce("bad command name cache").mockResolvedValueOnce("*A active=yes");
  expect(await run("get_route_cache")).toContain("ACTIVE FORWARDING TABLE");
  expect(issued()).toEqual(["/ip route cache print", "/ip route print where active=yes"]);
});

test("v7 cache flush is a no-op and route statistics preserve five counters", async () => {
  command.mockResolvedValueOnce("bad command name flush");
  expect(await run("flush_route_cache")).toContain("no-op");
  command.mockReset();
  for (const n of ["5", "3", "2", "3", "1"]) command.mockResolvedValueOnce(n);
  expect(await run("get_route_statistics")).toContain("Disabled routes: 1");
  expect(issued()).toEqual([
    "/ip route print count-only",
    "/ip route print count-only where active=yes",
    "/ip route print count-only where dynamic=yes",
    "/ip route print count-only where static=yes",
    "/ip route print count-only where disabled=yes",
  ]);
});
