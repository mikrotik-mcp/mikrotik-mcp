import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { rootCauseTools } from "../src/tools/root-cause";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const original = getConfig();
const run = async (name: string, args: Record<string, unknown>) => {
  const tool = rootCauseTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  const result = await tool.handler(args as never, ctx);
  return typeof result === "string" ? result : result.text;
};
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
});
afterEach(() => setConfig(original));

test("routing diagnosis parses OSPF and both BGP output variants", async () => {
  command.mockImplementation(
    async (text) =>
      ({
        "/routing ospf neighbor print detail":
          "0 neighbor-id=1.1.1.1 address=192.0.2.2 state=Full interface=ether1",
        "/routing bgp session print detail":
          "0 name=edge remote.address=192.0.2.3 state=established",
        "/ip route print detail": "0 As dst-address=0.0.0.0/0 gateway=192.0.2.1",
      })[text] ?? "",
  );
  expect(await run("diagnose", { target: "8.8.8.8", dimensions: ["routing"] })).toContain(
    "Default route present",
  );
  expect(command.mock.calls.some(([text]) => text === "/routing ospf neighbor print detail")).toBe(
    true,
  );
  command.mockImplementation(async (text) =>
    text === "/routing bgp peer print detail"
      ? "0 name=legacy remote-address=192.0.2.4 state=established"
      : "",
  );
  expect(await run("diagnose", { target: "8.8.8.8", dimensions: ["routing"] })).toContain(
    "Routing Table",
  );
  expect(command.mock.calls.some(([text]) => text === "/routing bgp peer print detail")).toBe(true);
});

test("network and tunnel collection reads nonempty evidence without device writes", async () => {
  command.mockImplementation(
    async (text) =>
      ({
        "/ip arp print detail":
          "0 C address=192.0.2.7 mac-address=AA:BB:CC:DD:EE:FF interface=ether1",
        "/ip dhcp-server lease print detail": "0 address=192.0.2.7 status=bound host-name=client",
        '/interface print detail where type~"gre|ipip|eoip|vxlan|wireguard|ovpn|sstp|pptp|l2tp"':
          "0 R name=wg0 type=wireguard mtu=1420",
        "/ip firewall mangle print detail": "0 chain=forward action=accept packets=2",
        "/interface wireguard peers print detail":
          "0 interface=wg0 public-key=key endpoint-address=192.0.2.8 persistent-keepalive=25s",
        "/ppp profile print detail": "0 name=default change-tcp-mss=no",
      })[text] ?? "",
  );
  const result = await run("diagnose", { target: "192.0.2.7" });
  expect(result).toContain("DIAGNOSTIC");
  expect(command.mock.calls.some(([text]) => /\b(add|set|remove)\b/.test(text))).toBe(false);
});

test("path loss and event bursts are rendered from mocked responses", async () => {
  command.mockImplementation(async (text) =>
    text.startsWith("/ping")
      ? "sent=5 received=0 packet-loss=100%"
      : text.startsWith("/tool traceroute")
        ? "1 192.0.2.1"
        : "",
  );
  expect(await run("trace_path", { target: "8.8.8.8", count: 3, use_dns: false })).toContain(
    "UNREACHABLE",
  );
  command.mockImplementation(async (text) =>
    text.startsWith("/ping") ? "sent=5 received=3 packet-loss=40%" : "",
  );
  expect(await run("trace_path", { target: "8.8.8.8", count: 3, use_dns: false })).toContain(
    "Partial packet loss",
  );
  command.mockResolvedValue("");
  expect(await run("correlate_events", { time_window: "1h", limit: 10 })).toContain(
    "No matching log events",
  );
  command.mockResolvedValue(
    Array.from({ length: 6 }, (_, i) => `${i} time=12:0${i} topics=system message=repeat`).join(
      "\n",
    ),
  );
  const events = await run("correlate_events", { time_window: "1h", limit: 10 });
  expect(events).toContain("repeated system events");
  expect(events).toContain("No obvious cascading failure patterns");
});

test("manual-only anomalies provide no automatic fix commands", async () => {
  expect(await run("suggest_fix", { target: "8.8.8.8", dimensions: ["resources"] })).toContain(
    "No automated fixes available",
  );
});
