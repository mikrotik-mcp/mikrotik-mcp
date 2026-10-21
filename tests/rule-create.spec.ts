import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import { firewallFilterTools } from "../src/tools/firewall-filter";
import { firewallMangleTools } from "../src/tools/firewall-mangle";
import { firewallNatTools } from "../src/tools/firewall-nat";
import { ipv6FirewallFilterTools } from "../src/tools/ipv6-firewall-filter";
import { ipv6FirewallMangleTools } from "../src/tools/ipv6-firewall-mangle";
import { ipv6FirewallNatTools } from "../src/tools/ipv6-firewall-nat";
import { ipv6FirewallRawTools } from "../src/tools/ipv6-firewall-raw";
import { switchRuleTools } from "../src/tools/switch-rule";

const cases = [
  { name: "create_filter_rule", scope: "/ip firewall filter", tools: firewallFilterTools },
  { name: "create_nat_rule", scope: "/ip firewall nat", tools: firewallNatTools },
  { name: "create_mangle_rule", scope: "/ip firewall mangle", tools: firewallMangleTools },
  {
    name: "create_ipv6_filter_rule",
    scope: "/ipv6 firewall filter",
    tools: ipv6FirewallFilterTools,
  },
  { name: "create_ipv6_nat_rule", scope: "/ipv6 firewall nat", tools: ipv6FirewallNatTools },
  {
    name: "create_ipv6_mangle_rule",
    scope: "/ipv6 firewall mangle",
    tools: ipv6FirewallMangleTools,
  },
  { name: "create_ipv6_raw_rule", scope: "/ipv6 firewall raw", tools: ipv6FirewallRawTools },
  { name: "add_switch_rule", scope: "/interface ethernet switch rule", tools: switchRuleTools },
];

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const original = getConfig();
beforeEach(() => {
  command.mockReset();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { "MOM Afranet": { host: "192.0.2.1" } },
      defaultDevice: "MOM Afranet",
    }),
  );
});
afterEach(() => setConfig(original));

/** Exercise the public tool response without contacting the production firewall. */
function invoke(args: Record<string, unknown>, item = cases[0]) {
  let handler!: (args: Record<string, unknown>) => Promise<CallToolResult>;
  item.tools
    .find((tool) => tool.name === item.name)!
    .register({
      registerTool: (_name: string, _config: unknown, callback: typeof handler) => {
        handler = callback;
      },
    } as never);
  return handler({ device: "MOM Afranet", ...args });
}

test("an inserted management rule is read by its returned ID, never the last row", async () => {
  const details = "1 chain=input action=drop protocol=tcp dst-port=22 src-address-list=!MGMT-SSH";
  command.mockImplementation(async (cmd: string) => {
    if (cmd === ":foreach i in=[/ip firewall filter find] do={:put $i}") return "*A\n*B\n*F";
    if (cmd.startsWith(":put [/ip firewall filter add ")) return "*10\r\n";
    if (cmd.startsWith("/ip firewall filter add ")) return "";
    if (cmd === "/ip firewall filter print detail count-only") return "4";
    if (cmd.includes("print detail from=")) {
      throw new Error(
        "MikroTik command failed (exit code 1): no such item (/ip/firewall/filter/print; line 1)",
      );
    }
    if (cmd === "/ip firewall filter print detail where .id=*10") return details;
    throw new Error(`Unexpected command: ${cmd}`);
  });

  const result = await invoke({
    chain: "input",
    action: "drop",
    protocol: "tcp",
    dst_port: "22",
    src_address_list: "!MGMT-SSH",
    comment: "MCP SSH management: drop unlisted IPv4",
    place_before: "1",
    disabled: false,
    log: false,
  });
  expect(result.isError).toBeFalsy();
  expect(JSON.stringify(result.content)).toContain(details);
  expect(command).toHaveBeenCalledTimes(3);
  expect(command.mock.calls[1][0]).toContain("place-before=*B");
  expect(command.mock.calls[1][0]).toContain("src-address-list=!MGMT-SSH");
  expect(command.mock.calls.every(([, ctx]) => ctx.device === "MOM Afranet")).toBe(true);
});

test("a read-back exception preserves confirmed creation and warns against duplicate retries", async () => {
  command
    .mockResolvedValueOnce("*10")
    .mockRejectedValueOnce(
      new Error(
        "MikroTik command failed (exit code 1): no such item (/ip/firewall/filter/print; line 1)",
      ),
    );
  const result = await invoke({ chain: "input", action: "drop" });
  expect(result.isError).toBeFalsy();
  expect(JSON.stringify(result.content)).toContain("created (id *10)");
  expect(JSON.stringify(result.content)).toContain("Do not retry");
  expect(command).toHaveBeenCalledTimes(2);
});

