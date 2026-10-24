import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { packetCaptureTools } from "../src/tools/packet-capture";

const mocks = vi.hoisted(() => ({
  command: vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>(),
  start: vi.fn<(port: number) => Promise<{ ok: boolean; error?: string }>>(),
  stop: vi.fn(),
  stats: vi.fn(),
  recent: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/observability/capture", () => ({
  DEFAULT_TZSP_PORT: 37008,
  capture: { start: mocks.start, stop: mocks.stop, stats: mocks.stats, recent: mocks.recent },
}));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = packetCaptureTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args) as never, ctx);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.command.mockResolvedValue("");
  mocks.start.mockResolvedValue({ ok: true });
  mocks.stats.mockReturnValue({
    running: false,
    port: 37008,
    packets: 0,
    bytes: 0,
    protocols: {},
    topTalkers: [],
  });
  mocks.recent.mockReturnValue([]);
});

describe("packet capture tools", () => {
  test("receiver bind failure does not configure device", async () => {
    mocks.start.mockResolvedValue({ ok: false, error: "in use" });
    expect(await run("start_packet_capture", { receiver_host: "192.0.2.1" })).toContain("in use");
    expect(mocks.command).not.toHaveBeenCalled();
  });

  test("configures filtered sniffer before starting it", async () => {
    const text = await run("start_packet_capture", {
      receiver_host: "192.0.2.1",
      port: 4000,
      interface: "bridge",
      protocol: "tcp",
      port_filter: "443",
    });
    expect(text).toContain("Capture started");
    expect(mocks.start).toHaveBeenCalledWith(4000);
    expect(mocks.command.mock.calls.map(([cmd]) => cmd)).toEqual([
      expect.stringContaining("/tool sniffer set"),
      "/tool sniffer start",
    ]);
    expect(mocks.command.mock.calls[0]?.[0]).toContain("filter-stream=yes");
    expect(mocks.command.mock.calls[0]?.[0]).toContain("filter-port=443");
  });

  test("closes receiver after set or start failure", async () => {
    mocks.command.mockResolvedValueOnce("failure: set denied");
    expect(await run("start_packet_capture", { receiver_host: "192.0.2.1" })).toContain(
      "Failed to configure",
    );
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    mocks.command.mockClear();
    mocks.stop.mockClear();
    mocks.command.mockResolvedValueOnce("").mockResolvedValueOnce("failure: start denied");
    expect(await run("start_packet_capture", { receiver_host: "192.0.2.1" })).toContain(
      "Failed to start the device",
    );
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  test("mirror command includes flow selectors and reports failure", async () => {
    mocks.command.mockResolvedValueOnce("failure: denied").mockResolvedValueOnce("");
    expect(
      await run("mirror_traffic_to_capture", {
        receiver_host: "192.0.2.1",
        src_address: "10.0.0.1",
        dst_port: "443",
        protocol: "tcp",
      }),
    ).toContain("Failed to add");
    expect(mocks.command.mock.calls[0]?.[0]).toContain("action=sniff-tzsp");
    expect(mocks.command.mock.calls[0]?.[0]).toContain("comment=mcp-capture");
    expect(
      await run("mirror_traffic_to_capture", { receiver_host: "192.0.2.1", chain: "input" }),
    ).toContain("Mirror added on chain input");
  });

  test("status reads local data only and stop removes tagged mirrors", async () => {
    expect(await run("packet_capture_status")).toContain("not running");
    mocks.stats.mockReturnValue({
      running: true,
      port: 37008,
      packets: 2,
      bytes: 128,
      protocols: { TCP: 2 },
      topTalkers: [{ addr: "10.0.0.1", count: 2 }],
    });
    mocks.recent.mockReturnValue([{ ts: 0, len: 64, info: "TCP SYN" }]);
    const result = await run("packet_capture_status", { limit: 1 });
    expect(result).toMatchObject({
      text: expect.stringContaining("TCP SYN"),
      structuredContent: { stats: expect.objectContaining({ packets: 2 }) },
    });
    expect(mocks.recent).toHaveBeenCalledWith(1);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(await run("stop_packet_capture")).toContain("Collected 2 packets (128 bytes)");
    expect(mocks.command.mock.calls.map(([cmd]) => cmd)).toEqual([
      "/tool sniffer stop",
      "/tool sniffer set streaming-enabled=no",
      expect.stringContaining('comment="mcp-capture"'),
    ]);
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  test("rejects invalid ports before starting receiver", async () => {
    await expect(
      run("start_packet_capture", { receiver_host: "192.0.2.1", port: 0 }),
    ).rejects.toThrow();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
