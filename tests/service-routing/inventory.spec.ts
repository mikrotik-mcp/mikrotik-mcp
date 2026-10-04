import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parseRoutingAddressPage,
  parseRoutingRows,
  routingReadCommand,
} from "../../src/service-routing/read";
import { createRoutingInventoryReader, routingSections } from "../../src/service-routing/inventory";

const ctx = { device: "lab", info: () => {}, error: () => {} };
afterEach(() => vi.useRealTimers());
describe("structured router routing reads", () => {
  it("preserves FIB flags, dynamic routes, disabled rows and router IDs/order", () => {
    expect(
      parseRoutingRows(
        '[{".id":"*0","name":"main","fib":true},{".id":"*1","name":"off","disabled":true,"fib":false}]',
      ),
    ).toEqual([
      { "#": "0", ".id": "*0", name: "main", fib: "yes" },
      { "#": "1", ".id": "*1", name: "off", disabled: "yes", fib: "no" },
    ]);
    expect(
      parseRoutingRows(
        '[{"dynamic":true,"active":true,"distance":0,"immediate-gw":["ether1","ether2"],"ignored":"x"}]',
        "dynamic,active,distance,immediate-gw",
      ),
    ).toEqual([
      { "#": "0", dynamic: "yes", active: "yes", distance: "0", "immediate-gw": "ether1,ether2" },
    ]);
    expect(parseRoutingRows("[]")).toEqual([]);
  });
  it("rejects malformed, truncated, oversize and non-array replies instead of empty success", () => {
    for (const raw of [
      "failure: timeout",
      '[{"name":',
      "{}",
      "[null]",
      "[[1]]",
      "x".repeat(1_048_577),
      "MCP_ROUTING_ROW_LIMIT",
      JSON.stringify(Array.from({ length: 2001 }, () => ({}))),
    ])
      expect(() => parseRoutingRows(raw)).toThrow();
  });
  it("bounds output before printing, uses detail and real valueless as-value syntax", () => {
    const command = routingReadCommand("/routing table");
    expect(command).toContain("[:len [/routing table find]]");
    expect(command).toContain("/routing table print detail as-value");
    expect(command).not.toContain("as-value=yes");
    expect(command).not.toContain("count-only");
    expect(() => routingReadCommand("/system script; :put secret")).toThrow();
  });
  it("paginates complete address batches and rejects incomplete or corrupt pages", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      ".id": `*${i}`,
      list: "country",
      address: `10.0.${i}.0/24`,
    }));
    expect(parseRoutingAddressPage(JSON.stringify({ rows, total: 401 }), 200)).toMatchObject({
      total: 401,
      nextOffset: 400,
      rows: [
        { "#": "200", ".id": "*0" },
        ...rows.slice(1).map((r, i) => ({ ...r, "#": String(i + 201) })),
      ],
    });
    expect(
      parseRoutingAddressPage(JSON.stringify({ rows: [rows[0]], total: 401 }), 400).nextOffset,
    ).toBeUndefined();
    expect(parseRoutingAddressPage('{"rows":[],"total":0}')).toEqual({
      rows: [],
      total: 0,
      nextOffset: undefined,
    });
    for (const raw of [
      "null",
      "{}",
      "{",
      '{"rows":[],"total":2}',
      '{"rows":[{}],"total":1}',
      '{"rows":[],"total":-1}',
    ])
      expect(() => parseRoutingAddressPage(raw)).toThrow();
  });
});
const noAddresses = async () => ({ rows: [], total: 0 });
describe("routing snapshot isolation", () => {
  it("coalesces reads, caches briefly, separates devices and clears on config changes", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => [{ name: "main", fib: "yes" }]);
    const reader = createRoutingInventoryReader(read, noAddresses);
    const [first, concurrent] = await Promise.all([
      reader.read("lab", ctx),
      reader.read("lab", ctx),
    ]);
    expect(first).toBe(concurrent);
    expect(read).toHaveBeenCalledTimes(Object.keys(routingSections).length - 2);
    expect(await reader.read("lab", ctx)).toBe(first);
    const other = await reader.read("other", ctx);
    expect(other.device).toBe("other");
    expect(read).toHaveBeenCalledWith(
      "/routing table",
      undefined,
      expect.objectContaining({ device: "other" }),
    );
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await reader.read("lab", ctx)).not.toBe(first);
    reader.clear();
    expect(await reader.read("other", ctx)).not.toBe(other);
  });
  it("preserves independent sections and makes unavailable distinct from an empty table", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (path: string) => {
      if (path === "/ipv6 route") throw new Error("Device disconnected");
      return [];
    });
    const reader = createRoutingInventoryReader(read, noAddresses);
    const result = await reader.read("lab", ctx);
    expect(result.sections.routes4).toMatchObject({ state: "ready", rows: [] });
    expect(result.sections.routes6).toMatchObject({ state: "error", error: "Device disconnected" });
    expect(result.sections.tables.state).toBe("ready");
    await vi.advanceTimersByTimeAsync(5001);
    expect(await reader.read("lab", ctx)).not.toBe(result);
  });
  it("never exceeds two concurrent reads and does not cache an old in-flight config", async () => {
    let active = 0,
      maximum = 0;
    const read = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return [];
    });
    const reader = createRoutingInventoryReader(read, noAddresses);
    const old = reader.read("lab", ctx);
    reader.clear();
    await old;
    const calls = read.mock.calls.length;
    await reader.read("lab", ctx);
    expect(read.mock.calls.length).toBe(calls * 2);
    expect(maximum).toBe(2);
  });
});
