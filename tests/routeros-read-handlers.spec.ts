import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { moduleCatalog } from "../src/tools";

const read = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: read }));

// These scopes expose ordinary RouterOS inventory menus. Each selected handler
// has a valid no-argument read path after schema defaults are applied.
const menus = new Map<string, string>([
  ["interfaces", "/interface"],
  ["vlan", "/interface vlan"],
  ["bridge", "/interface bridge"],
  ["wireless", "/interface"],
  ["ip-address", "/ip address"],
  ["ip-pool", "/ip pool"],
  ["routes", "/ip route"],
  ["dns", "/ip dns"],
  ["ipv6-address", "/ipv6 address"],
  ["ipv6-firewall-filter", "/ipv6 firewall filter"],
  ["ipv6-firewall-nat", "/ipv6 firewall nat"],
  ["ipv6-firewall-mangle", "/ipv6 firewall mangle"],
  ["ipv6-firewall-raw", "/ipv6 firewall raw"],
  ["ipv6-neighbor", "/ipv6 neighbor"],
  ["firewall-filter", "/ip firewall filter"],
  ["firewall-nat", "/ip firewall nat"],
  ["firewall-mangle", "/ip firewall mangle"],
  ["wireguard", "/interface wireguard"],
  ["users", "/user"],
  ["system-config", "/system"],
  ["system", "/system"],
  ["ipsec", "/ip ipsec"],
  ["user-manager", "/user-manager"],
  ["routing-ospf", "/routing ospf"],
  ["routing-bgp", "/routing bgp"],
  ["routing-rip", "/routing rip"],
  ["routing-pimsm", "/routing pimsm"],
  ["routing-filter", "/routing filter"],
  ["routing-igmp-proxy", "/routing igmp-proxy"],
  ["container", "/container"],
  ["openvpn", "/interface ovpn"],
  ["tunnels", "/interface"],
  ["logs", "/log"],
  ["ipv6-dhcp-server", "/ipv6 dhcp-server"],
  ["ipv6-nd", "/ipv6 nd"],
  ["ipv6-pool", "/ipv6 pool"],
  ["ppp", "/ppp"],
  ["queue", "/queue"],
  ["traffic-flow", "/ip traffic-flow"],
  ["address-list", "/ip firewall address-list"],
  ["ip-service", "/ip service"],
  ["ip-ssh", "/ip ssh"],
  ["ip-cloud", "/ip cloud"],
  ["certificate", "/certificate"],
  ["scheduler", "/system"],
  ["logging", "/system logging"],
  ["ip-dhcp-client", "/ip dhcp-client"],
  ["dhcp", "/ip dhcp-server"],
  ["ipv6-dhcp-client", "/ipv6 dhcp-client"],
  ["ipv6-dhcp-relay", "/ipv6 dhcp-relay"],
  ["ipv6-firewall-address-list", "/ipv6 firewall address-list"],
  ["ipv6-route", "/ipv6 route"],
  ["ipv6-settings", "/ipv6 settings"],
  ["routing-id", "/routing id"],
  ["routing-settings", "/routing settings"],
  ["routing-table", "/routing table"],
  ["routing-rule", "/routing rule"],
  ["routing-nexthop", "/routing nexthop"],
  ["routing-bfd", "/routing bfd"],
  ["routing-gmp", "/routing gmp"],
  ["routing-rpki", "/routing rpki"],
  ["radius", "/radius"],
  ["l2tp", "/interface l2tp"],
  ["pptp", "/interface pptp"],
  ["sstp", "/interface sstp"],
  ["queue-interface", "/queue interface"],
  ["poe", "/interface ethernet"],
  ["switch-settings", "/interface ethernet switch"],
  ["switch-port", "/interface ethernet switch port"],
  ["switch-port-isolation", "/interface ethernet switch port-isolation"],
  ["switch-rule", "/interface ethernet switch rule"],
  ["dot1x-server", "/interface dot1x server"],
  ["dot1x-client", "/interface dot1x client"],
  ["disk", "/disk"],
  ["neighbor", "/ip neighbor"],
  ["tool-bandwidth-server", "/tool bandwidth-server"],
  ["tool-graphing", "/tool graphing"],
  ["tool-mac-server", "/tool mac-server"],
  ["tool-romon", "/tool romon"],
  ["tool-sms", "/tool sms"],
  ["tool-traffic-generator", "/tool traffic-generator"],
  ["tool-traffic-monitor", "/tool traffic-monitor"],
  ["tool-sniffer", "/tool sniffer"],
  ["tool-flood-ping", "/ping"],
  ["tool-ip-scan", "/tool ip-scan"],
  ["tool-profile", "/tool profile"],
  ["tool-speed-test", "/tool speed-test"],
  ["server-pulse", "/system resource"],
]);

