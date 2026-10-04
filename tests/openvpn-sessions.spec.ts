import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createContext } from "../src/core/context";
import { connectionDuration, openVpnUptime } from "../src/core/openvpn-sessions-model";
import {
  disconnectOpenVpnSession,
  listOpenVpnSessions,
  parseOpenVpnSessions,
  openVpnSessionsCommand,
  disconnectOpenVpnCommand,
} from "../src/core/openvpn-sessions";
import { openVpnRoutes } from "../src/observability/openvpn-routes";
const { run, allowed, safe } = vi.hoisted(() => ({
  run: vi.fn(),
  allowed: vi.fn(),
  safe: { isActive: false },
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: run }));
vi.mock("../src/core/scoped-access", () => ({ assertDeviceAccess: allowed }));
vi.mock("../src/core/runtime", () => ({
  resolveDeviceName: (name: string) => {
    if (name === "unknown") throw new Error("Unknown router");
    return name;
  },
}));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: () => safe }));

let ctx = createContext(undefined, "router");
const row = {
  ".id": "*A1",
  name: "ali",
  service: "ovpn",
  address: "10.8.0.2",
  "caller-id": "198.51.100.10",
  "session-id": "0x81000001",
  uptime: "1d02:03:04",
  encoding: "AES-256-GCM",
  radius: true,
};
beforeEach(() => {
  run.mockReset();
  allowed.mockReset();
  safe.isActive = false;
  ctx = createContext(undefined, crypto.randomUUID());
});
async function selection() {
  run.mockResolvedValueOnce(JSON.stringify([row]));
  const result = await listOpenVpnSessions(ctx);
  return result.sessions[0].disconnectToken!;
}
test.each([
  ["1w2d3h4m5s", 788645],
  ["1d02:03:04", 93784],
  ["00:00:00", 0],
  ["1.5s", 1],
  ["", null],
  ["unknown", null],
  ["00:66:00", null],
  ["1970-01-02T00:00:00Z", null],
])("parses explicit RouterOS duration %s", (value, expected) => {
  expect(openVpnUptime(value as string)).toBe(expected);
});
test("formats duration without wrapping days", () => {
  expect(connectionDuration(93784)).toBe("1d 02:03:04");
  expect(connectionDuration(null)).toBe("Unavailable");
});
test("reads only ovpn, projects no secrets and stringifies time and numeric session IDs", () => {
  const command = openVpnSessionsCommand();
  expect(command).toContain("service=ovpn");
  expect(command).toContain("json.no-string-conversion");
  expect(command).toContain('[:tostr ($row->"uptime")]');
  expect(command).not.toContain("/ppp secret");
  expect(command).not.toContain("count-only");
  expect(command).not.toContain(".proplist");
  expect(command.startsWith("{ ")).toBe(true);
  expect(parseOpenVpnSessions(JSON.stringify([row]))[0]).toMatchObject({
    name: "ali",
    radius: true,
    uptimeSeconds: 93784,
  });
  expect(parseOpenVpnSessions("[]")).toEqual([]);
});
test.each([
  "",
  "failure: denied",
  "{}",
  JSON.stringify([{ ...row, service: "sstp" }]),
  JSON.stringify([row, row]),
  JSON.stringify([{ ...row, "session-id": 123 }]),
])("does not turn an invalid or incomplete reply into no sessions: %s", (output) => {
  expect(() => parseOpenVpnSessions(output)).toThrow();
});
test("returns unknown uptime and prevents disconnect when identity is incomplete", async () => {
  run.mockResolvedValue(
    JSON.stringify([
      { ...row, uptime: "unreadable" },
      { ...row, ".id": "*A2", "session-id": "" },
    ]),
  );
  const r = await listOpenVpnSessions(ctx);
  expect(r.sessions.every((s) => !s.disconnectToken)).toBe(true);
  expect(r.sessions[0].uptimeSeconds).toBeNull();
});
test("coalesces reads, isolates routers and rechecks permission before cached responses", async () => {
  run.mockResolvedValue(JSON.stringify([row]));
  await Promise.all([listOpenVpnSessions(ctx), listOpenVpnSessions(ctx)]);
  expect(run).toHaveBeenCalledTimes(1);
  await listOpenVpnSessions(createContext(undefined, "other"));
  expect(run).toHaveBeenCalledTimes(2);
  allowed.mockImplementation((_d, _t, risk) => {
    if (risk !== "READ") throw new Error("read-only");
  });
  expect((await listOpenVpnSessions(ctx)).canDisconnect).toBe(false);
  allowed.mockImplementation(() => {
    throw new Error("access denied");
  });
  await expect(listOpenVpnSessions(ctx)).rejects.toThrow("access denied");
  expect(run).toHaveBeenCalledTimes(2);
});
test("requires a known explicit router, confirmation and a fresh router-bound token", async () => {
  await expect(listOpenVpnSessions(createContext())).rejects.toThrow("explicit");
  await expect(listOpenVpnSessions(createContext(undefined, "unknown"))).rejects.toThrow("Unknown");
  expect(run).not.toHaveBeenCalled();
  const token = await selection();
  await expect(
    disconnectOpenVpnSession({ token, confirm: true }, createContext(undefined, "wrong")),
  ).rejects.toThrow("another router");
  await expect(disconnectOpenVpnSession({ token, confirm: false }, ctx)).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  await expect(disconnectOpenVpnSession({ token, confirm: true }, ctx)).rejects.toThrow("expired");
  clock.mockRestore();
});
test("disconnects one exact ID with on-router identity/uptime guards; another same-name connection is untouched", async () => {
  const token = await selection();
  run
    .mockResolvedValueOnce("ovpn:sent")
    .mockResolvedValueOnce(JSON.stringify([{ ...row, ".id": "*A2", "session-id": "0x81000002" }]));
  const result = await disconnectOpenVpnSession({ token, confirm: true }, ctx);
  expect(result.status).toBe("disconnected");
  expect(result.message).toContain("Another connection");
  const command = run.mock.calls[1][0];
  expect(command).toContain(".id=*A1 service=ovpn");
  expect(command).toContain('!= "0x81000001"');
  expect(command).toContain('!= "10.8.0.2"');
  expect(command).toContain("/ppp active remove $id");
  expect(command).toContain("/ppp active get $id session-id");
  expect(command).toContain("[:totime");
  expect(command).not.toContain("remove [find name=");
  await expect(disconnectOpenVpnSession({ token, confirm: true }, ctx)).rejects.toThrow("expired");
  expect(run).toHaveBeenCalledTimes(3);
});
test("escapes username and caller ID rather than interpolating RouterOS statements", () => {
  const s = parseOpenVpnSessions(JSON.stringify([{ ...row, name: 'a"; /system reboot; $x' }]))[0];
  const command = disconnectOpenVpnCommand(s);
  expect(command).toContain('a\\"; /system reboot; \\$x');
});
test.each(["ovpn:gone", "ovpn:changed", "failure: permission denied"])(
  "handles vanished/changed/rejected sessions without retry: %s",
  async (output) => {
    const token = await selection();
    run.mockResolvedValueOnce(output);
    if (output === "ovpn:changed")
      await expect(disconnectOpenVpnSession({ token, confirm: true }, ctx)).rejects.toThrow(
        "changed",
      );
    else
      expect((await disconnectOpenVpnSession({ token, confirm: true }, ctx)).status).toBe(
        output === "ovpn:gone" ? "already-ended" : "unverified",
      );
    expect(run).toHaveBeenCalledTimes(2);
  },
);
test("does not replay an uncertain write or claim success when readback fails", async () => {
  let token = await selection();
  run.mockRejectedValueOnce(new Error("SSH interrupted"));
  expect((await disconnectOpenVpnSession({ token, confirm: true }, ctx)).status).toBe("unverified");
  await expect(disconnectOpenVpnSession({ token, confirm: true }, ctx)).rejects.toThrow("expired");
  token = await selection();
  run.mockResolvedValueOnce("ovpn:sent").mockRejectedValueOnce(new Error("disconnected"));
  expect((await disconnectOpenVpnSession({ token, confirm: true }, ctx)).status).toBe("unverified");
  expect(run).toHaveBeenCalledTimes(5);
});
test("blocks writes in read-only policy and active Safe Mode before I/O", async () => {
  const token = await selection();
  safe.isActive = true;
  await expect(disconnectOpenVpnSession({ token, confirm: true }, ctx)).rejects.toThrow(
    "Safe Mode",
  );
  safe.isActive = false;
  allowed.mockImplementation(() => {
    throw new Error("read-only");
  });
  await expect(disconnectOpenVpnSession({ token, confirm: true }, ctx)).rejects.toThrow(
    "read-only",
  );
  expect(run).toHaveBeenCalledTimes(1);
});
test("dashboard requires device, rejects cross-origin writes and disables HTTP caching", async () => {
  const url = new URL(`http://localhost/api/openvpn/sessions?device=${ctx.device}`);
  run.mockResolvedValue("[]");
  const response = await openVpnRoutes(new Request(url), url);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toMatchObject({ sessions: [] });
  const missing = new URL("http://localhost/api/openvpn/sessions");
  expect((await openVpnRoutes(new Request(missing), missing))?.status).toBe(400);
  const write = new URL(`http://localhost/api/openvpn/disconnect?device=${ctx.device}`);
  const crossOrigin = await openVpnRoutes(
    new Request(write, { method: "POST", headers: { origin: "http://evil.test" }, body: "{}" }),
    write,
  );
  expect(crossOrigin?.status).toBe(403);
  const invalid = await openVpnRoutes(new Request(write, { method: "POST", body: "{" }), write);
  expect(invalid?.status).toBe(400);
  const expired = await openVpnRoutes(
    new Request(write, {
      method: "POST",
      body: JSON.stringify({ token: crypto.randomUUID(), confirm: true }),
    }),
    write,
  );
  expect(expired?.status).toBe(409);
  expect(run).toHaveBeenCalledTimes(1);
});
