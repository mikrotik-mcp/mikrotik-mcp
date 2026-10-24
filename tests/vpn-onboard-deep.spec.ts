import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { vpnOnboardTools } from "../src/tools/vpn-onboard";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown>) =>
  vpnOnboardTools.find((t) => t.name === name)!.handler(args as never, ctx);
const args = {
  interface: "wg-server",
  user: "alice",
  address: "10.20.0.50",
  endpoint: "vpn.example:13231",
  allowed_ips: "192.0.2.0/24",
  keepalive: "25",
  dns: "10.20.0.1",
};
const serverKey = Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

test("onboard adds peer with generated key and returns matching private config", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce(`public-key="${serverKey}"`);
  const result = await run("onboard_wireguard_user", args);
  const add = command.mock.calls[0][0] as string;
  const clientPub = add.match(/public-key=([^ ]+)/)?.[1];
  if (typeof result !== "string") throw new Error("Expected WireGuard configuration text");
  const privateKey = result.match(/PrivateKey = ([A-Za-z0-9+/]{43}=)/)?.[1];
  expect(Buffer.from(clientPub!, "base64")).toHaveLength(32);
  expect(Buffer.from(privateKey!, "base64")).toHaveLength(32);
  expect(add).toContain("allowed-address=10.20.0.50/32");
  expect(add).toContain('comment="vpn-user: alice"');
  expect(result).toContain(`PublicKey = ${serverKey}`);
  expect(result).toContain("DNS = 10.20.0.1");
  expect(result).toContain("AllowedIPs = 192.0.2.0/24");
  expect(command.mock.calls[1][0]).toBe('/interface wireguard print detail where name="wg-server"');
});

test("failed add skips key lookup and never exposes client private key", async () => {
  command.mockResolvedValueOnce("failure: duplicate");
  expect(await run("onboard_wireguard_user", args)).toBe(
    "Failed to add peer for 'alice': failure: duplicate",
  );
  expect(command).toHaveBeenCalledOnce();
});

test("missing server key reports partial setup", async () => {
  expect(await run("onboard_wireguard_user", args)).toContain(
    "Added the peer, but could not read the server public key",
  );
  expect(command).toHaveBeenCalledTimes(2);
});

test("revoke checks existence and handles remove rejection", async () => {
  command.mockResolvedValueOnce("0");
  expect(await run("revoke_wireguard_user", { user: "alice" })).toContain(
    "No WireGuard peer found",
  );
  expect(command).toHaveBeenCalledOnce();
  command.mockClear().mockResolvedValueOnce("1").mockResolvedValueOnce("failure: denied");
  expect(await run("revoke_wireguard_user", { user: "alice" })).toContain("Failed to revoke");
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    '/interface wireguard peers print count-only where comment="vpn-user: alice"',
    '/interface wireguard peers remove [find comment="vpn-user: alice"]',
  ]);
});
