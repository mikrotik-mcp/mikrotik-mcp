import { beforeEach, expect, test, vi } from "vite-plus/test";
import { ipSshTools } from "../src/tools/ip-ssh";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx = { device: "lab", info: vi.fn() };
function call(name: string, args: Record<string, unknown> = {}) {
  const tool = ipSshTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx as never);
}
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});

test("reading settings distinguishes empty output from a configured SSH server", async () => {
  expect(await call("get_ssh_settings")).toBe("No SSH server settings returned.");
  command.mockResolvedValueOnce("forwarding-enabled=local");
  expect(await call("get_ssh_settings")).toContain("forwarding-enabled=local");
  expect(command.mock.calls[0][0]).toBe("/ip ssh print");
});

test("settings update preserves explicit false values and reads back only after success", async () => {
  expect(await call("set_ssh_settings")).toContain("No settings specified");
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce("failure: policy locked");
  expect(await call("set_ssh_settings", { strong_crypto: false })).toContain("policy locked");
  expect(command).toHaveBeenCalledTimes(1);
  command.mockResolvedValueOnce("").mockResolvedValueOnce("forwarding-enabled=local");
  expect(
    await call("set_ssh_settings", {
      forwarding_enabled: "local",
      strong_crypto: false,
      allow_none_crypto: false,
      host_key_type: "ed25519",
      host_key_size: 4096,
    }),
  ).toContain("forwarding-enabled=local");
  expect(command.mock.calls[1][0]).toBe(
    "/ip ssh set forwarding-enabled=local strong-crypto=no allow-none-crypto=no host-key-type=ed25519 host-key-size=4096",
  );
  expect(command.mock.calls[2][0]).toBe("/ip ssh print");
});

test("key regeneration reports failure or returned device output", async () => {
  command.mockResolvedValueOnce("failure: denied").mockResolvedValueOnce("new fingerprint");
  expect(await call("regenerate_ssh_host_key")).toContain("Failed to regenerate");
  expect(await call("regenerate_ssh_host_key")).toContain("new fingerprint");
  expect(command.mock.calls[0][0]).toBe("/ip ssh regenerate-host-key");
});

test("host key export and import build file arguments and report errors", async () => {
  command
    .mockResolvedValueOnce("failure: disk full")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("failure: invalid key")
    .mockResolvedValueOnce("imported");
  expect(await call("export_ssh_host_key", { key_file_prefix: "edge host" })).toContain(
    "disk full",
  );
  expect(command.mock.calls[0][0]).toBe('/ip ssh export-host-key key-file-prefix="edge host"');
  expect(await call("export_ssh_host_key", { key_file_prefix: "edge" })).toContain(
    "exported with prefix",
  );
  expect(
    await call("import_ssh_host_key", {
      private_key_file: "host.key",
      public_key_file: "host.pub",
    }),
  ).toContain("invalid key");
  expect(command.mock.calls[2][0]).toBe(
    "/ip ssh import-host-key private-key-file=host.key public-key-file=host.pub",
  );
  expect(await call("import_ssh_host_key", { private_key_file: "host.key" })).toContain("imported");
});
