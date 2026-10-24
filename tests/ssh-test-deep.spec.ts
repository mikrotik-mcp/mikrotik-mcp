import { beforeEach, expect, test, vi } from "vite-plus/test";
import { sshTestTools } from "../src/tools/ssh-test";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  run: vi.fn(),
  disconnect: vi.fn(),
  options: [] as unknown[],
  getDevice: vi.fn(),
  resolveName: vi.fn(),
  resolveJump: vi.fn(),
  sshOptions: vi.fn(),
  command: vi.fn(),
}));
vi.mock("../src/ssh/client", () => ({
  MikroTikSSHClient: class {
    lastError = "refused";
    constructor(options: unknown) {
      mocks.options.push(options);
    }
    connect = mocks.connect;
    run = mocks.run;
    disconnect = mocks.disconnect;
  },
}));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  getDevice: mocks.getDevice,
  resolveDeviceName: mocks.resolveName,
}));
vi.mock("../src/core/transport", () => ({
  resolveJump: mocks.resolveJump,
  sshOptionsOf: mocks.sshOptions,
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
const ctx = { device: "lab", info: vi.fn() };
function call(name: string, args: Record<string, unknown> = {}) {
  const tool = sshTestTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx as never);
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) if (typeof mock === "function") mock.mockReset();
  mocks.options.length = 0;
  mocks.resolveName.mockReturnValue("lab");
  mocks.getDevice.mockReturnValue({ host: "192.0.2.1", port: 2222, timeoutMs: 30_000 });
  mocks.sshOptions.mockReturnValue({ host: "192.0.2.1", port: 2222 });
  mocks.resolveJump.mockReturnValue(undefined);
});

test("configured MAC-Telnet device never opens SSH", async () => {
  mocks.getDevice.mockReturnValue({ mac: "00:11:22:33:44:55" });
  expect(await call("test_ssh_to_device")).toContain("MAC-Telnet device");
  expect(mocks.connect).not.toHaveBeenCalled();
});

test("configured SSH probe caps timeout, reports identity, and disconnects", async () => {
  mocks.connect.mockResolvedValue(true);
  mocks.run.mockResolvedValue("name: lab-router");
  expect(await call("test_ssh_to_device")).toContain("identity: lab-router");
  expect(mocks.options[0]).toMatchObject({ host: "192.0.2.1", timeoutMs: 10_000 });
  expect(mocks.run).toHaveBeenCalledWith("/system identity print");
  expect(mocks.disconnect).toHaveBeenCalledOnce();
});

test("ad-hoc probe reports auth failure and command failure while always disconnecting", async () => {
  mocks.connect.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  mocks.run.mockRejectedValueOnce(new Error("exec denied"));
  const args = {
    host: "192.0.2.8",
    port: 2200,
    username: "operator",
    key_path: "/fixture/key",
    command: "/system identity print",
  };
  expect(await call("test_ssh_to_host", args)).toContain("could not connect/authenticate: refused");
  expect(await call("test_ssh_to_host", args)).toContain("exec denied");
  expect(mocks.options[0]).toMatchObject({
    host: "192.0.2.8",
    port: 2200,
    username: "operator",
    keyFilename: "/fixture/key",
  });
  expect(mocks.disconnect).toHaveBeenCalledTimes(2);
});

test("router-originated probe builds ssh-exec and distinguishes empty output", async () => {
  mocks.command.mockResolvedValueOnce("  ").mockResolvedValueOnce("name=remote\n");
  const args = { host: "192.0.2.9", port: 22, user: "operator", command: "/system identity print" };
  expect(await call("test_ssh_from_device", args)).toContain("no output");
  expect(await call("test_ssh_from_device", args)).toContain("name=remote");
  expect(mocks.command.mock.calls[0][0]).toBe(
    '/system ssh-exec address=192.0.2.9 port=22 user=operator command="/system identity print"',
  );
  expect(mocks.connect).not.toHaveBeenCalled();
});
