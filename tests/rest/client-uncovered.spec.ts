import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { MikroTikRestClient, RestHttpError, RestUnmappableError } from "../../src/rest/client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function client(overrides: Record<string, unknown> = {}) {
  return new MikroTikRestClient({
    host: "192.0.2.1",
    username: "admin",
    password: "secret",
    ...overrides,
  });
}

describe("offline REST response handling", () => {
  test("tries a second endpoint after a transport failure, then releases its lease", async () => {
    const attempt = vi.fn();
    const release = vi.fn();
    const connected = vi.fn(() => release);
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response('[{"name":"edge"}]')) as unknown as typeof fetch;
    const c = client({
      hosts: () => ["192.0.2.2", "192.0.2.3"],
      onAttempt: attempt,
      onConnected: connected,
    });
    expect(await c.connect()).toBe(true);
    expect(c.connectedHost).toBe("192.0.2.3");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(connected).toHaveBeenCalledWith("192.0.2.3");
    expect(await c.runJson("/system resource print")).toEqual([{ name: "edge" }]);
    c.disconnect();
    expect(release).toHaveBeenCalledOnce();
    expect(c.connectedHost).toBeUndefined();
    await expect(c.runJson("/system resource print")).rejects.toThrow("Not connected");
  });

  test.each([
    [401, "authentication failed"],
    [503, "HTTP 503"],
  ])("reports failed probe %i", async (status, message) => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("", { status })) as unknown as typeof fetch;
    const c = client();
    expect(await c.connect()).toBe(false);
    expect(c.lastError).toContain(message);
  });

  test.each([
    [new Error("self signed certificate"), "apiInsecureTls=true"],
    [new Error("AbortError"), "timed out"],
    ["offline", "REST connection failed: offline"],
  ])("describes an unavailable endpoint", async (failure, expected) => {
    globalThis.fetch = vi.fn().mockRejectedValue(failure) as unknown as typeof fetch;
    const c = client();
    expect(await c.connect()).toBe(false);
    expect(c.lastError).toContain(expected);
  });

  test("never translates unmappable commands or runs while disconnected", async () => {
    const c = client();
    await expect(c.run("/system resource print")).rejects.toThrow("Not connected");
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}")) as unknown as typeof fetch;
    expect(await c.connect()).toBe(true);
    await expect(c.run("/export")).rejects.toBeInstanceOf(RestUnmappableError);
    await expect(c.runJson("/export")).rejects.toBeInstanceOf(RestUnmappableError);
  });

  test("run passes through non-JSON, accepts empty bodies and explains HTTP failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("plain router output"))
      .mockResolvedValueOnce(new Response(" "))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "bad field" }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response("broken", { status: 500, statusText: "Server Error" }),
      ) as unknown as typeof fetch;
    const c = client();
    expect(await c.connect()).toBe(true);
    expect(await c.run("/system resource print")).toBe("plain router output");
    expect(await c.run("/system resource print")).toBe("");
    await expect(c.run("/system resource print")).rejects.toMatchObject({
      status: 400,
      detail: "bad field",
    } satisfies Partial<RestHttpError>);
    await expect(c.run("/system resource print")).rejects.toMatchObject({
      status: 500,
      detail: "Server Error",
    });
  });

  test("runJson distinguishes empty, invalid JSON, and device-side errors", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response(" "))
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "denied" }), { status: 403 }),
      ) as unknown as typeof fetch;
    const c = client({ insecureTls: true });
    expect(await c.connect()).toBe(true);
    expect(await c.runJson("/system resource print")).toEqual([]);
    await expect(c.runJson("/system resource print")).rejects.toThrow("non-JSON");
    await expect(c.runJson("/system resource print")).rejects.toMatchObject({
      status: 403,
      detail: "denied",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tls: { rejectUnauthorized: false } }),
    );
  });
});
