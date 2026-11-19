/** IPv6 prefix follow: a DHCPv6 client script keeps address lists on today's prefix. */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const { buildPrefixScript, ipv6PrefixFollowTools } =
  await import("../src/tools/ipv6-prefix-follow");

const ctx = { device: "edge", info() {}, error() {} };
const tool = (name: string) => ipv6PrefixFollowTools.find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown>): Promise<string> =>
  String(
    await (tool(name).handler as (a: unknown, c: unknown) => Promise<unknown>)(
      z.object(tool(name).inputSchema).parse(args),
      ctx,
    ),
  );

beforeEach(() => command.mockReset());

test("the script rewrites the prefix list and one list for each host", () => {
  expect(buildPrefixScript("isp-prefix", [{ name: "web", suffix: "::1:0:0:0:10" }])).toBe(
    [
      "# pd-follow: isp-prefix",
      ':if ($"pd-valid" = 1) do={',
      ':local pfx $"pd-prefix"',
      ':local base [:toip6 [:pick $pfx 0 [:find $pfx "/"]]]',
      '/ipv6 firewall address-list remove [find comment="pd-follow: isp-prefix"]',
      '/ipv6 firewall address-list add list=isp-prefix address=$pfx comment="pd-follow: isp-prefix"',
      '/ipv6 firewall address-list add list=isp-prefix-web address=($base | [:toip6 "::1:0:0:0:10"]) comment="pd-follow: isp-prefix"',
      "}",
    ].join("\n"),
  );
});

test("names and suffixes that could change the stored script are refused", () => {
  const schema = z.object(tool("follow_ipv6_prefix").inputSchema);
  const ok = { interface: "ether1" };
  expect(schema.safeParse(ok).success).toBe(true);
  expect(schema.safeParse({ ...ok, list: 'x" ; /system reset-configuration ; "' }).success).toBe(
    false,
  );
  expect(
    schema.safeParse({ ...ok, hosts: [{ name: "web", suffix: '::10"] ; /user add name=x' }] })
      .success,
  ).toBe(false);
  expect(schema.safeParse({ ...ok, hosts: [{ name: "a b", suffix: "::10" }] }).success).toBe(false);
  expect(
    schema.safeParse({ ...ok, hosts: [{ name: "web", suffix: "2001:db8::10" }] }).success,
  ).toBe(false);
});

const client = (fields: string) => async (cmd?: string) =>
  String(cmd).startsWith("/ipv6 dhcp-client print") ? ` 0 interface="ether1" ${fields}` : "";

test("it needs a client that requests a prefix, and keeps a script it did not write", async () => {
  command.mockResolvedValue("");
  expect(await run("follow_ipv6_prefix", { interface: "ether1" })).toContain("No DHCPv6 client");
  command.mockImplementation(client("request=address"));
  expect(await run("follow_ipv6_prefix", { interface: "ether1" })).toContain(
    "does not request a prefix",
  );
  command.mockImplementation(client('request=prefix script=":log info hello"'));
  expect(await run("follow_ipv6_prefix", { interface: "ether1", apply: true })).toContain(
    "already has a script that this tool did not write",
  );
  expect(command.mock.calls.some((c) => String(c[0]).includes(" set "))).toBe(false);
});

test("a dry run shows the script; applying installs it as one quoted value", async () => {
  command.mockImplementation(client("request=address,prefix"));
  const args = { interface: "ether1", hosts: [{ name: "web", suffix: "::10" }] };
  const dry = await run("follow_ipv6_prefix", args);
  expect(dry).toContain("DRY RUN");
  expect(dry).toContain("It maintains: isp-prefix, isp-prefix-web");
  expect(command.mock.calls.some((c) => String(c[0]).includes(" set "))).toBe(false);

  const done = await run("follow_ipv6_prefix", { ...args, apply: true });
  expect(done).toContain("Installed.");
  const set = command.mock.calls.map((c) => String(c[0])).find((c) => c.includes(" set "))!;
  expect(
    set.startsWith(
      '/ipv6 dhcp-client set [find interface="ether1"] script="# pd-follow: isp-prefix\\n',
    ),
  ).toBe(true);
  // Inside the value every quote, dollar and newline is escaped: it is one string.
  expect(set).toContain(':if (\\$\\"pd-valid\\" = 1) do={');
  expect(set.endsWith('}"')).toBe(true);
});

test("unfollow clears only its own script and its own list entries", async () => {
  command.mockImplementation(client('request=prefix script="# pd-follow: isp-prefix\\n:if ..."'));
  expect(await run("unfollow_ipv6_prefix", { interface: "ether1" })).toBe(
    "Cleared the script and the entries of 'isp-prefix'.",
  );
  const sent = command.mock.calls.map((c) => String(c[0]));
  expect(sent).toContain('/ipv6 dhcp-client set [find interface="ether1"] script=""');
  expect(sent).toContain(
    '/ipv6 firewall address-list remove [find comment="pd-follow: isp-prefix"]',
  );

  command.mockReset();
  command.mockImplementation(client('request=prefix script=":log info mine"'));
  expect(await run("unfollow_ipv6_prefix", { interface: "ether1" })).toBe(
    "Cleared the entries of 'isp-prefix'.",
  );
  expect(command.mock.calls.some((c) => String(c[0]).includes("script="))).toBe(false);
});
