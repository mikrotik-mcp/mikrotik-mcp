import { beforeEach, expect, test, vi } from "vite-plus/test";
import { diskTools } from "../src/tools/disk";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));

const ctx = { device: "lab", info: vi.fn() };
async function call(name: string, args: Record<string, unknown>) {
  const tool = diskTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} missing`);
  return tool.handler(args as never, ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue("");
});

test("disk listing distinguishes unsupported menu, empty inventory and filtered detail", async () => {
  execute.mockResolvedValueOnce("bad command name disk");
  expect(await call("list_disks", {})).toContain("not available");
  expect(await call("list_disks", {})).toContain("No disks found");
  execute.mockResolvedValueOnce("slot=usb1 free=2G");
  expect(await call("list_disks", { detail: true, slot_filter: "usb" })).toContain("slot=usb1");
  expect(execute.mock.calls.at(-1)?.[0]).toContain("/disk print detail where");
});

test("format is blocked without explicit confirmation and redacts returned secrets", async () => {
  expect(await call("format_disk", { slot: "usb1", confirm: false })).toContain("not confirmed");
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce("format started");
  expect(await call("format_disk", { slot: "usb1", confirm: true, file_system: "ext4" })).toContain(
    "Formatting disk",
  );
  expect(execute.mock.calls[0][0]).toContain("file-system=ext4");
  execute.mockResolvedValueOnce("failure: cannot format");
  expect(await call("format_disk", { slot: "usb1", confirm: true })).toContain("Failed to format");
});

test("property and share updates skip no-ops and verify successful writes", async () => {
  expect(await call("set_disk", { slot: "usb1" })).toBe("No updates specified.");
  expect(await call("share_disk", { slot: "usb1" })).toBe("No sharing settings specified.");
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce("").mockResolvedValueOnce("slot=usb1 label=backup");
  expect(await call("set_disk", { slot: "usb1", label: "backup" })).toContain("updated");
  expect(execute.mock.calls[0][0]).toContain("label=backup");
  execute.mockResolvedValueOnce("").mockResolvedValueOnce("slot=usb1 smb-sharing=yes");
  expect(await call("share_disk", { slot: "usb1", smb_sharing: true })).toContain("updated");
  expect(execute.mock.calls[2][0]).toContain("smb-sharing=yes");
});

test("eject and remove verify a slot exists before changing disk state", async () => {
  execute.mockResolvedValueOnce("0");
  expect(await call("eject_disk", { slot: "missing" })).toContain("not found");
  execute.mockResolvedValueOnce("1").mockResolvedValueOnce("");
  expect(await call("eject_disk", { slot: "usb1" })).toContain("safe to remove");
  execute.mockResolvedValueOnce("0");
  expect(await call("remove_disk", { slot: "missing" })).toContain("not found");
  execute.mockResolvedValueOnce("1").mockResolvedValueOnce("");
  expect(await call("remove_disk", { slot: "usb1" })).toContain("removed");
});
