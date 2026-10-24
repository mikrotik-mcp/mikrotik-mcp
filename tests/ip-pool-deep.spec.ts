import { beforeEach, expect, test, vi } from "vite-plus/test";
import { ipPoolTools } from "../src/tools/ip-pool";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));

const ctx = { device: "lab", info: vi.fn() };
async function call(name: string, args: Record<string, unknown>) {
  const tool = ipPoolTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} missing`);
  return tool.handler(args as never, ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue("");
});

test("creation verifies the resulting pool and distinguishes router error", async () => {
  execute
    .mockResolvedValueOnce("*12")
    .mockResolvedValueOnce("name=clients ranges=192.0.2.10-192.0.2.20");
  expect(
    await call("create_ip_pool", { name: "clients", ranges: "192.0.2.10-192.0.2.20" }),
  ).toContain("created successfully");
  expect(execute.mock.calls[0][0]).toContain("/ip pool add");
  execute.mockResolvedValueOnce("failure: invalid range");
  expect(await call("create_ip_pool", { name: "bad", ranges: "bad" })).toContain(
    "Failed to create",
  );
});

test("update does not send a no-op and can clear the next-pool chain", async () => {
  expect(await call("update_ip_pool", { name: "clients" })).toBe("No updates specified.");
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce("").mockResolvedValueOnce("name=clients");
  expect(
    await call("update_ip_pool", { name: "clients", next_pool: "", comment: "managed" }),
  ).toContain("updated successfully");
  expect(execute.mock.calls[0][0]).toContain("!next-pool");
  expect(execute.mock.calls[0][0]).toContain("comment=managed");
});

test("remove refuses missing, occupied and DHCP-linked pools before any delete", async () => {
  execute.mockResolvedValueOnce("0");
  expect(await call("remove_ip_pool", { name: "clients" })).toContain("not found");
  execute.mockResolvedValueOnce("1").mockResolvedValueOnce("2");
  expect(await call("remove_ip_pool", { name: "clients" })).toContain(
    "addresses are currently in use",
  );
  execute.mockResolvedValueOnce("1").mockResolvedValueOnce("0").mockResolvedValueOnce("1");
  expect(await call("remove_ip_pool", { name: "clients" })).toContain("DHCP server");
  expect(execute.mock.calls.some((args) => String(args[0]).includes("/ip pool remove"))).toBe(
    false,
  );
});

test("remove succeeds only after all dependency checks pass", async () => {
  execute
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("0")
    .mockResolvedValueOnce("0")
    .mockResolvedValueOnce("");
  expect(await call("remove_ip_pool", { name: "clients" })).toContain("removed successfully");
  expect(execute.mock.calls.at(-1)?.[0]).toContain("/ip pool remove");
});

test("expansion merges existing and new ranges through the update path", async () => {
  execute
    .mockResolvedValueOnce("name=clients ranges=192.0.2.10-192.0.2.20")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("name=clients ranges=192.0.2.10-192.0.2.30");
  expect(
    await call("expand_ip_pool", { name: "clients", additional_ranges: "192.0.2.21-192.0.2.30" }),
  ).toContain("updated successfully");
  expect(execute.mock.calls[1][0]).toContain("192.0.2.10-192.0.2.20,192.0.2.21-192.0.2.30");
});

test("expansion reports absent or unparseable existing ranges", async () => {
  expect(
    await call("expand_ip_pool", { name: "missing", additional_ranges: "192.0.2.1-192.0.2.2" }),
  ).toContain("not found");
  execute.mockResolvedValueOnce("name=clients");
  expect(
    await call("expand_ip_pool", { name: "clients", additional_ranges: "192.0.2.1-192.0.2.2" }),
  ).toContain("Unable to determine");
});
