import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { moduleCatalog } from "../src/tools";

const command = vi.hoisted(() => vi.fn<(command: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const menus = new Map<string, string>([
  ["bridge", "/interface bridge"],
  ["ip-address", "/ip address"],
  ["ip-pool", "/ip pool"],
  ["dhcp", "/ip dhcp-server"],
  ["dns", "/ip dns"],
  ["ipv6-firewall-filter", "/ipv6 firewall filter"],
  ["ipv6-firewall-nat", "/ipv6 firewall nat"],
  ["ipv6-firewall-mangle", "/ipv6 firewall mangle"],
  ["ipv6-firewall-raw", "/ipv6 firewall raw"],
  ["firewall-filter", "/ip firewall filter"],
  ["firewall-nat", "/ip firewall nat"],
  ["firewall-mangle", "/ip firewall mangle"],
  ["wireguard", "/interface wireguard"],
  ["queue", "/queue"],
  ["users", "/user"],
  ["ipv6-address", "/ipv6 address"],
  ["ipv6-dhcp-client", "/ipv6 dhcp-client"],
  ["ipv6-dhcp-relay", "/ipv6 dhcp-relay"],
  ["ipv6-dhcp-server", "/ipv6 dhcp-server"],
  ["ipv6-firewall-address-list", "/ipv6 firewall address-list"],
  ["ipv6-nd", "/ipv6 nd"],
  ["ipv6-pool", "/ipv6 pool"],
  ["ipv6-route", "/ipv6 route"],
  ["routing-id", "/routing id"],
  ["routing-table", "/routing table"],
  ["routing-rule", "/routing rule"],
  ["routing-filter", "/routing filter"],
  ["routing-bfd", "/routing bfd"],
  ["routing-bgp", "/routing bgp"],
  ["routing-ospf", "/routing ospf"],
  ["routing-rip", "/routing rip"],
  ["routing-pimsm", "/routing pimsm"],
  ["routing-igmp-proxy", "/routing igmp-proxy"],
  ["address-list", "/ip firewall address-list"],
  ["ip-dhcp-client", "/ip dhcp-client"],
  ["ipsec", "/ip ipsec"],
  ["radius", "/radius"],
  ["l2tp", "/interface l2tp"],
  ["pptp", "/interface pptp"],
  ["sstp", "/interface sstp"],
  ["openvpn", "/interface ovpn"],
  ["traffic-flow", "/ip traffic-flow"],
  ["queue-interface", "/queue interface"],
  ["switch-port", "/interface ethernet switch port"],
  ["switch-rule", "/interface ethernet switch rule"],
  ["dot1x-server", "/interface dot1x server"],
  ["dot1x-client", "/interface dot1x client"],
  ["disk", "/disk"],
  ["scheduler", "/system scheduler"],
  ["logging", "/system logging"],
  ["system", "/system"],
  ["system-config", "/system"],
  ["ip-service", "/ip service"],
  ["ip-ssh", "/ip ssh"],
  ["ip-cloud", "/ip cloud"],
  ["certificate", "/certificate"],
  ["ppp", "/ppp"],
  ["user-manager", "/user-manager"],
  ["tool-graphing", "/tool graphing"],
  ["tool-mac-server", "/tool mac-server"],
  ["tool-romon", "/tool romon"],
  ["tool-sms", "/tool sms"],
  ["tool-traffic-generator", "/tool traffic-generator"],
  ["tool-traffic-monitor", "/tool traffic-monitor"],
  ["tool-sniffer", "/tool sniffer"],
  ["queue-interface", "/queue interface"],
]);

/** Supply parseable, non-sensitive arguments only; no router connection exists in this suite. */
function argsFor(shape: z.ZodRawShape): Record<string, unknown> | null {
  const schema = z.toJSONSchema(z.object(shape)) as {
    required?: string[];
    properties?: Record<string, { type?: string; enum?: unknown[]; default?: unknown }>;
  };
  const input: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const property = schema.properties?.[key];
    if (!property) return null;
    if (property.default !== undefined) continue;
    if (property.enum?.length) input[key] = property.enum[0];
    else if (property.type === "boolean") input[key] = false;
    else if (property.type === "integer" || property.type === "number") input[key] = 1;
    else if (property.type === "string") {
      input[key] = /(?:^id$|_id$|^rule_id$|^entry_id$)/.test(key)
        ? "*A"
        : /(?:network|prefix|subnet)/.test(key)
          ? "192.0.2.0/24"
          : /(?:^address$|_address$|^ip$|^server$)/.test(key)
            ? "192.0.2.1"
            : /^(?:interface|in_interface|out_interface)$/.test(key)
              ? "ether1"
              : key === "password"
                ? "fixture-password"
                : "fixture";
    } else return null;
  }
  if ("comment" in shape) input.comment = "coverage-contract";
  if ("new_name" in shape && Object.keys(input).length === 1) input.new_name = "fixture-renamed";
  if ("action" in shape && "chain" in input && input.chain === "srcnat")
    input.action = "masquerade";
  const parsed = z.object(shape).safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Exercise optional RouterOS settings as a second, device-free configuration path. */
function argsWithOptionalSettings(shape: z.ZodRawShape): Record<string, unknown> | null {
  const required = argsFor(shape);
  if (!required) return null;
  const schema = z.toJSONSchema(z.object(shape)) as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };
  const result = { ...required };
  let added = 0;
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (key in result || key === "device") continue;
    const candidate = property.enum?.length
      ? property.enum[0]
      : property.type === "boolean"
        ? true
        : property.type === "integer" || property.type === "number"
          ? 1
          : property.type === "string"
            ? /(?:network|prefix|subnet|allowed_address)/.test(key)
              ? "192.0.2.0/24"
              : key === "place_before"
                ? "0"
                : /(?:^address$|_address$|^ip$|_ip$|^server$|_server$)/.test(key)
                  ? "192.0.2.1"
                  : /(?:interface|port_name)/.test(key)
                    ? "ether1"
                    : /(?:timeout|interval|delay|duration)/.test(key)
                      ? "1m"
                      : "fixture"
            : undefined;
    if (candidate === undefined) continue;
    const parsed = z.object(shape).safeParse({ ...result, [key]: candidate });
    if (parsed.success) {
      Object.assign(result, parsed.data);
      added++;
    }
  }
  return added > 0 ? result : null;
}

