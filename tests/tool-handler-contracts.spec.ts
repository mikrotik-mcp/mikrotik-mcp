import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import type { ToolModule } from "../src/core/registry";
import { dnsTools } from "../src/tools/dns";
import { userTools } from "../src/tools/users";
import { wireguardTools } from "../src/tools/wireguard";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };

/** Run the production handler against a deterministic RouterOS command transcript. */
function invoke(module: ToolModule, name: string, args: Record<string, unknown>) {
  const tool = module.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing test target: ${name}`);
  return Promise.resolve(tool.handler(args as never, ctx)).then((result) =>
    typeof result === "string" ? result : result.text,
  );
}

beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});
afterEach(() => vi.clearAllMocks());

describe("local account handlers", () => {
  test("listing applies group and disabled filters and redacts credentials", async () => {
    command.mockResolvedValue('0 name=operator group=read password="secret"');
    const result = await invoke(userTools, "list_users", {
      group_filter: "read",
      disabled_only: true,
    });
    expect(command).toHaveBeenCalledExactlyOnceWith(
      '/user print where group="read" disabled=yes',
      ctx,
    );
    expect(result).toContain("operator");
    expect(result).not.toContain('password="secret"');
  });

  test("account creation verifies the returned immutable id and hides password", async () => {
    command.mockResolvedValueOnce("*A").mockResolvedValueOnce('0 name=operator password="secret"');
    const result = await invoke(userTools, "add_user", {
      name: "operator",
      password: "secret",
      group: "read",
      disabled: false,
    });
    expect(command.mock.calls[0][0]).toBe("/user add name=operator password=secret group=read");
    expect(command.mock.calls[1][0]).toBe("/user print detail where .id=*A");
    expect(result).toContain("User created successfully");
    expect(result).not.toContain('password="secret"');
  });

  test("admin removal is refused without a device command", async () => {
    expect(await invoke(userTools, "remove_user", { name: "AdMiN" })).toContain("Cannot remove");
    expect(command).not.toHaveBeenCalled();
  });

  test("removal checks existence and reports router rejection", async () => {
    command.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: access denied");
    const result = await invoke(userTools, "remove_user", { name: "guest" });
    expect(command.mock.calls.map(([text]) => text)).toEqual([
      '/user print count-only where name="guest"',
      '/user remove [find name="guest"]',
    ]);
    expect(result).toContain("access denied");
  });

  test("updating an account clears an address restriction and verifies the new name", async () => {
    command.mockResolvedValueOnce("").mockResolvedValueOnce("0 name=operator2 group=read");
    const result = await invoke(userTools, "update_user", {
      name: "operator",
      new_name: "operator2",
      address: "",
      disabled: true,
    });
    expect(command.mock.calls[0][0]).toBe(
      '/user set [find name="operator"] name=operator2 !address disabled=yes',
    );
    expect(command.mock.calls[1][0]).toBe('/user print detail where name="operator2"');
    expect(result).toContain("operator2");
  });
});

describe("DNS handlers", () => {
  test("static entry creation sends MX fields together and verifies returned id", async () => {
    command.mockResolvedValueOnce("*C").mockResolvedValueOnce("0 name=mail.example type=MX");
    const result = await invoke(dnsTools, "add_dns_static", {
      name: "mail.example",
      type: "MX",
      mx_preference: 10,
      mx_exchange: "mx.example",
    });
    expect(command.mock.calls[0][0]).toBe(
      "/ip dns static add name=mail.example type=MX mx-preference=10 mx-exchange=mx.example",
    );
    expect(command.mock.calls[1][0]).toBe("/ip dns static print detail where .id=*C");
    expect(result).toContain("added successfully");
  });

  test("static entry update distinguishes a cleared field from an omitted field", async () => {
    command.mockResolvedValueOnce("").mockResolvedValueOnce("0 name=example.test ttl=1h");
    const result = await invoke(dnsTools, "update_dns_static", {
      entry_id: "*D",
      address: "",
      ttl: "1h",
    });
    expect(command.mock.calls[0][0]).toBe("/ip dns static set *D !address ttl=1h");
    expect(command.mock.calls[1][0]).toBe("/ip dns static print detail where .id=*D");
    expect(result).toContain("updated successfully");
  });

  test("an empty DNS update never reaches RouterOS", async () => {
    expect(await invoke(dnsTools, "update_dns_static", { entry_id: "*D" })).toBe(
      "No updates specified.",
    );
    expect(command).not.toHaveBeenCalled();
  });

  test("DNS read reports a missing static record", async () => {
    expect(await invoke(dnsTools, "get_dns_static", { name: "missing.example" })).toContain(
      "not found",
    );
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0][0]).toContain("/ip dns static print detail");
  });
});

describe("WireGuard handlers", () => {
  test("status reads interfaces and peers in order without changing the router", async () => {
    command
      .mockResolvedValueOnce("0 name=wg-edge running=yes")
      .mockResolvedValueOnce("0 interface=wg-edge last-handshake=4s");
    const result = await invoke(wireguardTools, "get_wireguard_status", {
      interface_filter: "wg-edge",
    });
    expect(command.mock.calls.map(([text]) => text)).toEqual([
      '/interface wireguard print where name="wg-edge"',
      '/interface wireguard peers print where interface="wg-edge"',
    ]);
    expect(result).toContain("running=yes");
    expect(result).toContain("last-handshake=4s");
  });

  test("interface creation reports a router-side failure without claiming success", async () => {
    command.mockResolvedValueOnce("failure: bad listen port");
    const result = await invoke(wireguardTools, "create_wireguard_interface", {
      name: "wg-edge",
      listen_port: 51820,
      disabled: false,
    });
    expect(command.mock.calls[0][0]).toBe(
      "/interface wireguard add name=wg-edge listen-port=51820",
    );
    expect(result).toContain("Failed to create");
    expect(command).toHaveBeenCalledTimes(1);
  });
});
