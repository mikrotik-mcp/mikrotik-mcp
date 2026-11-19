/** discover_unmanaged_devices: neighbours of every router, minus the configured ones. */
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const { neighborTools } = await import("../src/tools/neighbor");

const tool = neighborTools.find((t) => t.name === "discover_unmanaged_devices")!;
const run = (args: Record<string, unknown> = {}): Promise<string> =>
  (tool.handler as (a: unknown, c: unknown) => Promise<string>)(args, { info() {}, error() {} });

const original = getConfig();
beforeEach(() => {
  command.mockReset();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        edge: { host: "10.0.0.1" },
        core: { host: "10.0.0.2" },
        spare: { host: "10.0.0.9", disabled: true },
      },
      defaultDevice: "edge",
    }),
  );
});
afterEach(() => setConfig(original));

const row = (i: number, fields: Record<string, string>): string =>
  ` ${i}   ${Object.entries(fields)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}`;

test("it lists what the routers see and leaves out configured devices", async () => {
  command.mockImplementation(async (_cmd: string, ctx: { device: string }) =>
    ctx.device === "edge"
      ? [
          row(0, {
            interface: "ether2",
            address: "10.0.0.2",
            "mac-address": "AA:AA:AA:00:00:02",
            identity: "core",
          }),
          row(1, {
            interface: "ether3",
            address: "10.0.0.50",
            "mac-address": "AA:AA:AA:00:00:50",
            identity: "new-ap",
            board: "cAP ax",
            version: "7.25.1",
            platform: "MikroTik",
          }),
        ].join("\n")
      : row(0, {
          interface: "ether5",
          address: "10.0.0.50",
          "mac-address": "AA:AA:AA:00:00:50",
          identity: "new-ap",
        }),
  );
  const text = await run();
  expect(tool.annotations.readOnlyHint).toBe(true);
  // The disabled router is not asked.
  expect(command.mock.calls.map((c) => (c[1] as { device: string }).device)).toEqual([
    "edge",
    "core",
  ]);
  expect(command.mock.calls.every((c) => c[0] === "/ip neighbor print detail")).toBe(true);
  expect(text).toContain("Asked 2 of 2 router(s). 1 device(s) are attached and not managed.");
  expect(text).toContain("new-ap");
  expect(text).toContain("board: cAP ax · version: 7.25.1");
  expect(text).toContain("seen by: edge on ether3, core on ether5");
  expect(text).toContain('"host":"10.0.0.50"');
  expect(text).toContain("This tool adds nothing.");
  // "core" is configured: it is not offered as a new device.
  expect(text).not.toMatch(/^core$/m);
});

test("a router that cannot be asked is reported, and the rest still answer", async () => {
  command.mockImplementation(async (_cmd: string, ctx: { device: string }) => {
    if (ctx.device === "edge") throw new Error("connection refused");
    return "";
  });
  const text = await run({ devices: ["edge", "core"] });
  expect(text).toContain("Asked 1 of 2 router(s). 0 device(s) are attached and not managed.");
  expect(text).toContain("edge: connection refused");
  await expect(run({ devices: ["nope"] })).rejects.toThrow();
});
