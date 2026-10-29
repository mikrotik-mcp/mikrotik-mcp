import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { deviceModeTools } from "../src/tools/device-mode";
import { ipv6FirewallFilterTools } from "../src/tools/ipv6-firewall-filter";
import { webProxyTools } from "../src/tools/web-proxy";

const command = vi.hoisted(() => vi.fn<(text: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "home-ax3", info: vi.fn(), error: vi.fn() };
const run = (tools: typeof webProxyTools, name: string, args: Record<string, unknown> = {}) =>
  tools.find((tool) => tool.name === name)!.handler(args as never, ctx);
beforeEach(() => command.mockReset());

test("proxy settings update quotes values and reads back without guessing success", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce("enabled: yes\nport: 8080");
  const result = await run(webProxyTools, "update_web_proxy", {
    enabled: true,
    port: 8080,
    src_address: "10.64.61.1",
    max_cache_size: "none",
    confirm_firewall_ready: true,
  });
  expect(command.mock.calls[0][0]).toBe(
    "/ip proxy set enabled=yes port=8080 src-address=10.64.61.1 max-cache-size=none",
  );
  expect(result).toContain("enabled: yes");
});

test("proxy refuses to open its listener without explicit firewall confirmation", async () => {
  expect(await run(webProxyTools, "update_web_proxy", { enabled: true })).toContain(
    "Refusing to enable",
  );
  expect(command).not.toHaveBeenCalled();
});

test("proxy access insertion resolves an ordinal before writing and reads its assigned ID", async () => {
  command
    .mockResolvedValueOnce("*A\n*B")
    .mockResolvedValueOnce("*C")
    .mockResolvedValueOnce("0 action=deny dst-address=10.0.0.0/8");
  const result = await run(webProxyTools, "add_web_proxy_access_rule", {
    action: "deny",
    dst_address: "10.0.0.0/8",
    place_before: "0",
  });
  expect(command.mock.calls[1][0]).toContain("place-before=*A");
  expect(result).toContain("created successfully (id *C)");
});

test("proxy access move uses a stable ID instead of an ordinal", async () => {
  let moved = false;
  command.mockImplementation(async (text) => {
    if (!text) return "";
    if (text?.includes("print count-only")) return "1";
    if (text?.startsWith(":foreach")) return moved ? "*B\n*A" : "*A\n*B";
    if (text === "/ip proxy access move *B *A") {
      moved = true;
      return "";
    }
    throw new Error(`Unexpected command: ${text}`);
  });
  expect(
    await run(webProxyTools, "move_web_proxy_access_rule", { rule_id: "*B", destination: 0 }),
  ).toContain("position 0");
  expect(moved).toBe(true);
});

test("device-mode update is a pending physical request, not a claim of activation", async () => {
  command.mockResolvedValue("pending activation");
  const result = await run(deviceModeTools, "update_device_mode_features", {
    proxy: true,
    hotspot: true,
    email: true,
    physical_confirmation_available: true,
  });
  expect(command.mock.calls[0][0]).toBe(
    "/system device-mode update proxy=yes hotspot=yes email=yes",
  );
  expect(result).toContain("physical confirmation is required");
});

test("device-mode exposes every documented feature and maps API names to RouterOS properties", async () => {
  const tool = deviceModeTools.find((item) => item.name === "update_device_mode_features")!;
  const featureKeys = [
    "scheduler",
    "socks",
    "fetch",
    "pptp",
    "l2tp",
    "bandwidth_test",
    "traffic_gen",
    "sniffer",
    "ipsec",
    "romon",
    "proxy",
    "hotspot",
    "smb",
    "email",
    "zerotier",
    "container",
    "install_any_version",
    "partitions",
    "routerboard",
  ];
  for (const key of featureKeys) expect(key in tool.inputSchema!).toBe(true);
  command.mockResolvedValue("pending");
  await run(deviceModeTools, "update_device_mode_features", {
    ...Object.fromEntries(featureKeys.map((key) => [key, true])),
    activation_timeout: "5m",
    flagging_enabled: true,
    flagged: false,
    confirm_flagged_audit_complete: true,
    physical_confirmation_available: true,
  });
  const sent = command.mock.calls[0][0];
  for (const key of featureKeys) expect(sent).toContain(`${key.replaceAll("_", "-")}=yes`);
  expect(sent).toContain("activation-timeout=5m flagging-enabled=yes flagged=no");
});

test("device-mode blocks mode override reset and flagged clearing without specific confirmation", async () => {
  expect(
    await run(deviceModeTools, "update_device_mode_features", {
      mode: "advanced",
      physical_confirmation_available: true,
    }),
  ).toContain("confirm_mode_resets_overrides=true");
  expect(
    await run(deviceModeTools, "update_device_mode_features", {
      flagged: false,
      physical_confirmation_available: true,
    }),
  ).toContain("confirm_flagged_audit_complete=true");
  expect(command).not.toHaveBeenCalled();
});

test("IPv6 move resolves destination ID and confirms resulting order", async () => {
  let moved = false;
  command.mockImplementation(async (text) => {
    if (!text) return "";
    if (text?.includes("print count-only")) return "1";
    if (text?.startsWith(":foreach")) return moved ? "*B\n*A" : "*A\n*B";
    if (text === "/ipv6 firewall filter move *B *A") {
      moved = true;
      return "";
    }
    throw new Error(`Unexpected command: ${text}`);
  });
  expect(
    await run(ipv6FirewallFilterTools, "move_ipv6_filter_rule", { rule_id: "*B", destination: 0 }),
  ).toContain("position 0");
  expect(moved).toBe(true);
});
