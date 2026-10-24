import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { userTools } from "../src/tools/users";

const command = vi.hoisted(() => vi.fn<(text: string) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = userTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx);
};
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});

test("group creation validates policies and verifies by returned id or name", async () => {
  expect(await run("add_user_group", { name: "ops", policy: ["unknown"] })).toContain(
    "Invalid policy",
  );
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce("*A").mockResolvedValueOnce("name=ops policy=read");
  expect(await run("add_user_group", { name: "ops", policy: ["read"], skin: "default" })).toContain(
    "created successfully",
  );
  expect(command.mock.calls[1][0]).toContain(".id=*A");
  command.mockResolvedValueOnce("2").mockResolvedValueOnce("");
  expect(await run("add_user_group", { name: "ops", policy: ["read"] })).toContain("with ID: 2");
  command.mockResolvedValueOnce("failure");
  expect(await run("add_user_group", { name: "ops", policy: ["read"] })).toContain(
    "Failed to create",
  );
  command.mockResolvedValueOnce("").mockResolvedValueOnce("name=ops");
  expect(await run("add_user_group", { name: "ops", policy: ["read"] })).toContain(
    "created successfully",
  );
  command.mockResolvedValueOnce("").mockResolvedValueOnce("");
  expect(await run("add_user_group", { name: "ops", policy: ["read"] })).toContain(
    "unable to verify",
  );
});

test("active sessions, disconnection and export report router responses", async () => {
  expect(await run("get_active_users")).toContain("No active users");
  command.mockResolvedValueOnce("0 name=ops");
  expect(await run("get_active_users")).toContain("0 name=ops");
  command.mockResolvedValueOnce("failure: denied");
  expect(await run("disconnect_user", { user_id: "*A" })).toContain("Failed to disconnect");
  expect(await run("disconnect_user", { user_id: "*A" })).toContain("disconnected successfully");
  expect(await run("export_user_config")).toContain("user_config.rsc");
  command.mockResolvedValueOnce("saved");
  expect(await run("export_user_config", { filename: "backup" })).toContain("Export result: saved");
  command.mockResolvedValueOnce("failure: missing file");
  expect(await run("set_user_ssh_keys", { username: "ops", key_file: "key.pub" })).toContain(
    "Failed to import",
  );
});

test("group in use cannot be deleted", async () => {
  command.mockResolvedValueOnce("1").mockResolvedValueOnce("2");
  expect(await run("remove_user_group", { name: "ops" })).toContain("2 users are using");
  expect(command).toHaveBeenCalledTimes(2);
});