test.each(cases)("$name captures its internal ID and reads only that item", async (item) => {
  const details =
    item.name === "add_switch_rule"
      ? "0 switch=switch1 ports=ether1 disabled=no"
      : "1 chain=input action=accept disabled=no";
  command.mockResolvedValueOnce("*2B\r\nwarning: device notice").mockResolvedValueOnce(details);
  const result = await invoke(
    { chain: "input", action: "accept", switch: "switch1", ports: "ether1" },
    item,
  );
  expect(result.isError).toBeFalsy();
  expect(JSON.stringify(result.content)).toContain("created successfully (id *2B)");
  expect(command).toHaveBeenCalledTimes(2);
  expect(command.mock.calls[0][0]).toMatch(new RegExp(`^:put \\[${item.scope} add `));
  expect(command.mock.calls[1][0]).toBe(`${item.scope} print detail where .id=*2B`);
});

test.each(cases.filter((item) => item.name !== "add_switch_rule"))(
  "$name resolves insertion ordinals before writing",
  async (item) => {
    command
      .mockResolvedValueOnce("*A\n*BC\n*F")
      .mockResolvedValueOnce("*10")
      .mockResolvedValueOnce("1 chain=input action=accept");
    const result = await invoke({ chain: "input", action: "accept", place_before: "1" }, item);
    expect(result.isError).toBeFalsy();
    expect(command).toHaveBeenCalledTimes(3);
    expect(command.mock.calls[0][0]).toBe(`:foreach i in=[${item.scope} find] do={:put $i}`);
    expect(command.mock.calls[1][0]).toContain("place-before=*BC");
    expect(command.mock.calls[2][0]).toBe(`${item.scope} print detail where .id=*10`);
  },
);

test.each(["", "5", "warning: existing rule *2B", "*2B; /system reset-configuration"])(
  "missing or untrusted creation ID %j never guesses a row or repeats the write",
  async (output) => {
    command.mockResolvedValueOnce(output);
    const result = await invoke({ chain: "input", action: "drop" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Do not retry creation");
    expect(command).toHaveBeenCalledTimes(1);
  },
);

test.each(["", "no such item", "Flags: X - disabled, I - invalid; D - dynamic"])(
  "unavailable read-back %j does not turn a confirmed write into a failed creation",
  async (output) => {
    command.mockResolvedValueOnce("*10").mockResolvedValueOnce(output);
    const result = await invoke({ chain: "input", action: "drop" });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("created (id *10)");
    expect(JSON.stringify(result.content)).toContain("Do not retry creation");
    expect(command).toHaveBeenCalledTimes(2);
  },
);

test("a rejected add is still a failure, not a confirmed creation", async () => {
  command.mockRejectedValueOnce(new Error("not enough permissions"));
  const result = await invoke({ chain: "input", action: "drop" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("not enough permissions");
  expect(JSON.stringify(result.content)).not.toContain("created");
  expect(command).toHaveBeenCalledTimes(1);
});

test("device-side add errors retain the existing error handling", async () => {
  command.mockResolvedValueOnce("failure: invalid value for protocol");
  const result = await invoke({ chain: "input", action: "drop" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("invalid value for protocol");
  expect(command).toHaveBeenCalledTimes(1);
});

test("an out-of-range insertion point fails before adding a rule", async () => {
  command.mockResolvedValueOnce("*A\n*B");
  const result = await invoke({ chain: "input", action: "drop", place_before: "9" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("place_before '9' does not exist");
  expect(command).toHaveBeenCalledTimes(1);
});

test("an explicit insertion ID is checked before creating", async () => {
  command
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("*10")
    .mockResolvedValueOnce("1 chain=input action=drop");
  const result = await invoke({ chain: "input", action: "drop", place_before: "*BC" });
  expect(result.isError).toBeFalsy();
  expect(command.mock.calls[0][0]).toBe("/ip firewall filter print count-only where .id=*BC");
  expect(command.mock.calls[1][0]).toContain("place-before=*BC");
});

test("invalid insertion syntax never reaches RouterOS", async () => {
  const result = await invoke({
    chain: "input",
    action: "drop",
    place_before: "1]; /system reboot",
  });
  expect(result.isError).toBe(true);
  expect(command).not.toHaveBeenCalled();
});

test("wrapping add in an expression preserves comment escaping and list negation", async () => {
  command.mockResolvedValueOnce("*10").mockResolvedValueOnce("1 chain=input action=drop");
  const result = await invoke({
    chain: "input",
    action: "drop",
    src_address_list: "!MGMT-SSH",
    comment: 'literal "]; :put $secret',
  });
  expect(result.isError).toBeFalsy();
  expect(command.mock.calls[0][0]).toBe(
    String.raw`:put [/ip firewall filter add chain=input action=drop src-address-list=!MGMT-SSH comment="literal \"]; :put \$secret"]`,
  );
});
