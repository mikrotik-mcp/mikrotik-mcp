import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { logTools } from "../src/tools/logs";

const command = vi.hoisted(() => vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = logTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args) as never, ctx);
}
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

describe("log handlers", () => {
  test("combined query constructs every filter and returns the newest lines", async () => {
    command.mockResolvedValueOnce("old\nmiddle\nnew");
    const result = await run("get_logs", {
      topics: "system, firewall",
      action: "drop",
      message_filter: "denied",
      prefix_filter: "blocked",
      time_filter: "1h",
      limit: 2,
      follow: true,
      print_as: "detail",
    });
    expect(command.mock.calls[0]?.[0]).toBe(
      '/log print detail where (topics~"system" or topics~"firewall") and action="drop" and message~"denied" and message~"^blocked" and time > ([:timestamp] - 1h) follow',
    );
    expect(result).toContain("middle\nnew");
    expect(result).not.toContain("old");
    expect(command.mock.calls[0]?.[1]).toBe(ctx);
  });

  test("empty result returns a clear message", async () => {
    expect(await run("get_logs")).toBe("No log entries found matching the criteria.");
    expect(command.mock.calls[0]?.[0]).toBe("/log print value");
  });

  test("severity error maps to two topics; topic view selects one", async () => {
    command.mockResolvedValue("entry");
    await run("get_logs_by_severity", { severity: "error", time_filter: "2h" });
    expect(command.mock.calls[0]?.[0]).toContain(
      '(topics~"error" or topics~"critical") and time > ([:timestamp] - 2h)',
    );
    await run("get_logs_by_topic", { topic: "dhcp" });
    expect(command.mock.calls[1]?.[0]).toBe('/log print value where topics~"dhcp"');
  });

  test("search and system event aliases produce message filters", async () => {
    command.mockResolvedValue("entry");
    await run("search_logs", { search_term: "timeout", case_sensitive: true });
    expect(command.mock.calls[0]?.[0]).toContain('message~"timeout"');
    await run("get_system_events", { event_type: "config-change" });
    expect(command.mock.calls[1]?.[0]).toContain('message~"config changed"');
    await run("get_system_events", { event_type: "custom event" });
    expect(command.mock.calls[2]?.[0]).toContain('message~"custom event"');
  });

  test("security query groups topics, keywords and time; limits output", async () => {
    command.mockResolvedValueOnce("old\nnew");
    const result = await run("get_security_logs", { time_filter: "30m", limit: 1 });
    expect(command.mock.calls[0]?.[0]).toContain('topics~"firewall"');
    expect(command.mock.calls[0]?.[0]).toContain(
      'message~"(login|logout|failed|denied|blocked|attack|invalid|unauthorized)"',
    );
    expect(command.mock.calls[0]?.[0]).toContain("time > ([:timestamp] - 30m)");
    expect(result).toContain("new");
    expect(result).not.toContain("old");
    command.mockResolvedValueOnce("");
    expect(await run("get_security_logs")).toContain("No security-related");
  });

  test("log statistics skip zero or nonnumeric topic counts", async () => {
    command
      .mockResolvedValueOnce("9")
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("oops");
    const result = await run("get_log_statistics");
    expect(result).toContain("Total log entries: 9");
    expect(result).toContain("Info: 2");
    expect(result).not.toContain("Warning:");
    expect(result).not.toContain("Error:");
    expect(command).toHaveBeenCalledTimes(10);
    expect(command.mock.calls.at(-2)?.[0]).toContain("- 1h");
    expect(command.mock.calls.at(-1)?.[0]).toContain("- 1d");
  });

  test("export builds file and filters; nonempty result is reported", async () => {
    expect(
      await run("export_logs", { filename: "audit", topics: "system", time_filter: "1d" }),
    ).toContain("audit.txt");
    expect(command.mock.calls[0]?.[0]).toBe(
      '/log print file=audit where topics~"system" and time > ([:timestamp] - 1d)',
    );
    command.mockResolvedValueOnce("failure: denied");
    expect(await run("export_logs", { filename: "audit" })).toContain(
      "Export result: failure: denied",
    );
  });

  test("monitor caps the window and returns only the newest hundred lines", async () => {
    command.mockResolvedValueOnce(Array.from({ length: 105 }, (_, i) => `line-${i}`).join("\n"));
    const result = await run("monitor_logs", { duration: 120, topics: "system", action: "accept" });
    expect(command.mock.calls[0]?.[0]).toBe(
      '/log print where topics~"system" and action="accept" and time > ([:timestamp] - 60s)',
    );
    expect(result).toContain("line-104");
    expect(result).not.toContain("line-0\n");
    command.mockResolvedValueOnce("");
    expect(await run("monitor_logs", { duration: 5 })).toContain("No log entries in this window");
  });

  test("clear follows current non-interactive command contract", async () => {
    expect(await run("clear_logs")).toBe("Logs cleared successfully.");
    expect(command.mock.calls[0]?.[0]).toBe("/log print follow-only");
    command.mockResolvedValueOnce("failure: denied");
    expect(await run("clear_logs")).toBe("Log clear result: failure: denied");
  });
});
