/// <reference types="bun" />
/** WireGuard user onboarding: free addresses, expiry, a QR code, and revocation. */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import {
  isDate,
  isExpired,
  nextFreeAddress,
  qrPng,
  readUserComment,
  userComment,
  userCommentPattern,
} from "../src/core/wireguard-portal";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const { vpnOnboardTools } = await import("../src/tools/vpn-onboard");

const ctx = { device: "edge", info() {}, error() {} };
const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const tool = vpnOnboardTools.find((t) => t.name === name)!;
  const result = await (tool.handler as (a: unknown, c: unknown) => Promise<unknown>)(
    z.object(tool.inputSchema).parse(args),
    ctx,
  );
  return String(result);
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-"));
  vi.stubEnv("MIKROTIK_WIREGUARD_DIR", dir);
  command.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

test("the lowest free host is picked, never the server's or a used one", () => {
  expect(nextFreeAddress("10.20.0.1/24", [])).toBe("10.20.0.2");
  expect(nextFreeAddress("10.20.0.1/24", ["10.20.0.2/32", "10.20.0.3/32,10.20.0.4/32"])).toBe(
    "10.20.0.5",
  );
  expect(nextFreeAddress("10.20.0.5/30", ["10.20.0.6/32"])).toBeNull();
  expect(nextFreeAddress("10.20.0.254/24", ["10.20.0.1"])).toBe("10.20.0.2");
  expect(nextFreeAddress("fd00::1/64", [])).toBeNull();
  expect(nextFreeAddress("10.20.0.1/24", ["10.20.0.0/28"])).toBe("10.20.0.16");
  expect(nextFreeAddress("10.20.0.1/24", ["0.0.0.0/0"])).toBeNull();
});

test("the comment carries the user and the expiry, and expiry is by calendar day", () => {
  expect(userComment("alice")).toBe("vpn-user: alice");
  expect(readUserComment(userComment("alice", "2026-12-31"))).toEqual({
    user: "alice",
    expires: "2026-12-31",
  });
  expect(readUserComment("vpn-user: bob laptop")).toEqual({ user: "bob laptop" });
  expect(readUserComment("uplink")).toBeNull();
  expect(isDate("2026-12-31")).toBe(true);
  expect(isDate("2026-13-41")).toBe(false);
  expect(isExpired("2026-01-01", "2026-01-02")).toBe(true);
  expect(isExpired("2026-01-02", "2026-01-02")).toBe(false);
  expect(isExpired(undefined, "2026-01-02")).toBe(false);
  // A label is matched as text: its dot is not "any character".
  expect(userCommentPattern("a.b")).toBe("^vpn-user: a\\.b( expires=[0-9-]+)?$");
});

test("the QR code is a valid PNG with a quiet zone", () => {
  const png = qrPng("[Interface]\nPrivateKey = x");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const side = png.readUInt32BE(16);
  expect(png.readUInt32BE(20)).toBe(side);
  const idatLength = png.readUInt32BE(33);
  const pixels = inflateSync(png.subarray(41, 41 + idatLength));
  expect(pixels.length).toBe((side + 1) * side);
  // The first rows are the white quiet zone; a finder pattern is dark after it.
  expect(pixels[1]).toBe(255);
  expect(pixels[4 * 8 * (side + 1) + 1 + 4 * 8]).toBe(0);
});

const PEERS = ` 0   interface="wg0" public-key="AAAA" allowed-address=10.20.0.2/32 comment="vpn-user: old expires=2020-01-01"
 1   interface="wg0" public-key="BBBB" allowed-address=10.20.0.3/32 comment="vpn-user: keep"
 2 X interface="wg0" public-key="CCCC" allowed-address=10.20.0.4/32 disabled=yes comment="vpn-user: gone expires=2020-01-01"
 3   interface="wg0" public-key="DDDD" allowed-address=10.20.0.9/32 comment="site link"`;

const router = async (cmd: string): Promise<string> => {
  if (cmd.startsWith("/interface wireguard peers print detail")) return PEERS;
  if (cmd.startsWith("/ip address print detail"))
    return ' 0   address=10.20.0.1/24 interface="wg0"';
  if (cmd.startsWith("/interface wireguard print detail"))
    return ` 0 name="wg0" public-key="${"S".repeat(43)}="`;
  if (cmd.includes("count-only")) return "1";
  return "";
};

test("onboarding picks an address, tags the peer and saves a private profile with a QR code", async () => {
  command.mockImplementation(router);
  const text = await run("onboard_wireguard_user", {
    interface: "wg0",
    user: "alice-phone",
    endpoint: "vpn.example.net:13231",
    expires: "2027-01-31",
    save: true,
  });
  const add = command.mock.calls.map((c) => String(c[0])).find((c) => c.includes("peers add"))!;
  expect(add).toContain("allowed-address=10.20.0.5/32");
  expect(add).toContain('comment="vpn-user: alice-phone expires=2027-01-31"');
  expect(text).toContain("IP 10.20.0.5/32, expires 2027-01-31");
  const conf = join(dir, "alice-phone.conf");
  expect(readFileSync(conf, "utf8")).toContain("Endpoint = vpn.example.net:13231");
  expect(statSync(conf).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "alice-phone.png")).size).toBeGreaterThan(200);

  // The same label twice, or a label that is not a safe file name, is refused.
  expect(
    await run("onboard_wireguard_user", { interface: "wg0", user: "keep", endpoint: "e:1" }),
  ).toContain("already exists");
  const tool = vpnOnboardTools.find((t) => t.name === "onboard_wireguard_user")!;
  expect(
    z.object(tool.inputSchema).safeParse({ interface: "wg0", user: "../x", endpoint: "e:1" })
      .success,
  ).toBe(false);
  // Email without the channel says so and still returns the profile.
  expect(
    await run("onboard_wireguard_user", {
      interface: "wg0",
      user: "bob",
      endpoint: "e:1",
      email_to: "b@example.net",
    }),
  ).toContain("NOT emailed: the alert email channel is not configured.");
});

test("users are listed with their expiry, and only expired ones are disabled", async () => {
  command.mockImplementation(router);
  const listed = await run("list_wireguard_users", {});
  expect(listed).toContain(
    "old  interface=wg0  address=10.20.0.2/32  expires=2020-01-01 (EXPIRED)",
  );
  expect(listed).toContain("keep  interface=wg0  address=10.20.0.3/32  expires=never");
  expect(listed).not.toContain("site link");

  expect(await run("expire_wireguard_users", {})).toContain(
    "DRY RUN: would disable 1 user(s): old",
  );
  command.mockClear();
  const done = await run("expire_wireguard_users", { apply: true });
  expect(done).toBe("Disabled 1 expired user(s): old (expired 2020-01-01).");
  const writes = command.mock.calls.map((c) => String(c[0])).filter((c) => !c.includes("print"));
  expect(writes).toEqual([
    '/interface wireguard peers disable [find comment~"^vpn-user: old( expires=[0-9-]+)?\\$"]',
  ]);
  // Removing also takes the one that is already disabled.
  expect(await run("expire_wireguard_users", { action: "remove" })).toContain(
    "would remove 2 user(s)",
  );
});

test("revoke finds a user with or without an expiry, and quotes the label once", async () => {
  command.mockImplementation(router);
  expect(await run("revoke_wireguard_user", { user: "bob laptop" })).toContain("revoked");
  expect(command.mock.calls[0]![0]).toBe(
    '/interface wireguard peers print count-only where comment~"^vpn-user: bob laptop( expires=[0-9-]+)?\\$"',
  );
});
