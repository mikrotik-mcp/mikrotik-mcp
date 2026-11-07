import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { ready, upgrade } from "../scripts/service.ts";
import type { UpgradeIO } from "../scripts/service.ts";

function fixture(): UpgradeIO {
  return {
    install: vi.fn().mockResolvedValue(undefined),
    installedVersion: vi.fn().mockResolvedValue("6.11.0"),
    restart: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue(true),
    wait: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("shared service upgrade", () => {
  it("installs before restart and waits for the installed version", async () => {
    const io = fixture();
    vi.mocked(io.ready).mockResolvedValueOnce(false);
    expect(await upgrade(io)).toBe("6.11.0");
    expect(io.ready).toHaveBeenCalledWith("6.11.0");
    expect(io.wait).toHaveBeenCalledTimes(1);
    expect(vi.mocked(io.install).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(io.restart).mock.invocationCallOrder[0],
    );
  });
  it("does not restart after an install failure", async () => {
    const io = fixture();
    vi.mocked(io.install).mockRejectedValue(new Error("offline"));
    await expect(upgrade(io)).rejects.toThrow("offline");
    expect(io.restart).not.toHaveBeenCalled();
  });
  it("rejects a broken CLI before restarting", async () => {
    const io = fixture();
    vi.mocked(io.installedVersion).mockResolvedValue("error");
    await expect(upgrade(io)).rejects.toThrow("valid version");
    expect(io.restart).not.toHaveBeenCalled();
  });
  it("fails bounded readiness instead of claiming success", async () => {
    const io = fixture();
    vi.mocked(io.ready).mockResolvedValue(false);
    await expect(upgrade(io)).rejects.toThrow("did not become ready");
    expect(io.ready).toHaveBeenCalledTimes(30);
  });
  it.each(["application/json", "text/event-stream"])(
    "verifies %s MCP responses and closes the probe session",
    async (format) => {
      const body = JSON.stringify({ result: { serverInfo: { version: "6.11.0" } } });
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(format === "application/json" ? body : `event: message\ndata: ${body}\n\n`, {
            headers: { "content-type": format, "mcp-session-id": "probe-session" },
          }),
        )
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", request);
      expect(await ready("http://localhost:8000/mcp", "6.11.0")).toBe(true);
      expect(request.mock.calls[1][1]).toMatchObject({
        method: "DELETE",
        headers: { "mcp-session-id": "probe-session" },
      });
    },
  );
  it("rejects old running versions", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ result: { serverInfo: { version: "6.10.0" } } })),
        ),
    );
    expect(await ready("http://localhost:8000/mcp", "6.11.0")).toBe(false);
  });
});
