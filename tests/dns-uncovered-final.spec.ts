import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { dnsTools } from "../src/tools/dns";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = dnsTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx);
};
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});

test("resolver updates include DoH options and report failures", async () => {
  const args = {
    servers: ["1.1.1.1"],
    allow_remote_requests: true,
    use_doh: true,
    doh_server: "https://dns.example/dns-query",
    verify_doh_cert: true,
    doh_timeout: "5s",
  };
  command.mockResolvedValueOnce("failure: denied");
  expect(await run("set_dns_servers", args)).toContain("Failed to update");
  expect(command.mock.calls[0][0]).toContain("use-doh-server=");
  command.mockResolvedValueOnce("").mockResolvedValueOnce("servers: 1.1.1.1");
  expect(await run("set_dns_servers", args)).toContain("servers: 1.1.1.1");
  expect(await run("get_dns_settings")).toContain("Unable to retrieve");
  command.mockResolvedValueOnce("servers: 1.1.1.1");
  expect(await run("get_dns_settings")).toContain("DNS SETTINGS");
});

test("cache inspection, flushing and statistics handle empty, valid and failed output", async () => {
  expect(await run("get_dns_cache")).toContain("empty");
  command.mockResolvedValueOnce("0 name=example.test");
  expect(await run("get_dns_cache")).toContain("example.test");
  expect(await run("flush_dns_cache")).toContain("flushed successfully");
  command.mockResolvedValueOnce("flushed");
  expect(await run("flush_dns_cache")).toContain("Flush result");
  command.mockResolvedValueOnce("failure: denied");
  expect(await run("get_dns_cache_statistics")).toContain("Failed to get");
  expect(await run("get_dns_cache_statistics")).toContain("Unable to retrieve");
  command.mockResolvedValueOnce("servers: 1.1.1.1\ncache-size: 1024").mockResolvedValueOnce("12");
  const stats = await run("get_dns_cache_statistics");
  expect(stats).toContain("cached-entries: 12");
  expect(stats).toContain("cache-size: 1024");
  expect(stats).not.toContain("servers: 1.1.1.1");
  command.mockResolvedValueOnce("servers: 1.1.1.1").mockResolvedValueOnce("unknown");
  expect(await run("get_dns_cache_statistics")).toContain("servers: 1.1.1.1");
});

test("DNS export uses default and explicit names", async () => {
  expect(await run("export_dns_config")).toContain("dns_config.rsc");
  command.mockResolvedValueOnce("saved");
  expect(await run("export_dns_config", { filename: "backup" })).toContain("Export result: saved");
  expect(command.mock.calls.at(-1)?.[0]).toBe("/ip dns export file=backup");
});

test("set_dns_servers changes only the settings that were given", async () => {
  const sentBy = async (args: Record<string, unknown>): Promise<string> => {
    command.mockClear();
    await run("set_dns_servers", args);
    return command.mock.calls[0]?.[0] ?? "";
  };
  // The reported bug: servers alone also wrote allow-remote-requests=no, which
  // stops DNS for every client that uses the router as its resolver.
  expect(await sentBy({ servers: ["1.1.1.1", "8.8.8.8"] })).toBe(
    "/ip dns set servers=1.1.1.1,8.8.8.8",
  );
  expect(await sentBy({ allow_remote_requests: false })).toBe(
    "/ip dns set allow-remote-requests=no",
  );
  expect(await sentBy({ cache_size: 4096 })).toBe("/ip dns set cache-size=4096");
  // DoH: the URL turns it on, use_doh=false clears it, and nothing else is touched.
  expect(await sentBy({ doh_server: "https://dns.example/dns-query" })).toBe(
    "/ip dns set use-doh-server=https://dns.example/dns-query",
  );
  expect(await sentBy({ use_doh: false })).toBe('/ip dns set use-doh-server=""');
  expect(await sentBy({ verify_doh_cert: false })).toBe("/ip dns set verify-doh-cert=no");
});

test("set_dns_servers runs nothing when the request cannot be carried out", async () => {
  expect(await run("set_dns_servers", {})).toContain("no setting was given");
  expect(await run("set_dns_servers", { use_doh: true })).toContain("needs doh_server");
  expect(
    await run("set_dns_servers", { use_doh: false, doh_server: "https://dns.example/q" }),
  ).toContain("Give one of them");
  expect(command).not.toHaveBeenCalled();
});
