import { beforeEach, expect, test, vi } from "vite-plus/test";
import { captureSnapshot } from "../../src/snapshots/capture";
const state = vi.hoisted(() => ({ read: vi.fn(), insert: vi.fn() }));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: state.read }));
vi.mock("../../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({ insert: state.insert }),
}));
beforeEach(() => vi.clearAllMocks());
test.each([
  "",
  "failure: not enough permissions",
  "# error exporting /ip firewall",
  "# RouterOS 7.24\n# error exporting\n/ip address add address=192.0.2.1/24",
])("strict pre-change capture rejects incomplete export %s", async (body) => {
  state.read.mockResolvedValue(body);
  await expect(captureSnapshot({ info() {}, error() {} }, "Home", true)).rejects.toThrow(/export/);
  expect(state.insert).not.toHaveBeenCalled();
});
test("strict pre-change capture persists a usable command export", async () => {
  state.read.mockResolvedValue(
    "# RouterOS 7.24\n/ip address add address=192.0.2.1/24 interface=bridge",
  );
  expect(await captureSnapshot({ info() {}, error() {} }, "Home", true)).toMatch(/^snap_/);
  expect(state.insert).toHaveBeenCalledOnce();
});