/** Produce a valid, harmless lookup key from each required Zod field. */
function fixtureArgs(shape: z.ZodRawShape): Record<string, unknown> | null {
  const schema = z.toJSONSchema(z.object(shape)) as {
    required?: string[];
    properties?: Record<string, { type?: string; enum?: unknown[]; default?: unknown }>;
  };
  const args: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const prop = schema.properties?.[key];
    if (!prop) return null;
    if (prop.default !== undefined) continue;
    if (prop.enum?.length) args[key] = prop.enum[0];
    else if (prop.type === "boolean") args[key] = false;
    else if (prop.type === "integer" || prop.type === "number") args[key] = 1;
    else if (prop.type === "string") {
      args[key] = /(?:subnet|network|prefix)/.test(key)
        ? "192.0.2.0/24"
        : /(?:address|ip$|host$|server$)/.test(key)
          ? "192.0.2.1"
          : /(?:^id$|_id$|^number$)/.test(key)
            ? "*1"
            : "fixture";
    } else return null;
  }
  const parsed = z.object(shape).safeParse(args);
  return parsed.success ? parsed.data : null;
}

/** Add a valid optional filter to exercise real selection paths, not just default inventory. */
function filteredArgs(shape: z.ZodRawShape): Record<string, unknown> | null {
  const minimal = fixtureArgs(shape);
  if (!minimal) return null;
  const schema = z.toJSONSchema(z.object(shape)) as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (key in minimal || key === "device") continue;
    const candidate =
      prop.enum?.[0] ??
      (prop.type === "boolean"
        ? true
        : prop.type === "number" || prop.type === "integer"
          ? 1
          : prop.type === "string"
            ? /(?:address|ip$|host$)/.test(key)
              ? "192.0.2.1"
              : "fixture"
            : undefined);
    if (candidate === undefined) continue;
    const parsed = z.object(shape).safeParse({ ...minimal, [key]: candidate });
    if (parsed.success) return parsed.data;
  }
  return null;
}

const cases = moduleCatalog.flatMap((module) => {
  const menu = menus.get(module.slug);
  if (!menu) return [];
  return module.tools.flatMap((tool) => {
    if (!/^(list|get)_/.test(tool.name) || tool.annotations.readOnlyHint !== true) return [];
    if (
      [
        "list_ovpn_sessions",
        "get_container",
        "get_routeros_container_guide",
        "get_flow_collector_health",
      ].includes(tool.name)
    )
      return [];
    if (!tool.inputSchema) return [];
    const args = fixtureArgs(tool.inputSchema);
    if (!args) return [];
    const actualMenu =
      tool.name === "list_ports" || tool.name === "get_port"
        ? "/port"
        : tool.name === "get_regulatory"
          ? "/interface wifi"
          : menu;
    return [{ name: tool.name, menu: actualMenu, tool, args }];
  });
});

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();
beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  read.mockReset();
  read.mockImplementation(async (command) =>
    command.includes("count-only") ? "1" : "0 name=fixture running=yes",
  );
});
afterEach(() => setConfig(initial));

test("inventory contract covers a substantial set of router read handlers", () => {
  expect(cases.length).toBeGreaterThan(100);
  expect(new Set(cases.map((item) => item.menu)).size).toBeGreaterThan(10);
});

test.each(cases)(
  "$name reads its RouterOS menu without a mutation",
  async ({ tool, args, menu }) => {
    const result = await tool.handler(args as never, ctx);
    expect(result).toBeTypeOf("string");
    if (typeof result !== "string") throw new Error("Expected a rendered inventory report");
    expect(result.trim().length).toBeGreaterThan(0);
    expect(read).toHaveBeenCalled();
    for (const [command, commandContext] of read.mock.calls) {
      expect(commandContext).toBe(ctx);
      expect(command).toContain(menu);
      expect(command).not.toMatch(/\b(?:add|set|remove|enable|disable|reset|save|import)\b/);
      expect(command).toMatch(/\b(?:print|get|monitor|:put)\b/);
    }
  },
);

test.each(cases)(
  "$name handles an empty RouterOS inventory without a mutation",
  async ({ tool, args, menu }) => {
    read.mockImplementation(async (issued) => (issued.includes("count-only") ? "0" : ""));
    const result = await tool.handler(args as never, ctx);
    expect(result).toBeTypeOf("string");
    if (typeof result !== "string") throw new Error("Expected an empty-inventory explanation");
    expect(result.trim().length).toBeGreaterThan(0);
    expect(read).toHaveBeenCalled();
    expect(read.mock.calls.some(([issued]) => issued.includes(menu))).toBe(true);
    expect(read.mock.calls.every(([, target]) => target === ctx)).toBe(true);
  },
);

const filteredCases = cases.flatMap(({ tool, menu }) => {
  const args = tool.inputSchema && filteredArgs(tool.inputSchema);
  return args ? [{ name: tool.name, tool, menu, args }] : [];
});

test.each(filteredCases)(
  "$name applies a valid optional read filter without a write",
  async ({ tool, args, menu }) => {
    const minimal = fixtureArgs(tool.inputSchema!);
    if (!minimal) throw new Error(`No minimal fixture for ${tool.name}`);
    await tool.handler(minimal as never, ctx);
    const base = read.mock.calls.map(([issued]) => issued);
    read.mockClear();
    const result = await tool.handler(args as never, ctx);
    expect(result).toBeTypeOf("string");
    const issued = read.mock.calls.map(([text]) => text);
    expect(issued.some((text) => text.includes(menu))).toBe(true);
    expect(issued).not.toEqual(base);
    expect(
      issued.every((text) => !/\b(?:add|set|remove|enable|disable|reset|save|import)\b/.test(text)),
    ).toBe(true);
  },
);
