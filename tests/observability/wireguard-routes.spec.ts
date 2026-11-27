/** Dashboard routes for WireGuard users: same handlers as the tools, and no key in the audit record. */
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";

const command = vi.hoisted(() => vi.fn());
const recorded = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../../src/observability/recorder", () => ({ recordToolCall: recorded }));
const { wireguardRoutes } = await import("../../src/observability/wireguard-routes");

const original = getConfig();
beforeEach(() => {
  command.mockReset();
  recorded.mockReset();
  setConfig(
    MikrotikConfigSchema.parse({ devices: { edge: { host: "10.0.0.1" } }, defaultDevice: "edge" }),
  );
});
afterEach(() => setConfig(original));

const PEERS = ` 0   interface="wg0" allowed-address=10.20.0.2/32 comment="vpn-user: old expires=2020-01-01" last-handshake=1h2m
 1   interface="wg0" allowed-address=10.20.0.9/32 comment="site link"`;
const router = async (cmd?: string): Promise<string> => {
  const text = String(cmd);
  if (text.startsWith("/interface wireguard peers print detail")) return PEERS;
  if (text.startsWith("/interface wireguard print detail"))
    return ` 0 name="wg0" public-key="${"S".repeat(43)}="`;
  if (text.startsWith("/ip address print detail")) return ' 0 address=10.20.0.1/24 interface="wg0"';
  if (text.includes("count-only")) return "1";
  return "";
};
const call = (path: string, body?: unknown, origin?: string): Promise<Response | null> =>
  wireguardRoutes(
    new Request(`http://x${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: origin ? { origin } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://x${path}`),
  );

test("users are listed with interfaces, expiry and handshake; other peers are left out", async () => {
  command.mockImplementation(router);
  const data = await (await call("/api/wireguard/users?device=edge"))!.json();
  expect(data.interfaces).toEqual(["wg0"]);
  expect(data.users).toEqual([
    {
      user: "old",
      interface: "wg0",
      address: "10.20.0.2/32",
      expires: "2020-01-01",
      expired: true,
      disabled: false,
      lastHandshake: "1h2m",
    },
  ]);
  expect((await call("/api/wireguard/users"))!.headers.get("cache-control")).toBe("no-store");
  expect(
    await wireguardRoutes(new Request("http://x/api/other"), new URL("http://x/api/other")),
  ).toBeNull();
});

test("numeric router counters, missing handshakes, and clock durations are returned per peer", async () => {
  command.mockImplementation(async (cmd: string) =>
    cmd.startsWith(":put")
      ? JSON.stringify([
          { name: "client", interface: "wg0", rx: 1048576, tx: 5, "last-handshake": "00:02:30" },
          { name: "idle", interface: "wg0", rx: 0, tx: 0, disabled: true },
        ])
      : ' 0 name="wg0" listen-port=51820 disabled=no',
  );
  const d = await (await call("/api/wireguard/users?device=edge"))!.json();
  expect(d.interfaceOptions[0].endpoint).toBe("10.0.0.1:51820");
  expect(d.peers[0]).toMatchObject({
    user: "client",
    managed: false,
    rx: 1048576,
    tx: 5,
    handshakeAt: d.observedAt - 150000,
  });
  expect(d.peers[1]).toMatchObject({ user: "idle", handshakeAt: null, disabled: true });
  expect(d.users).toEqual([]);
});

test("onboarding returns the profile to the browser and keeps the key out of the record", async () => {
  command.mockImplementation(router);
  const response = (await call("/api/wireguard/onboard", {
    device: "edge",
    interface: "wg0",
    user: "alice-phone",
    endpoint: "vpn.example.net:13231",
    expires: "2027-01-31",
  }))!;
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.config.startsWith("[Interface]\nPrivateKey = ")).toBe(true);
  expect(body.config).toContain("Address = 10.20.0.3/32");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const record = recorded.mock.calls[0]![0] as {
    output: string;
    args: Record<string, unknown>;
    risk: string;
  };
  expect(record.risk).toBe("WRITE");
  expect(record.output).toContain("onboarded");
  expect(JSON.stringify(record)).not.toContain("PrivateKey");

  // A label the tool refuses is a 400, and another site cannot post.
  expect(
    (await call("/api/wireguard/onboard", {
      device: "edge",
      interface: "wg0",
      user: "../x",
      endpoint: "e:1",
    }))!.status,
  ).toBe(400);
  expect(
    (await call("/api/wireguard/onboard", { device: "edge" }, "http://evil.example"))!.status,
  ).toBe(403);
});

test("revoke and expire run the tools and report their answer", async () => {
  command.mockImplementation(router);
  const revoked = await (await call("/api/wireguard/revoke", {
    device: "edge",
    user: "old",
  }))!.json();
  expect(revoked).toMatchObject({ ok: true });
  expect(recorded.mock.calls[0]![0]).toMatchObject({
    tool: "revoke_wireguard_user",
    risk: "DESTRUCTIVE",
  });
  const expired = await (await call("/api/wireguard/expire", {
    device: "edge",
    apply: true,
  }))!.json();
  expect(expired.message).toContain("Disabled 1 expired user(s): old");
  expect((await call("/api/wireguard/nope", { device: "edge" }))!.status).toBe(404);
});

test("a read-only server lists but does not change", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "10.0.0.1" } },
      defaultDevice: "edge",
      readOnly: true,
    }),
  );
  command.mockImplementation(router);
  expect((await call("/api/wireguard/users?device=edge"))!.status).toBe(200);
  await expect(call("/api/wireguard/revoke", { device: "edge", user: "old" })).rejects.toThrow(
    /read-only/,
  );
  expect(command.mock.calls.some((c) => String(c[0]).includes("remove"))).toBe(false);
});
