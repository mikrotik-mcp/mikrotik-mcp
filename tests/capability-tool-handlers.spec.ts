import { beforeEach, expect, test, vi } from "vite-plus/test";
import { unknownCapabilities } from "../src/core/capability";
import type { Capabilities } from "../src/core/capability";
import { capabilityTools } from "../src/tools/capability";

const mocks = vi.hoisted(() => ({ get: vi.fn(), invalidate: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/core/capability-cache", () => ({
  getCapabilities: mocks.get,
  invalidateCapabilities: mocks.invalidate,
}));
vi.mock("../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/runtime")>()),
  resolveDeviceName: mocks.resolve,
}));

const info = vi.fn();
const ctx = { device: "lab", info };
const call = (index: number) => capabilityTools[index].handler({}, ctx as never);

function known(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    ...unknownCapabilities(),
    version: { raw: "7.20.1", major: 7, minor: 20, patch: 1 } as Capabilities["version"],
    channel: "stable",
    board: "hAP ax3",
    arch: "arm64",
    isRouterBoard: true,
    packages: new Set(["routeros", "container", "user-manager"]),
    wirelessStack: "wifi",
    probedAt: Date.UTC(2026, 0, 1),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockReturnValue("home-ax3");
  mocks.get.mockResolvedValue(unknownCapabilities());
});

test("unknown probe explains why tools are not gated", async () => {
  const result = await call(0);
  expect(result).toContain("DEVICE CAPABILITIES — home-ax3");
  expect(result).toContain("Nothing is being gated");
  expect(mocks.get).toHaveBeenCalledWith("lab");
  expect(info).toHaveBeenCalledWith("Reading device capabilities: home-ax3");
});

test("known device reports software, hardware, permissions and enabled features", async () => {
  mocks.get.mockResolvedValue(known());
  const result = await call(0);
  expect(result).toContain("RouterOS:      7.20.1 (stable)");
  expect(result).toContain("hAP ax3 · arm64");
  expect(result).toContain("/interface wifi");
  expect(result).toContain("Container tools available");
  expect(result).toContain("User Manager (RADIUS) tools available");
  expect(result).toContain("Probed at 2026-01-01");
});

test("installed container package without device-mode permission is explicitly blocked", async () => {
  mocks.get.mockResolvedValue(
    known({ deviceMode: { container: false, scheduler: false, fetch: true } }),
  );
  const result = await call(0);
  expect(result).toContain("container:   BLOCKED");
  expect(result).toContain("physical reset-button confirmation");
});

test("missing packages and wired CHR produce useful feature limitations", async () => {
  mocks.get.mockResolvedValue(
    known({
      packages: new Set(["routeros"]),
      board: "CHR",
      isRouterBoard: false,
      wirelessStack: "none",
      channel: "unknown",
    }),
  );
  const result = await call(0);
  expect(result).toContain("Container tools unavailable");
  expect(result).toContain("User Manager tools unavailable");
  expect(result).toContain("PoE tools unavailable");
  expect(result).toContain("No wireless stack detected");
  expect(result).not.toContain("(unknown)");
});

test.each(["wireless", "capsman-legacy"] as const)(
  "renders %s wireless stack",
  async (wirelessStack) => {
    mocks.get.mockResolvedValue(known({ wirelessStack }));
    expect(await call(0)).toContain(
      wirelessStack === "wireless" ? "/interface wireless" : "/caps-man",
    );
  },
);

test("refresh invalidates the selected device before obtaining new capabilities", async () => {
  mocks.get.mockResolvedValue(known());
  const result = await call(1);
  expect(mocks.invalidate).toHaveBeenCalledWith("lab");
  expect(mocks.get).toHaveBeenCalledWith("lab");
  expect(result).toContain("7.20.1");
  expect(info).toHaveBeenCalledWith("Refreshing device capabilities: home-ax3");
});
