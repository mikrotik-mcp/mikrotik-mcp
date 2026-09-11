import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { MikrotikConfigSchema, loadConfig } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  addressAllowed,
  contractInput,
  overallStatus,
  ProbeTargetSchema,
} from "../../src/service-contracts/model";
import { nativeProbeIO, probeTarget } from "../../src/service-contracts/probe";
import { evaluateContract } from "../../src/service-contracts/run";

vi.mock("../../src/sim/suites", () => ({
  getSuite: async (id: string) =>
    id === "fixture"
      ? {
          packets: [
            {
              name: "guest isolation",
              packet: {
                srcAddress: "192.0.2.10",
                dstAddress: "198.51.100.10",
                protocol: "tcp",
                inInterface: "lan",
                connectionState: "new",
              },
              expect: "drop",
            },
          ],
        }
      : null,
}));

const original = getConfig();
const approved = ProbeTargetSchema.parse({
  kind: "https",
  host: "app.example.com",
  addresses: ["192.0.2.0/24"],
});
const contract = () => ({
  ...contractInput.parse({ name: "Checkout", checks: [{ target: "checkout" }] }),
  id: "test",
  device: "edge",
  createdAt: 1,
});
beforeEach(() =>
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "192.0.2.1" } },
      defaultDevice: "edge",
      serviceProbes: { targets: { checkout: approved } },
    }),
  ),
);
afterEach(() => {
  setConfig(original);
  vi.useRealTimers();
});
describe("approved service probes", () => {
  test("an attached packet suite without a fresh export is unknown", async () => {
    const r = await evaluateContract(
      { ...contract(), packetSuiteId: "fixture" },
      {
        resolve: async () => ["192.0.2.10"],
        connect: async () => ({ ok: true, httpStatus: 200, detail: "headers" }),
      },
    );
    expect(r.status).toBe("unknown");
    expect(r.checks.at(-1)?.kind).toBe("simulation");
  });
  test("a packet suite evaluates exactly the export supplied for this run", async () => {
    const config =
      "/interface bridge\nadd name=lan\nadd name=wan\n/ip address\nadd address=192.0.2.1/24 interface=lan\nadd address=198.51.100.1/24 interface=wan\n/ip firewall filter\nadd chain=forward action=drop\n";
    const io = {
      resolve: async () => ["192.0.2.10"],
      connect: async () => ({ ok: true, httpStatus: 200, detail: "headers" }),
    };
    const before = await evaluateContract({ ...contract(), packetSuiteId: "fixture" }, io, config);
    const after = await evaluateContract(
      { ...contract(), packetSuiteId: "fixture" },
      io,
      config.replace("action=drop", "action=accept"),
    );
    expect(before.checks.at(-1)?.status).toBe("pass");
    expect(after.checks.at(-1)?.status).toBe("fail");
    expect(before.checks.at(-1)?.detail).toContain("Export SHA");
  });
  test("requires approved ranges and validates paths", () => {
    expect(
      ProbeTargetSchema.safeParse({ kind: "https", host: "app.example.com", addresses: [] })
        .success,
    ).toBe(false);
    for (const path of [
      "//other.example",
      "/health?secret=x",
      "/x\r\nX-Injected: yes",
      "/health#x",
    ])
      expect(ProbeTargetSchema.safeParse({ ...approved, path }).success).toBe(false);
    expect(MikrotikConfigSchema.parse({}).serviceProbes.targets).toEqual({});
  });
  test("matches exact IPs/CIDRs without mixing address families", () => {
    expect(addressAllowed("192.0.2.4", ["192.0.2.0/24"])).toBe(true);
    expect(addressAllowed("169.254.169.254", ["192.0.2.0/24"])).toBe(false);
    expect(addressAllowed("::ffff:192.0.2.4", ["192.0.2.4"])).toBe(true);
    expect(addressAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(addressAllowed("::1", ["127.0.0.1"])).toBe(false);
    expect(addressAllowed("invalid", ["127.0.0.1"])).toBe(false);
  });
  test("rejects mixed DNS answers and never connects outside the allowlist", async () => {
    const connect = vi.fn();
    await expect(
      probeTarget(approved, 500, {
        resolve: async () => ["192.0.2.10", "169.254.169.254"],
        connect,
      }),
    ).rejects.toThrow("outside approved");
    expect(connect).not.toHaveBeenCalled();
  });
  test("pins the accepted address while preserving the original TLS identity", async () => {
    const connect = vi.fn(async (_target: unknown, _address: string, _timeout: number) => ({
      ok: true,
      httpStatus: 200,
      detail: "headers",
    }));
    await probeTarget(approved, 500, { resolve: async () => ["192.0.2.10"], connect });
    expect(connect.mock.calls[0][0]).toEqual(approved);
    expect(connect.mock.calls[0][1]).toBe("192.0.2.10");
  });
  test("DNS checks resolve only, without opening a service socket", async () => {
    const connect = vi.fn();
    const r = await probeTarget({ ...approved, kind: "dns" }, 500, {
      resolve: async () => ["192.0.2.10"],
      connect,
    });
    expect(r.ok).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });
  test("unknown aliases do not make network requests", async () => {
    const resolve = vi.fn();
    const c = contract();
    c.checks[0].target = "not-approved";
    const result = await evaluateContract(c, { resolve, connect: vi.fn() });
    expect(result.status).toBe("unknown");
    expect(resolve).not.toHaveBeenCalled();
  });
  test("HTTP status mismatch fails; a successful connection alone is insufficient", async () => {
    const result = await evaluateContract(contract(), {
      resolve: async () => ["192.0.2.10"],
      connect: async () => ({ ok: true, httpStatus: 503, detail: "status 503" }),
    });
    expect(result.status).toBe("fail");
    expect(result.vantage).toBe("mcp-host");
  });
  test("passing headers and thresholds yield an explicitly host-scoped pass", async () => {
    const result = await evaluateContract(contract(), {
      resolve: async () => ["192.0.2.10"],
      connect: async () => ({ ok: true, httpStatus: 200, detail: "headers only" }),
    });
    expect(result.status).toBe("pass");
    expect(result.vantage).toBe("mcp-host");
  });
  test("connection failures are failures, not healthy zeros", async () => {
    const result = await evaluateContract(contract(), {
      resolve: async () => ["192.0.2.10"],
      connect: async () => ({ ok: false, detail: "timeout" }),
    });
    expect(result.status).toBe("fail");
  });
  test("resolution exceptions remain unknown without leaking error text", async () => {
    const result = await evaluateContract(contract(), {
      resolve: async () => {
        throw new Error("private diagnostic");
      },
      connect: vi.fn(),
    });
    expect(result.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });
  test("latency includes DNS and rejects exceeded thresholds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const result = await evaluateContract(contract(), {
      resolve: async () => ["192.0.2.10"],
      connect: async () => {
        vi.setSystemTime(4000);
        return { ok: true, httpStatus: 200, detail: "headers" };
      },
    });
    expect(result.status).toBe("fail");
    expect(result.checks[0].detail).toContain("Latency exceeded");
  });
  test("no checks or unknown checks can pass a gate", () => {
    expect(overallStatus([])).toBe("unknown");
    expect(
      overallStatus([{ target: "x", kind: "dns", status: "unknown", durationMs: 0, detail: "" }]),
    ).toBe("unknown");
  });
  test("native TCP connects locally; TLS on a non-TLS endpoint fails and closes", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.resume();
      socket.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const target = { ...approved, host: "127.0.0.1", port, addresses: ["127.0.0.1"] };
      expect((await probeTarget({ ...target, kind: "tcp" }, 500)).ok).toBe(true);
      expect((await nativeProbeIO.connect({ ...target, kind: "tls" }, "127.0.0.1", 100)).ok).toBe(
        false,
      );
      expect((await nativeProbeIO.connect({ ...target, kind: "https" }, "127.0.0.1", 100)).ok).toBe(
        false,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  test("service probe configuration survives config-source loading", () => {
    const value = loadConfig([
      "--devices",
      JSON.stringify({
        devices: { edge: { host: "192.0.2.1" } },
        serviceProbes: { targets: { checkout: approved } },
      }),
    ]);
    expect(value.serviceProbes.targets.checkout).toEqual(approved);
  });
});
