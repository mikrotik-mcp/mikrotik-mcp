import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { executeMikrotikCommand } from "../src/core/connector";
import { vlanDesignerTools } from "../src/tools/vlan-designer";

vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
const exec = vi.mocked(executeMikrotikCommand);
const tool = vlanDesignerTools.find((t) => t.name === "design_network_segment")!;
const base = {
  vlan_id: 20,
  name: "iot",
  subnet: "192.168.20.0/24",
  gateway: "192.168.20.1",
  internet: false,
};
async function run(patch: Record<string, unknown> = {}) {
  return tool.handler(z.object(tool.inputSchema!).parse({ ...base, ...patch }), {
    info: vi.fn(),
    error: vi.fn(),
    device: "offline",
  });
}
beforeEach(() => {
  exec.mockReset();
  exec.mockResolvedValue("");
});

describe("VLAN IPv4 scaffold safety", () => {
  test("preview is offline, deduplicates CPU membership and never claims complete isolation", async () => {
    const output = await run({ tagged_ports: "bridge,ether2,ether2", untagged_ports: "ether4" });
    expect(output).toContain("DRY RUN");
    expect(output).toContain("tagged=bridge,ether2");
    expect(output).not.toContain("bridge,bridge");
    expect(output).toContain("PARTIAL IPv4 scaffold only");
    expect(output).toContain("no bridge port PVID/admission");
    expect(output).not.toContain("vlan-filtering=yes");
    expect(exec).not.toHaveBeenCalled();
  });
  test("NAT is scoped and drops have explicit placement", async () => {
    const output = await run({
      internet: true,
      wan_interface: "pppoe-wan",
      isolate_from: ["192.168.10.0/24"],
      isolation_before: "*A",
    });
    expect(output).toContain("out-interface=pppoe-wan");
    expect(output).toContain("place-before=*A");
    expect(exec).not.toHaveBeenCalled();
  });
  test.each([
    { internet: true },
    { isolate_from: ["192.168.10.0/24"] },
    { subnet: "192.168.20.0/25" },
    { subnet: "192.168.20.2/24" },
    { gateway: "192.168.21.1" },
    { gateway: "192.168.20.0" },
    { gateway: "192.168.20.255" },
    { gateway: "192.168.20.100" },
    { dhcp_range: "192.168.20.0-192.168.20.100" },
    { dhcp_range: "192.168.20.10-192.168.20.255" },
    { dhcp_range: "192.168.20.100-192.168.20.10" },
    { dhcp_range: "192.168.20.10-192.168.21.50" },
    { dhcp_range: "not-a-range" },
    { tagged_ports: "ether2", untagged_ports: "ether2" },
    { untagged_ports: "bridge" },
  ])("rejects incomplete or unsafe apply before any I/O: %j", async (patch) => {
    expect(await run({ ...patch, apply: true })).toMatch(/^Error:/);
    expect(exec).not.toHaveBeenCalled();
  });
  test.each([
    { subnet: "2001:db8::/64" },
    { gateway: "999.1.1.1" },
    { isolation_before: "0" },
    { isolation_before: "*A; /system reboot" },
    { internet: true, wan_interface: "!LAN" },
  ])("rejects malformed input through the schema: %j", async (patch) => {
    await expect(run(patch)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
  test("accepts an explicit usable non-/24 pool", async () => {
    expect(
      await run({ subnet: "192.168.20.0/25", dhcp_range: "192.168.20.10-192.168.20.126" }),
    ).toContain("ranges=192.168.20.10-192.168.20.126");
  });
  test("refuses a stale placement anchor before writes", async () => {
    exec.mockResolvedValue("0");
    expect(
      await run({ apply: true, isolate_from: ["192.168.10.0/24"], isolation_before: "*A" }),
    ).toContain("No changes applied");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toContain(
      "print count-only where .id=*A chain=forward disabled=no",
    );
  });
  test("successful commands remain unverified and all use the selected device", async () => {
    exec.mockResolvedValueOnce("1");
    const output = await run({
      apply: true,
      isolate_from: ["192.168.10.0/24"],
      isolation_before: "*A",
    });
    expect(output).toContain("Isolation and connectivity are UNVERIFIED");
    expect(output).not.toContain("isolated from");
    for (const [, ctx] of exec.mock.calls) expect(ctx.device).toBe("offline");
  });
  test("stops after a partial failure with no retries or remaining writes", async () => {
    exec.mockResolvedValueOnce("").mockResolvedValueOnce("failure: address already exists");
    expect(await run({ apply: true })).toContain("Built 1/5 commands, then FAILED");
    expect(exec).toHaveBeenCalledTimes(2);
  });
  test("ambiguous transport failures retain the partial-apply warning without replay", async () => {
    exec.mockResolvedValueOnce("").mockRejectedValueOnce(new Error("SSH timeout"));
    const output = await run({ apply: true });
    expect(output).toContain("1/5 acknowledged commands");
    expect(output).toContain("last command may already have applied");
    expect(output).toContain("do not retry blindly");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
