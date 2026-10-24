import { beforeEach, expect, test, vi } from "vite-plus/test";
import { routingRpkiTools } from "../src/tools/routing-rpki";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx = { device: "lab", info: vi.fn() };
function call(name: string, args: Record<string, unknown> = {}) {
  const tool = routingRpkiTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx as never);
}
beforeEach(() => {
  command.mockReset().mockResolvedValue("");
});

test("listing distinguishes unsupported, empty, and filtered sessions", async () => {
  command
    .mockResolvedValueOnce("bad command name")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("0 group=core");
  expect(await call("list_rpki_sessions")).toContain("not available");
  expect(await call("list_rpki_sessions")).toBe("No RPKI sessions found.");
  expect(await call("list_rpki_sessions", { group_filter: "core" })).toContain("group=core");
  expect(command.mock.calls[2][0]).toBe('/routing rpki print detail where group="core"');
});

test("adding a session includes timing, VRF, and disabled state and reports device failure", async () => {
  command.mockResolvedValueOnce("*A").mockResolvedValueOnce("failure: invalid cache");
  const args = {
    group: "core",
    address: "192.0.2.4",
    port: 8282,
    refresh_interval: "10m",
    retry_interval: "30s",
    expire_interval: "2h",
    vrf: "main",
    comment: "validator",
    disabled: true,
  };
  expect(await call("add_rpki_session", args)).toContain("id *A");
  expect(command.mock.calls[0][0]).toContain(
    "refresh-interval=10m expire-interval=2h retry-interval=30s vrf=main comment=validator disabled",
  );
  expect(await call("add_rpki_session", args)).toContain("Failed to add RPKI session");
});

test("update omits router call for no changes and reads details only after success", async () => {
  expect(await call("update_rpki_session", { session_id: "*A" })).toBe("No updates specified.");
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce("failure: denied");
  expect(await call("update_rpki_session", { session_id: "*A", disabled: false })).toContain(
    "Failed to update",
  );
  expect(command).toHaveBeenCalledTimes(1);
  command.mockResolvedValueOnce("").mockResolvedValueOnce("0 group=core disabled=no");
  expect(
    await call("update_rpki_session", { session_id: "*A", comment: "", disabled: false }),
  ).toContain("disabled=no");
  expect(command.mock.calls[1][0]).toContain('comment="" disabled=no');
  expect(command.mock.calls[2][0]).toBe("/routing rpki print detail where .id=*A");
});

test("toggle and removal report unsupported or failed commands before success", async () => {
  command
    .mockResolvedValueOnce("failure: denied")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("bad command name");
  expect(await call("set_rpki_session_enabled", { session_id: "*A", enabled: false })).toContain(
    "Failed to update",
  );
  expect(command.mock.calls[0][0]).toBe("/routing rpki set *A disabled=yes");
  expect(await call("set_rpki_session_enabled", { session_id: "*A", enabled: true })).toContain(
    "enabled",
  );
  expect(command.mock.calls[1][0]).toBe("/routing rpki set *A disabled=no");
  expect(await call("remove_rpki_session", { session_id: "*A" })).toContain("removed successfully");
  expect(await call("remove_rpki_session", { session_id: "*A" })).toContain("not available");
});
