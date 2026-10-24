import { beforeEach, expect, test, vi } from "vite-plus/test";
import { MikroTikMacTelnetClient } from "../../src/mac-telnet/client";

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  ready: vi.fn(),
  close: vi.fn(),
  onMessage: vi.fn(),
  open: vi.fn(),
  run: vi.fn(),
  consoleClose: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@tikoci/centrs/protocols", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tikoci/centrs/protocols")>()),
  resolveMacTelnetRoute: mocks.route,
  createUdpMacTelnetTransport: mocks.create,
  listBroadcastInterfaces: mocks.list,
}));
vi.mock("../../src/mac-telnet/console", () => ({
  MacTelnetConsole: class {
    isReady = true;
    open = mocks.open;
    run = mocks.run;
    close = mocks.consoleClose;
    handlePacket = vi.fn();
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.mockResolvedValue({
    host: "192.0.2.255",
    sourceMac: new Uint8Array([1, 2, 3, 4, 5, 6]),
  });
  mocks.ready.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ output: "identity: lab" });
  mocks.list.mockReturnValue([]);
  mocks.create.mockImplementation(() => ({
    ready: mocks.ready,
    close: mocks.close,
    onMessage: mocks.onMessage,
  }));
});

test("connects, runs a command, disconnects, and reconnects offline", async () => {
  const client = new MikroTikMacTelnetClient({
    mac: "48:A9:8A:C6:42:F7",
    username: "test",
    host: "192.0.2.255",
    timeoutMs: 100,
  });
  expect(await client.connect()).toBe(true);
  expect(await client.run("/system identity print", { maxMs: 10 })).toBe("identity: lab");
  expect(mocks.run).toHaveBeenCalledWith("/system identity print");
  expect(mocks.onMessage).toHaveBeenCalledOnce();
  client.disconnect();
  client.disconnect();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.consoleClose).toHaveBeenCalledOnce();
  await expect(client.run("/print")).rejects.toThrow(/Not connected/);
  expect(await client.connect()).toBe(true);
  client.disconnect();
});

test("discovery timeout reports the layer-2 diagnostic and closes the socket", async () => {
  mocks.route.mockResolvedValue({
    host: "255.255.255.255",
    sourceMac: new Uint8Array([1, 2, 3, 4, 5, 6]),
  });
  mocks.open.mockRejectedValue(new Error("login timed out"));
  const client = new MikroTikMacTelnetClient({
    mac: "48:A9:8A:C6:42:F7",
    username: "test",
    timeoutMs: 100,
  });
  expect(await client.connect()).toBe(false);
  expect(client.lastError).toMatch(/login timed out.*Interfaces tried/s);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.consoleClose).toHaveBeenCalledOnce();
  await expect(client.run("/print")).rejects.toThrow(/Not connected/);
});

test("socket readiness failure cleans up without opening a console", async () => {
  mocks.ready.mockRejectedValue(new Error("UDP unavailable"));
  const client = new MikroTikMacTelnetClient({
    mac: "48:A9:8A:C6:42:F7",
    username: "test",
    host: "192.0.2.255",
  });
  expect(await client.connect()).toBe(false);
  expect(client.lastError).toBe("UDP unavailable");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});
