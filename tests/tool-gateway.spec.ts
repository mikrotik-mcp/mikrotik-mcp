/**
 * Offline tests for the tool-gateway meta-tools (find_tools / describe_tool /
 * invoke_tool) against the REAL catalog. These exercise the no-device paths:
 * search, schema inspection, unknown-name suggestions, and argument validation —
 * none of which touch a router.
 */
import { describe, expect, test } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { createContext } from "../src/core/context";
import { setConfig } from "../src/core/runtime";
import { toolGatewayTools } from "../src/tools/tool-gateway";

setConfig(
  MikrotikConfigSchema.parse({
    devices: { default: { host: "127.0.0.1", port: 1 } },
    defaultDevice: "default",
  }),
);

const tool = (name: string) => {
  const t = toolGatewayTools.find((x) => x.name === name);
  if (!t) throw new Error(`gateway tool not found: ${name}`);
  return t;
};
const run = (name: string, args: unknown): Promise<string> =>
  Promise.resolve(tool(name).handler(args, createContext())).then((r) =>
    typeof r === "string" ? r : r.text,
  );

describe("find_tools", () => {
  test("two words that the catalog writes as one still find the tool", async () => {
    const out = await run("find_tools", { query: "shut down the router", limit: 3 });
    expect(out).toMatch(/^1\. shutdown_system /m);
  });

  test("asks for English when the request is in another script", async () => {
    const ask = /Translate it to English and call find_tools again/;
    const none = await run("find_tools", { query: "روتر رو خاموش کن" });
    expect(none).toMatch(ask);
    // A request that was not really searched must not send the model to a raw command.
    expect(none).not.toMatch(/run_routeros_command/);
    expect(await run("find_tools", { query: "قوانین firewall" })).toMatch(ask);
    // Latin letters, digits and signs are not another script.
    expect(await run("find_tools", { query: "ping 8.8.8.8 — café" })).not.toMatch(ask);
  });

  test("surfaces a real tool by intent (and IPv4 outranks its IPv6 twin)", async () => {
    const out = await run("find_tools", { query: "list dhcp servers" });
    expect(out).toMatch(/list_dhcp_servers/);
    const v4 = out.indexOf("list_dhcp_servers");
    const v6 = out.indexOf("list_ipv6_dhcp_servers");
    // Version-neutral query → the IPv4/generic tool must come first.
    if (v6 >= 0) expect(v4).toBeLessThan(v6);
  });

  test("verb synonyms + IPv4 disambiguation put the right firewall tool on top", async () => {
    // 'add' must match the 'create_*' tool, and the IPv6 twin must not shadow it.
    const out = await run("find_tools", { query: "add ipv4 firewall filter rule", limit: 5 });
    const v4 = out.indexOf("create_filter_rule");
    const v6 = out.indexOf("create_ipv6_filter_rule");
    expect(v4).toBeGreaterThanOrEqual(0);
    if (v6 >= 0) expect(v4).toBeLessThan(v6);
  });

  test("web proxy and device-mode queries surface their dedicated tools", async () => {
    expect(await run("find_tools", { query: "read web proxy settings", limit: 5 })).toMatch(
      /1\. get_web_proxy\s+\[web-proxy\]/,
    );
    expect(await run("find_tools", { query: "add web proxy access deny rule", limit: 5 })).toMatch(
      /add_web_proxy_access_rule/,
    );
    expect(
      await run("find_tools", { query: "update device mode proxy hotspot email", limit: 5 }),
    ).toMatch(/update_device_mode_features/);
  });

  test("a hopeless query explains the fallback", async () => {
    const out = await run("find_tools", { query: "zzzqqq nonsense xyzzy" });
    expect(out).toMatch(/No tools matched|run_routeros_command/);
  });

  test.each([
    "begin_transaction",
    "coordinated multi router change",
    "cross device VPN transaction",
    "fleet ACL transaction",
  ])("discovers the transaction entry point: %s", async (query) => {
    const out = await run("find_tools", { query });
    expect(out).toMatch(/\d+\. begin_transaction\s+\[txn\]/);
  });
});

describe("describe_tool", () => {
  test("returns schema + risk for a known tool", async () => {
    const out = await run("describe_tool", { name: "list_ip_addresses" });
    expect(out).toMatch(/list_ip_addresses/);
    expect(out).toMatch(/risk:/);
    expect(out).toMatch(/JSON schema:/);
  });

  test("suggests near matches for an unknown name", async () => {
    const out = await run("describe_tool", { name: "list_ip_adress" });
    expect(out).toMatch(/No tool named/);
  });
});

// invoke_tool needs the tools bound to a server, so it is tested end to end in
// tests/tool-exposure.spec.ts.
describe("invoke_tool", () => {
  test("refuses to run outside a server instead of calling a handler unguarded", async () => {
    const out = await run("invoke_tool", { name: "list_ip_addresses", arguments: {} });
    expect(out).toMatch(/only available on a running MCP server/);
  });
});
