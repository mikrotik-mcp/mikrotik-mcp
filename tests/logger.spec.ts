import { stderr } from "node:process";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createContext } from "../src/core/context";
import { formatLogMessage, logger } from "../src/logger";

afterEach(() => vi.restoreAllMocks());

test("batch IDs are omitted from stderr and MCP notifications", () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `*${(0x2711 + i).toString(16).toUpperCase()}`);
  const command = `:put [:serialize to=json value=[/user-manager session print as-value from=${ids.join(",")}] options=json.no-string-conversion]`;
  const write = vi.spyOn(stderr, "write").mockReturnValue(true);
  const notify = vi.fn();
  const ctx = createContext(notify, "home-ax3");
  ctx.info(`[home-ax3] Executing MikroTik command: ${command}`);
  ctx.error(`Safe Mode timeout (command: ${command}). Do not retry the write blindly.`);
  for (const [, message] of notify.mock.calls) {
    expect(message).toContain("/user-manager session print as-value from=<2000 IDs omitted>");
    expect(message).not.toContain("*2711");
    expect(message.length).toBeLessThan(300);
  }
  expect(notify.mock.calls[1][1]).toContain("Do not retry the write blindly.");
  for (const [line] of write.mock.calls) expect(String(line)).not.toContain("*2711");
});

test("ordinary logs stay readable and arbitrary large messages are bounded on both channels", () => {
  const short = "[edge] Executing MikroTik command: /ip address print";
  expect(formatLogMessage(short)).toBe(short);
  const write = vi.spyOn(stderr, "write").mockReturnValue(true);
  const notify = vi.fn();
  const large = `Failed: ${"x".repeat(20_000)}`;
  const formatted = formatLogMessage(large);
  expect(formatted).toContain("chars omitted]");
  expect(formatted.length).toBeLessThan(1100);
  const ctx = createContext(notify);
  ctx.info(large);
  ctx.error(large);
  expect(notify).toHaveBeenCalledWith("info", formatted);
  expect(notify).toHaveBeenCalledWith("error", formatted);
  logger.warn(large);
  for (const [line] of write.mock.calls) expect(String(line)).toContain(`${formatted}\n`);
  expect(write.mock.calls.every(([line]) => String(line).length < 1150)).toBe(true);
});