const cases = moduleCatalog.flatMap((module) => {
  const menu = menus.get(module.slug);
  if (!menu) return [];
  return module.tools.flatMap((tool) => {
    if (!/^(create|add|set|update|enable|disable|remove)_/.test(tool.name)) return [];
    if (
      [
        "create_basic_firewall_setup",
        "update_switch_port",
        "set_dhcp_client",
        "update_igmp_proxy_settings",
        "set_l2tp_server",
        "set_pptp_server",
        "set_sstp_server",
        "set_ovpn_server",
        "set_radius_incoming",
        "set_traffic_flow_settings",
        "set_ip_service",
        "set_ssh_settings",
        "set_ip_cloud",
        "set_user_manager_settings",
        "set_system_clock",
        "set_leds_settings",
        "set_note",
        "set_ntp_server",
        "set_port",
        "set_watchdog",
        "update_sniffer_settings",
        "update_romon",
        "update_sms_settings",
      ].includes(tool.name)
    )
      return [];
    if (!tool.inputSchema) return [];
    const args = argsFor(tool.inputSchema);
    if (!args) return [];
    return [
      {
        name: tool.name,
        menu:
          tool.name === "create_dhcp_pool"
            ? "/ip pool"
            : tool.name.endsWith("_script")
              ? "/system script"
              : menu,
        tool,
        args,
      },
    ];
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
  command.mockReset();
  command.mockImplementation(async (text) => {
    if (text.includes("count-only")) {
      if (
        text.includes("/ip pool used ") ||
        text.includes("/ip dhcp-server print count-only where address-pool=") ||
        text.includes("/user print count-only where group=")
      )
        return "0";
      return "1";
    }
    if (text.startsWith(":foreach")) return "*A\n*B";
    if (text.startsWith(":put [") && text.includes(" add ")) return "*A";
    if (text.includes(" print")) return "0 name=fixture disabled=no";
    return "";
  });
});
afterEach(() => setConfig(initial));

test("router mutation contract spans independent RouterOS menus", () => {
  expect(cases.length).toBeGreaterThan(70);
  expect(new Set(cases.map((entry) => entry.menu)).size).toBeGreaterThan(10);
});

test.each(cases)(
  "$name issues a scoped RouterOS write with a confirmation path",
  async ({ tool, args, menu }) => {
    const result = await tool.handler(args as never, ctx);
    expect(result).toBeTypeOf("string");
    expect(command).toHaveBeenCalled();
    const issued = command.mock.calls.map(([text]) => text);
    expect(issued.some((text) => text.includes(menu))).toBe(true);
    expect(
      issued.some((text) => /\b(?:add|set|remove|enable|disable|reset|import)\b/.test(text)),
    ).toBe(true);
    expect(command.mock.calls.every(([, target]) => target === ctx)).toBe(true);
  },
);

const optionalCases = cases.flatMap(({ tool, menu }) => {
  const args = tool.inputSchema && argsWithOptionalSettings(tool.inputSchema);
  if (args && (tool.name === "add_dot1x_server" || tool.name === "update_dot1x_server"))
    delete args.reauth_timeout; // RouterOS accepts either legacy timeout or the 7.25 period, not both.
  return args ? [{ name: tool.name, tool, menu, args }] : [];
});

test.each(optionalCases)(
  "$name applies valid optional settings within its RouterOS scope",
  async ({ tool, args, menu }) => {
    const minimalArgs = argsFor(tool.inputSchema!);
    if (!minimalArgs) throw new Error(`No minimal fixture for ${tool.name}`);
    await tool.handler(minimalArgs as never, ctx);
    const minimalIssued = command.mock.calls.map(([text]) => text);
    command.mockClear();
    const result = await tool.handler(args as never, ctx);
    expect(result).toBeTypeOf("string");
    const issued = command.mock.calls.map(([text]) => text);
    expect(issued.some((text) => text.includes(menu))).toBe(true);
    expect(
      issued.some((text) => /\b(?:add|set|remove|enable|disable|reset|import)\b/.test(text)),
    ).toBe(true);
    expect(command.mock.calls.every(([, target]) => target === ctx)).toBe(true);
    expect(issued).not.toEqual(minimalIssued);
  },
);
