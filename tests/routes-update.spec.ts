import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { routeTools } from "../src/tools/routes";
import { getConfig, setConfig } from "../src/core/runtime";
import { MikrotikConfigSchema } from "../src/config";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const original = getConfig();
beforeEach(() => {
  command.mockReset();
  setConfig(
    MikrotikConfigSchema.parse({ devices: { home: { host: "192.0.2.1" } }, defaultDevice: "home" }),
  );
});
afterEach(() => setConfig(original));

function invoke(name: string) {
  let handler!: (args: Record<string, unknown>) => Promise<CallToolResult>;
  routeTools
    .find((tool) => tool.name === name)!
    .register({
      registerTool: (_name: string, _config: unknown, callback: typeof handler) => {
        handler = callback;
      },
    } as never);
  return handler({ route_id: "*1", check_gateway: "ping" });
}

test.each(["update_route", "enable_route", "disable_route"])(
  "%s does not report a header-only read-back as success",
  async (name) => {
    command
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("Flags: A - ACTIVE; s - STATIC\r\n");
    const result = await invoke(name);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("verification failed");
    expect(JSON.stringify(result.content)).toContain("do not retry");
    expect(command.mock.calls.filter(([c]) => c.startsWith("/ip route set"))).toHaveLength(1);
  },
);

test("read-back transport failure preserves the sent-write warning and stable ID", async () => {
  command
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("")
    .mockRejectedValueOnce(new Error("SSH connection closed"));
  const result = await invoke("update_route");
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Route *1 update was sent");
  expect(JSON.stringify(result.content)).toContain("get_route with route_id=*1");
  expect(command).toHaveBeenCalledTimes(3);
});

test("a successful update includes the actual read-back", async () => {
  const details = "0 As dst-address=0.0.0.0/0 gateway=192.0.2.2 check-gateway=ping";
  command.mockResolvedValueOnce("1").mockResolvedValueOnce("").mockResolvedValueOnce(details);
  const result = await invoke("update_route");
  expect(result.isError).toBeFalsy();
  expect(JSON.stringify(result.content)).toContain(details);
});
