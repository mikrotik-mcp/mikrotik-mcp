import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { switchPortIsolationTools } from "../src/tools/switch-port-isolation";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx = { device: "offline", info: vi.fn(), error: vi.fn() } as ToolContext;
const run = (name: string, args: Record<string, unknown>) =>
  switchPortIsolationTools.find((tool) => tool.name === name)!.handler(args, ctx);

beforeEach(() => {
  command.mockReset().mockResolvedValue("entry");
});

describe("switch port isolation handlers", () => {
  it("adds an isolated port, verifies it, and reports an empty verification", async () => {
    expect(
      await run("add_switch_port_isolation", {
        port: "ether2",
        forwarding_override_ports: "ether1",
        comment: "guest",
      }),
    ).toContain("entry");
    expect(command.mock.calls.map(([text]) => text)).toEqual([
      "/interface ethernet switch port-isolation add port=ether2 forwarding-override-ports=ether1 comment=guest",
      '/interface ethernet switch port-isolation print detail where port="ether2"',
    ]);
    command.mockReset().mockResolvedValueOnce("").mockResolvedValueOnce("");
    expect(
      await run("add_switch_port_isolation", {
        port: "ether2",
        forwarding_override_ports: "ether1",
      }),
    ).toContain("unable to verify");
  });

  it("stops after add failure and handles filtered empty listings", async () => {
    command.mockResolvedValueOnce("failure: unsupported");
    expect(
      await run("add_switch_port_isolation", {
        port: "ether2",
        forwarding_override_ports: "ether1",
      }),
    ).toContain("Failed to add");
    expect(command).toHaveBeenCalledTimes(1);
    command.mockReset().mockResolvedValue("");
    expect(await run("list_switch_port_isolation", { port_filter: "ether" })).toContain(
      "No switch port-isolation",
    );
    expect(command).toHaveBeenCalledWith(
      '/interface ethernet switch port-isolation print where port~"ether"',
      ctx,
    );
  });

  it("selects IDs and names and avoids no-op updates", async () => {
    expect(await run("get_switch_port_isolation", { isolation_id: "*A" })).toContain("entry");
    expect(command).toHaveBeenCalledWith(
      '/interface ethernet switch port-isolation print detail where .id="*A"',
      ctx,
    );
    command.mockClear();
    expect(await run("update_switch_port_isolation", { isolation_id: "ether2" })).toBe(
      "No updates specified.",
    );
    expect(command).not.toHaveBeenCalled();
    expect(
      await run("update_switch_port_isolation", { isolation_id: "ether2", comment: "" }),
    ).toContain("updated successfully");
    expect(command.mock.calls[0][0]).toContain('comment=""');
  });

  it("checks existence before removal and does not claim failed removal", async () => {
    command.mockResolvedValueOnce("0");
    expect(await run("remove_switch_port_isolation", { isolation_id: "*A" })).toContain(
      "not found",
    );
    expect(command).toHaveBeenCalledTimes(1);
    command.mockReset().mockResolvedValueOnce("1").mockResolvedValueOnce("failure: busy");
    expect(await run("remove_switch_port_isolation", { isolation_id: "*A" })).toContain(
      "Failed to remove",
    );
    expect(command.mock.calls[1][0]).toContain('remove [find .id="*A"]');
  });
});
