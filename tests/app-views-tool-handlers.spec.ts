import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { appViewTools } from "../src/tools/app-views";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();

async function call(name: string) {
  const tool = appViewTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler({} as never, ctx) as Promise<{
    text: string;
    structuredContent: Record<string, unknown>;
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
});
afterEach(() => setConfig(initial));

test("system view reads four resources in sequence and computes memory and disk usage", async () => {
  mocks.command.mockImplementation(
    async (command: string) =>
      ({
        "/system identity print": "name: lab-router",
        "/system resource print":
          "version: 7.20\nuptime: 1d\ncpu-load: 34%\ntotal-memory: 1024MiB\nfree-memory: 256MiB\ntotal-hdd-space: 2048MiB\nfree-hdd-space: 1024MiB",
        "/system health print": "temperature: 42C\nvoltage: 24V",
        "/system routerboard print": "model: ax3",
      })[command] ?? "",
  );
  const view = await call("show_system_dashboard");
  expect(mocks.command.mock.calls.map(([command]) => command)).toEqual([
    "/system identity print",
    "/system resource print",
    "/system health print",
    "/system routerboard print",
  ]);
  expect(view.text).toContain("lab-router");
  expect(view.structuredContent.derived).toMatchObject({
    cpuLoadPct: 34,
    memUsedPct: 75,
    hddUsedPct: 50,
    temperatureC: 42,
  });
});

test("system view handles unreadable resources without inventing percentages", async () => {
  mocks.command.mockResolvedValue("failure: permission denied");
  const view = await call("show_system_dashboard");
  expect(view.text).toContain("CPU n/a, mem n/a");
  expect(view.structuredContent.derived).toMatchObject({ memUsedPct: null, hddUsedPct: null });
});

test("interface view summarizes running and disabled rows", async () => {
  mocks.command.mockResolvedValue(
    "Flags: X - disabled; R - running\n 0 R name=ether1 type=ether mtu=1500\n 1 X name=ether2 type=ether mtu=1500",
  );
  const view = await call("show_interfaces");
  expect(mocks.command).toHaveBeenCalledWith("/interface print detail", ctx);
  expect(view.text).toContain("2 interface(s): 1 running, 1 disabled");
  expect(view.structuredContent.rows).toHaveLength(2);
});

test("firewall view groups rules by chain and counts disabled rules", async () => {
  mocks.command.mockResolvedValue(
    "Flags: X - disabled\n 0 chain=input action=accept\n 1 X chain=input action=drop\n 2 chain=forward action=accept",
  );
  const view = await call("show_firewall_filter");
  expect(mocks.command).toHaveBeenCalledWith("/ip firewall filter print detail", ctx);
  expect(view.text).toContain("input=2, forward=1");
  expect(view.text).toContain("1 disabled");
  expect(view.structuredContent.rows).toHaveLength(3);
});

test("empty row output produces an empty honest view", async () => {
  mocks.command.mockResolvedValue("");
  const [interfaces, firewall] = await Promise.all([
    call("show_interfaces"),
    call("show_firewall_filter"),
  ]);
  expect(interfaces.structuredContent.rows).toEqual([]);
  expect(firewall.text).toContain("0 rule(s), 0 disabled");
});
