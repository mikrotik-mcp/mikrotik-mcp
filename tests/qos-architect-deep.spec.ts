import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { qosArchitectTools } from "../src/tools/qos-architect";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const run = (args: Record<string, unknown>) => qosArchitectTools[0].handler(args as never, ctx);
const classes = [
  { name: "voice", target: "192.0.2.0/24", max_limit: "2M/2M", priority: 1 },
  { name: "guest", target: "198.51.100.0/24", max_limit: "10M/10M", priority: 8 },
];
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

test("preview preserves order and escapes class fields without router I/O", async () => {
  const result = await run({
    classes: [{ ...classes[0], name: 'voice "priority"', comment: "office guest" }, classes[1]],
    apply: false,
  });
  expect(result).toContain('1. /queue simple add name="voice \\"priority\\""');
  expect(result).toContain("2. /queue simple add name=guest");
  expect(result).toContain("priority=1/1");
  expect(result).toContain('comment="office guest"');
  expect(command).not.toHaveBeenCalled();
});

test("apply creates in order and reads queues after success", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce("").mockResolvedValueOnce("0 name=voice");
  expect(await run({ classes, apply: true })).toContain("created 2 queue(s): voice, guest");
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    "/queue simple add name=voice target=192.0.2.0/24 max-limit=2M/2M priority=1/1",
    "/queue simple add name=guest target=198.51.100.0/24 max-limit=10M/10M priority=8/8",
    "/queue simple print",
  ]);
});

test("partial failure reports created classes and stops before verification", async () => {
  command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: denied");
  const result = await run({ classes: [...classes, classes[0]], apply: true });
  expect(result).toContain("Applied 1/3 classes, then FAILED on 'guest'");
  expect(result).toContain("Already-created: voice");
  expect(command).toHaveBeenCalledTimes(2);
});
