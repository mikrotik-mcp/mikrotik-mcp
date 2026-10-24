import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { tunnelTools } from "../src/tools/tunnels";

const command = vi.hoisted(() => vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tunnelTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args) as never, ctx);
}

beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

describe.each([
  [
    "gre",
    "GRE",
    { name: "gre1", remote_address: "192.0.2.2", keepalive: "10s,3", clamp_tcp_mss: false },
  ],
  ["ipip", "IPIP", { name: "ipip1", remote_address: "192.0.2.2", keepalive: "10s,3" }],
  ["eoip", "EoIP", { name: "eoip1", remote_address: "192.0.2.2", tunnel_id: 17 }],
  ["vxlan", "VXLAN", { name: "vxlan1", vni: 42, port: 4789, allow_fast_path: false }],
] as const)("%s tunnel lifecycle", (slug, label, createArgs) => {
  const name = createArgs.name;
  const menu = `/interface ${slug}`;

  test("create builds a typed command then verifies by name", async () => {
    command.mockResolvedValueOnce("").mockResolvedValueOnce("0 name=fixture running=yes");
    const result = await run(`create_${slug}_tunnel`, {
      ...createArgs,
      comment: "remote office",
      disabled: true,
    });
    expect(result).toContain("created successfully");
    expect(command.mock.calls[0]?.[0]).toContain(`${menu} add name=${name}`);
    expect(command.mock.calls[0]?.[0]).toContain('comment="remote office"');
    expect(command.mock.calls[0]?.[0]).toContain("disabled=yes");
    expect(command.mock.calls[1]?.[0]).toBe(`${menu} print detail where name="${name}"`);
    expect(command.mock.calls.every(([, target]) => target === ctx)).toBe(true);
  });

  test("create failure skips verification; empty verification reports uncertainty", async () => {
    command.mockResolvedValueOnce("failure: invalid argument");
    expect(await run(`create_${slug}_tunnel`, createArgs)).toContain(
      `Failed to create ${label} tunnel`,
    );
    expect(command).toHaveBeenCalledTimes(1);
    command.mockReset();
    command.mockResolvedValue("");
    expect(await run(`create_${slug}_tunnel`, createArgs)).toContain("unable to verify");
  });

  test("list and get show data or an explicit empty result", async () => {
    command.mockResolvedValueOnce("0 name=fixture");
    expect(await run(`list_${slug}_tunnels`, { name_filter: "site" })).toContain("fixture");
    expect(command.mock.calls[0]?.[0]).toBe(`${menu} print where name~"site"`);
    command.mockResolvedValueOnce("");
    expect(await run(`list_${slug}_tunnels`)).toContain("No");
    command.mockResolvedValueOnce("0 name=fixture");
    expect(await run(`get_${slug}_tunnel`, { name })).toContain("fixture");
    command.mockResolvedValueOnce("");
    expect(await run(`get_${slug}_tunnel`, { name })).toContain("not found");
  });

  test("remove checks existence, handles failure, and confirms success", async () => {
    command.mockResolvedValueOnce("0");
    expect(await run(`remove_${slug}_tunnel`, { name })).toContain("not found");
    expect(command).toHaveBeenCalledTimes(1);
    command.mockReset();
    command.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: denied");
    expect(await run(`remove_${slug}_tunnel`, { name })).toContain("Failed to remove");
    expect(command.mock.calls[1]?.[0]).toBe(`${menu} remove [find name="${name}"]`);
    command.mockReset();
    command.mockResolvedValueOnce("1").mockResolvedValueOnce("");
    expect(await run(`remove_${slug}_tunnel`, { name })).toContain("removed successfully");
  });
});

test("GRE optional fields preserve explicit false and quote the secret", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce("verified");
  await run("create_gre_tunnel", {
    name: "gre1",
    remote_address: "192.0.2.2",
    local_address: "192.0.2.1",
    ipsec_secret: "a b",
    clamp_tcp_mss: false,
    allow_fast_path: true,
  });
  expect(command.mock.calls[0]?.[0]).toContain('ipsec-secret="a b"');
  expect(command.mock.calls[0]?.[0]).toContain("clamp-tcp-mss=no");
  expect(command.mock.calls[0]?.[0]).toContain("allow-fast-path=yes");
});
