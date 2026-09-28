// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vite-plus/test";
import { api, deleteEvents, deleteJson, postJson } from "../../ui/observability/api";

afterEach(() => vi.unstubAllGlobals());

test.each([502, 503])("GET preserves device error details on HTTP %s", async (status) => {
  const error = "Failed to connect to MikroTik device 'edge' — connect ECONNREFUSED";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error }, { status })),
  );
  await expect(api("/api/aaa/list/radius?device=edge")).rejects.toThrow(error);
});

test.each([
  [401, "Dashboard authentication required"],
  [403, "This request is not permitted"],
  [502, "The dashboard could not complete this request (HTTP 502)"],
  [503, "The dashboard could not complete this request (HTTP 503)"],
])(
  "non-JSON HTTP %s errors do not imply an offline device or expose HTML",
  async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>private stack</html>", { status: Number(status) })),
    );
    await expect(api("/api/aaa/list/radius")).rejects.toThrow(String(message));
  },
);

test("malformed error bodies fall back safely and successful responses remain intact", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: { nested: "private" } }, { status: 500 }))
    .mockResolvedValueOnce(Response.json({ rows: [] }));
  vi.stubGlobal("fetch", fetch);
  await expect(api("/api/test")).rejects.toThrow("HTTP 500");
  await expect(api("/api/test")).resolves.toEqual({ rows: [] });
});

test("event deletion keeps server error details too", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Store is unavailable" }, { status: 500 })),
  );
  await expect(deleteEvents({ ids: ["event-1"] })).rejects.toThrow("Store is unavailable");
});

test("POST and DELETE preserve structured validation responses for existing callers", async () => {
  const payload = { ok: false, error: "Invalid draft", issues: ["missing device"] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(payload, { status: 400 })),
  );
  await expect(postJson("/api/config", {})).resolves.toEqual(payload);
  await expect(deleteJson("/api/config", {})).resolves.toEqual(payload);
});

test("POST and DELETE surface a disconnected device through the existing error handlers", async () => {
  const error = "Failed to connect to MikroTik device 'edge'";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ code: "DEVICE_CONNECTION_FAILED", error }, { status: 503 })),
  );
  await expect(postJson("/api/aaa/add", {})).rejects.toThrow(error);
  await expect(deleteJson("/api/test", {})).rejects.toThrow(error);
});

test("abort and network failures are not re-labelled as a device disconnection", async () => {
  const aborted = new DOMException("Aborted", "AbortError");
  const network = new TypeError("Failed to fetch");
  const fetch = vi.fn().mockRejectedValueOnce(aborted).mockRejectedValueOnce(network);
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(api("/api/test", signal)).rejects.toBe(aborted);
  expect(fetch).toHaveBeenCalledWith("/api/test", { signal, headers: {} });
  await expect(api("/api/test")).rejects.toBe(network);
});
