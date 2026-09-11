import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { installAccessPolicy } from "../../src/core/access";
import { collectInvestigation } from "../../src/investigations/collect";
import { investigationInput } from "../../src/investigations/model";

const original = getConfig();
const ctx = { device: "edge", info() {}, error() {} };
const input = { client: "192.0.2.10", target: "example.com", service: "Checkout" };
beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      defaultDevice: "edge",
      devices: { edge: { host: "192.0.2.1" }, core: { host: "192.0.2.2" } },
    }),
  );
  installAccessPolicy({ enabled: false, scope: {} });
});
afterEach(() => {
  setConfig(original);
  installAccessPolicy({ enabled: false, scope: {} });
});

function fixture(command: string): Promise<string> {
  if (command.includes("dhcp-server lease"))
    return Promise.resolve(
      '0 address=192.0.2.10 mac-address=AA:BB:CC:DD:EE:FF status=bound comment="secret value"\n1 address=192.0.2.11 mac-address=00:11:22:33:44:55',
    );
  if (command.includes("/ip arp"))
    return Promise.resolve("0 address=192.0.2.10 mac-address=AA:BB:CC:DD:EE:FF interface=bridge");
  if (command.includes("bridge host"))
    return Promise.resolve(
      "0 mac-address=AA:BB:CC:DD:EE:FF on-interface=ether2 bridge=bridge vid=20",
    );
  if (command.includes("/ip dns"))
    return Promise.resolve(
      "servers: 1.1.1.1\ndynamic-servers: 192.0.2.1\nallow-remote-requests: yes",
    );
  if (command.startsWith("/ping")) return Promise.resolve("sent=3 received=3 packet-loss=0%");
  return Promise.resolve("");
}
describe("client investigations", () => {
  test("preserves tunnel flags and immediate gateways without collecting secrets", async () => {
    const read = vi.fn((command: string) =>
      command.startsWith("/interface print")
        ? Promise.resolve('0 R name=office type=wg private-key="secret"')
        : command.startsWith("/ip route print")
          ? Promise.resolve(
              "0 As dst-address=0.0.0.0/0 gateway=10.0.0.1 immediate-gw=10.0.0.1%office",
            )
          : fixture(command),
    );
    const result = await collectInvestigation(input, ctx, read);
    expect(result.evidence.find((e) => e.source === "interfaces")?.rows[0].flags).toBe("R");
    expect(result.evidence.find((e) => e.source === "routes")?.rows[0]["immediate-gw"]).toBe(
      "10.0.0.1%office",
    );
    expect(read).toHaveBeenCalledTimes(13);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  test("collects interface addresses and policy records through bounded read-only queries", async () => {
    const read = vi.fn((command: string) =>
      command.startsWith("/ip address print")
        ? Promise.resolve(
            '0 address=10.0.0.1/30 network=10.0.0.0 interface=office comment="private"',
          )
        : command.startsWith("/ip firewall mangle print")
          ? Promise.resolve(
              '0 chain=prerouting action=mark-routing new-routing-mark=VPN src-address=192.0.2.10 passthrough=no comment="private"',
            )
          : command.startsWith("/routing rule print")
            ? Promise.resolve("0 action=lookup-only-in-table table=VPN src-address=192.0.2.10/32")
            : fixture(command),
    );
    const c = await collectInvestigation(input, ctx, read);
    expect(c.evidence.find((e) => e.source === "ip-addresses")?.rows[0].interface).toBe("office");
    expect(c.evidence.find((e) => e.source === "mangle")?.rows[0]["new-routing-mark"]).toBe("VPN");
    expect(c.evidence.find((e) => e.source === "routing-rules")?.rows[0].table).toBe("VPN");
    expect(JSON.stringify(c)).not.toContain("private");
    expect(read).toHaveBeenCalledTimes(13);
  });
  test("joins client evidence, strips comments and never equates ping with application health", async () => {
    const read = vi.fn(fixture);
    const result = await collectInvestigation(input, ctx, read);
    expect(result.clientOutcome).toBe("unverified");
    expect(result.evidence).toHaveLength(13);
    expect(result.evidence.find((e) => e.source === "dhcp")?.rows).toHaveLength(1);
    expect(result.evidence.find((e) => e.source === "bridge-host")?.rows[0]["on-interface"]).toBe(
      "ether2",
    );
    expect(JSON.stringify(result)).not.toContain("secret value");
    expect(result.nextTests.join(" ")).toContain("actual client network");
    for (const [command, context, opts] of read.mock.calls as unknown as [
      string,
      typeof ctx,
      { maxMs: number },
    ][]) {
      expect(command).toMatch(/ print|^\/ping /);
      expect(command).not.toMatch(/\b(add|set|remove|disable|enable|reboot)\b/);
      expect(context.device).toBe("edge");
      expect(opts.maxMs).toBe(8000);
    }
  });
  test("records missing DNS and ping responses as unknown, not healthy", async () => {
    const result = await collectInvestigation(input, ctx, async () => "");
    for (const source of ["dns", "router-ping"])
      expect(result.evidence.find((e) => e.source === source)?.state).toBe("unknown");
  });
  test("preserves collection errors as unknown without leaking exception text", async () => {
    const result = await collectInvestigation(input, ctx, async () => {
      throw new Error("password=secret");
    });
    expect(result.evidence.every((e) => e.state === "unknown")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("password");
  });
  test("rejects unknown secondary devices before any connection", async () => {
    const read = vi.fn(fixture);
    await expect(
      collectInvestigation({ ...input, vantage_devices: ["typo"] }, ctx, read),
    ).rejects.toThrow("Unknown device");
    expect(read).not.toHaveBeenCalled();
  });
  test("checks access to additional routers before collection", async () => {
    installAccessPolicy({ enabled: true, scope: { devices: ["edge"] } });
    const read = vi.fn(fixture);
    await expect(
      collectInvestigation({ ...input, vantage_devices: ["core"] }, ctx, read),
    ).rejects.toThrow("outside");
    expect(read).not.toHaveBeenCalled();
  });
  test("deduplicates vantage points and stamps each device separately", async () => {
    const result = await collectInvestigation(
      { ...input, vantage_devices: ["edge", "core"] },
      ctx,
      fixture,
    );
    expect(result.devices).toEqual(["edge", "core"]);
    expect(result.evidence).toHaveLength(26);
    expect(result.evidence.filter((e) => e.device === "core")).toHaveLength(13);
  });
  test("joins lowercase MAC clients and limits bulky tables", async () => {
    const result = await collectInvestigation(
      { ...input, client: "aa:bb:cc:dd:ee:ff" },
      ctx,
      (command) =>
        command.includes("/ip route")
          ? Promise.resolve(
              Array.from(
                { length: 180 },
                (_, i) => `${i} dst-address=10.${i}.0.0/16 gateway=192.0.2.1`,
              ).join("\n"),
            )
          : fixture(command),
    );
    expect(result.evidence.find((e) => e.source === "arp")?.rows).toHaveLength(1);
    expect(result.evidence.find((e) => e.source === "routes")?.truncated).toBe(true);
    expect(result.evidence.find((e) => e.source === "routes")?.rows).toHaveLength(150);
  });
  test("rejects malformed clients and injected destinations", () => {
    for (const client of ["999.1.1.1", "192.0.2.1/24", "::1", ""])
      expect(investigationInput.safeParse({ ...input, client }).success).toBe(false);
    expect(
      investigationInput.safeParse({ ...input, target: "example.com; /system reboot" }).success,
    ).toBe(false);
  });
  test("serializes concurrent investigations on the same router and releases the guard", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const run = collectInvestigation(input, ctx, async (command) => {
      if (first) {
        first = false;
        await waiting;
      }
      return fixture(command);
    });
    await expect(collectInvestigation(input, ctx, fixture)).rejects.toThrow("already collecting");
    release();
    await run;
    await expect(collectInvestigation(input, ctx, fixture)).resolves.toHaveProperty("id");
  });
});
