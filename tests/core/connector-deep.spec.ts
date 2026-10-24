import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { createContext } from "../../src/core/context";
import { executeMikrotikCommand, executeMikrotikJson, toRecords } from "../../src/core/connector";
import { getConfig, setConfig } from "../../src/core/runtime";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  run: vi.fn(),
  disconnect: vi.fn(),
  createDeviceClient: vi.fn(),
  isPoolEnabled: vi.fn(),
  runPooled: vi.fn(),
  safe: { isActive: false, requiresRecovery: false, execute: vi.fn() },
}));
vi.mock("../../src/core/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/transport")>()),
  createDeviceClient: mocks.createDeviceClient,
}));
vi.mock("../../src/core/connection-pool", () => ({
  isPoolEnabled: mocks.isPoolEnabled,
  runPooled: mocks.runPooled,
}));
vi.mock("../../src/ssh/safe-mode", () => ({ getSafeModeManager: () => mocks.safe }));

let original: ReturnType<typeof getConfig>;
beforeEach(() => {
  original = getConfig();
  vi.clearAllMocks();
  mocks.safe.isActive = false;
  mocks.safe.requiresRecovery = false;
  mocks.createDeviceClient.mockImplementation(() => mocks);
  mocks.connect.mockResolvedValue(true);
  mocks.run.mockResolvedValue("# ADDRESS\n0 192.0.2.1");
  mocks.isPoolEnabled.mockReturnValue(false);
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        default: { host: "router.invalid", username: "test" },
        layer2: { mac: "48:A9:8A:C6:42:F7", username: "test" },
      },
      defaultDevice: "default",
    }),
  );
});
afterEach(() => setConfig(original));

describe("connector transport lifecycle", () => {
  test("one-shot command forwards timeout and disconnects after success", async () => {
    const ctx = createContext();
    expect(await executeMikrotikCommand("/ip address print", ctx, { maxMs: 123 })).toContain(
      "192.0.2.1",
    );
    expect(mocks.run).toHaveBeenCalledWith("/ip address print", { maxMs: 123 });
    expect(ctx.transport).toBe("ssh");
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  test("failed connect is an error and still disconnects", async () => {
    mocks.connect.mockResolvedValue(false);
    mocks.createDeviceClient.mockImplementation(() => ({
      ...mocks,
      lastError: "handshake refused",
    }));
    const error = await executeMikrotikCommand("/ip address print", createContext()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected connection error");
    expect(error.message).toContain("handshake refused");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  test("run rejection propagates and closes the one-shot client", async () => {
    mocks.run.mockRejectedValue(new Error("outcome unknown"));
    const error = await executeMikrotikCommand("/ip address set", createContext()).catch(
      (e: unknown) => e,
    );
    if (!(error instanceof Error)) throw new Error("expected command error");
    expect(error.message).toBe("outcome unknown");
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  test("pool serves SSH, while MAC-Telnet stays one-shot", async () => {
    mocks.isPoolEnabled.mockReturnValue(true);
    mocks.runPooled.mockResolvedValue("pooled");
    expect(await executeMikrotikCommand("/print", createContext(), { maxMs: 50 })).toBe("pooled");
    expect(mocks.runPooled).toHaveBeenCalledWith("/print", "default", { maxMs: 50 });
    expect(mocks.createDeviceClient).not.toHaveBeenCalled();
    const ctx = createContext(undefined, "layer2");
    await executeMikrotikCommand("/print", ctx);
    expect(ctx.transport).toBe("mac-telnet");
    expect(mocks.createDeviceClient).toHaveBeenCalledOnce();
  });

  test.each(["isActive", "requiresRecovery"] as const)(
    "%s routes through the persistent safe session",
    async (flag) => {
      mocks.safe[flag] = true;
      mocks.safe.execute.mockResolvedValue("safe result");
      const ctx = createContext();
      expect(await executeMikrotikCommand("/system identity print", ctx)).toBe("safe result");
      expect(ctx.transport).toBe("ssh");
      expect(mocks.safe.execute).toHaveBeenCalledWith("/system identity print");
      expect(mocks.createDeviceClient).not.toHaveBeenCalled();
    },
  );

  test("structured output preserves the text transport and empty REST conversion", async () => {
    const ctx = createContext();
    const parsed = await executeMikrotikJson("/ip address print", ctx);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(ctx.transport).toBe("ssh");
    expect(toRecords([])).toEqual({ format: "empty", columns: [], rows: [] });
    expect(toRecords([{ name: "wan", disabled: false, mtu: 1500, comment: null }]).rows[0]).toEqual(
      {
        "#": "0",
        name: "wan",
        disabled: "false",
        mtu: "1500",
      },
    );
  });
});
