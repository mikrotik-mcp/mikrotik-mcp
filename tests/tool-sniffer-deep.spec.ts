import { beforeEach, expect, test, vi } from "vite-plus/test";
import { snifferTools } from "../src/tools/tool-sniffer";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx = { device: "lab", info: vi.fn() };
function call(name: string, args: Record<string, unknown> = {}) {
  const tool = snifferTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx as never);
}
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});

test("settings update avoids an empty write and reads back only after success", async () => {
  expect(await call("update_sniffer_settings")).toBe("No updates specified.");
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce("failure: busy");
  expect(await call("update_sniffer_settings", { streaming_enabled: false })).toContain(
    "Failed to update",
  );
  expect(command).toHaveBeenCalledTimes(1);
  command.mockResolvedValueOnce("").mockResolvedValueOnce("running=no");
  expect(
    await call("update_sniffer_settings", {
      filter_direction: "rx",
      filter_ip_address: "192.0.2.0/24",
      streaming_enabled: true,
      only_headers: false,
      file_limit: 128,
    }),
  ).toContain("running=no");
  expect(command.mock.calls[1][0]).toContain("filter-ip-address=192.0.2.0/24");
  expect(command.mock.calls[1][0]).toContain("streaming-enabled=yes");
  expect(command.mock.calls[1][0]).toContain("file-limit=128 only-headers=no");
  expect(command.mock.calls[2][0]).toBe("/tool sniffer print");
});

test("capture lifecycle reports failures and successful start/stop/save", async () => {
  command
    .mockResolvedValueOnce("failure: running")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("failure: stopped")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("failure: no disk")
    .mockResolvedValueOnce("");
  expect(await call("start_sniffer")).toContain("Failed to start");
  expect(await call("start_sniffer")).toBe("Packet sniffer started.");
  expect(await call("stop_sniffer")).toContain("Failed to stop");
  expect(await call("stop_sniffer")).toBe("Packet sniffer stopped.");
  expect(await call("save_sniffer", { file_name: "capture" })).toContain("Failed to save");
  expect(await call("save_sniffer", { file_name: "capture" })).toContain("saved to 'capture'");
  expect(command.mock.calls.at(-1)?.[0]).toBe('/tool sniffer save file-name="capture"');
});

test("packet filters combine address and protocol; reads distinguish empty buffers", async () => {
  expect(
    await call("list_sniffer_packets", { address_filter: "192.0.2", protocol_filter: "tcp" }),
  ).toContain("No captured packets");
  expect(command.mock.calls[0][0]).toBe(
    '/tool sniffer packet print where (src-address~"192.0.2" or dst-address~"192.0.2") protocol~"tcp"',
  );
  command.mockResolvedValueOnce("0 address=192.0.2.4");
  expect(await call("list_sniffer_hosts", { address_filter: "192.0.2" })).toContain("192.0.2.4");
  expect(command.mock.calls[1][0]).toContain('where address~"192.0.2"');
  expect(await call("list_sniffer_protocols")).toContain("No sniffer protocol data");
  command.mockResolvedValueOnce("0 src-address=192.0.2.4");
  expect(await call("list_sniffer_connections")).toContain("SNIFFER CONNECTIONS");
  expect(await call("get_sniffer_settings")).toBe("Unable to read sniffer settings.");
});
