import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { smsTools } from "../src/tools/tool-sms";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) =>
  smsTools.find((t) => t.name === name)!.handler(args as never, ctx);
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

test("read and inbox distinguish empty from populated output", async () => {
  expect(await run("get_sms_settings")).toBe("Unable to read sms settings.");
  command.mockResolvedValueOnce("0 phone=+123 text=hello");
  expect(await run("list_sms_inbox", { phone_filter: "123" })).toContain("SMS INBOX:");
  expect(command.mock.calls.map(([text]) => text)).toEqual([
    "/tool sms print",
    '/tool sms inbox print where phone~"123"',
  ]);
});

test("no-op update does not contact router; explicit false and secrets are sent once", async () => {
  expect(await run("update_sms_settings")).toBe("No updates specified.");
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce("").mockResolvedValueOnce("receive-enabled: no");
  expect(
    await run("update_sms_settings", {
      port: "lte1",
      receive_enabled: false,
      secret: "private value",
      sim_pin: "1234",
      channel: 2,
    }),
  ).toContain("receive-enabled: no");
  expect(command.mock.calls[0][0]).toContain("receive-enabled=no");
  expect(command.mock.calls[0][0]).toContain('secret="private value"');
  expect(command.mock.calls[1][0]).toBe("/tool sms print");
  expect(vi.mocked(ctx.info).mock.calls.flat().join(" ")).not.toContain("private value");
});

test("update and send failures stop without follow-up read or success claim", async () => {
  command
    .mockResolvedValueOnce("failure: invalid port")
    .mockResolvedValueOnce("failure: modem busy");
  expect(await run("update_sms_settings", { port: "bad" })).toContain(
    "Failed to update sms settings",
  );
  expect(await run("send_sms", { port: "lte1", phone_number: "+123", message: "hello" })).toContain(
    "Failed to send SMS",
  );
  expect(command).toHaveBeenCalledTimes(2);
});

test("send includes optional SMSC and channel and reports recipient", async () => {
  expect(
    await run("send_sms", {
      port: "lte1",
      phone_number: "+123",
      message: "two words",
      smsc: "+456",
      channel: 1,
    }),
  ).toBe("SMS sent to +123.");
  expect(command.mock.calls[0][0]).toBe(
    '/tool sms send port=lte1 phone-number="+123" message="two words" smsc="+456" channel=1',
  );
});
