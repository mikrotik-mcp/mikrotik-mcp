import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { certStewardTools } from "../src/tools/cert-steward";

const mocks = vi.hoisted(() => ({
  command: vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = certStewardTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args) as never, ctx);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.command.mockResolvedValue("");
});

describe("certificate steward", () => {
  test("reports device read failure and empty store", async () => {
    mocks.command.mockResolvedValueOnce("failure: denied").mockResolvedValueOnce("");
    expect(await run("audit_certificate_expiry")).toContain("Failed to read certificates");
    expect(await run("audit_certificate_expiry")).toBe(
      "No certificates are installed on this device.",
    );
    expect(mocks.command.mock.calls.map(([cmd]) => cmd)).toEqual([
      "/certificate print detail",
      "/certificate print detail",
    ]);
  });

  test("groups expired, soon, valid and undated certificates", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
      mocks.command.mockResolvedValue(
        ` 0 name="expired" invalid-after=2026-10-20 00:00:00\n 1 name="soon" invalid-after=2026-10-30 00:00:00\n 2 name="valid" invalid-after=2027-01-01 00:00:00\n 3 name="unsigned"`,
      );
      const text = await run("audit_certificate_expiry", { warn_within_days: 10 });
      expect(text).toContain("EXPIRED (1)");
      expect(text).toContain("EXPIRING SOON (1)");
      expect(text).toContain("OK (1)");
      expect(text).toContain("NO EXPIRY (1)");
    } finally {
      vi.useRealTimers();
    }
  });

  test("quotes ACME DNS names and reports device error or empty success", async () => {
    mocks.command.mockResolvedValueOnce("failure: challenge failed").mockResolvedValueOnce("");
    expect(
      await run("request_letsencrypt_certificate", { dns_name: "vpn.example; bad" }),
    ).toContain("Failed to request Let's Encrypt certificate");
    expect(mocks.command.mock.calls[0]?.[0]).toContain('dns-name="vpn.example; bad"');
    expect(await run("request_letsencrypt_certificate", { dns_name: "vpn.example" })).toContain(
      "(device returned no output)",
    );
  });

  test("schema rejects fractional audit threshold without I/O", async () => {
    await expect(run("audit_certificate_expiry", { warn_within_days: 1.5 })).rejects.toThrow();
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
