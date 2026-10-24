import { beforeEach, expect, test, vi } from "vite-plus/test";
import { explainRoutes } from "../../src/observability/explain-routes";

const command = vi.hoisted(() => vi.fn());
const snapshots = vi.hoisted(() => new Map<string, { body: string; device: string }>());
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../../src/core/runtime", () => ({
  resolveDeviceName: (name: string) => name || "default",
}));
vi.mock("../../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({ get: (id: string) => snapshots.get(id) ?? null }),
}));

async function request(path: string, body?: unknown, raw?: string) {
  const url = new URL(`http://localhost${path}`);
  return explainRoutes(
    new Request(
      url,
      body === undefined && raw === undefined
        ? {}
        : {
            method: "POST",
            body: raw ?? JSON.stringify(body),
            headers: { "content-type": "application/json" },
          },
    ),
    url,
  );
}
beforeEach(() => {
  snapshots.clear();
  command.mockReset().mockResolvedValue("/ip ssh\nset strong-crypto=yes");
});

test("invalid diff requests fail before any device access", async () => {
  expect((await request("/api/explain/diff", undefined, "{"))?.status).toBe(400);
  expect((await request("/api/explain/diff", { afterText: "x" }))?.status).toBe(400);
  expect(command).not.toHaveBeenCalled();
});
test("supplied text yields a rendered diff entirely offline", async () => {
  const response = await request("/api/explain/diff", {
    beforeText: "/ip ssh\nset strong-crypto=no",
    afterText: "/ip ssh\nset strong-crypto=yes",
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    before: "supplied text",
    after: "supplied text",
    markdown: expect.any(String),
  });
  expect(command).not.toHaveBeenCalled();
});
test("snapshot lookup reports the side that is missing", async () => {
  expect(
    await (await request("/api/explain/diff", { before: "gone", afterText: "text" }))?.json(),
  ).toEqual({ error: "before: no snapshot 'gone'" });
  snapshots.set("before", { body: "/ip ssh\nset strong-crypto=no", device: "lab" });
  expect(
    await (await request("/api/explain/diff", { before: "before", after: "gone" }))?.json(),
  ).toEqual({ error: "after: no snapshot 'gone'" });
  expect(command).not.toHaveBeenCalled();
});
test("snapshot narrative and section have rendered content and source", async () => {
  snapshots.set("one", { body: "/ip ssh\nset strong-crypto=yes", device: "lab" });
  const response = await request("/api/explain/lab?snapshot=one");
  expect(await response?.json()).toMatchObject({
    source: "snapshot one",
    narrative: { device: "lab" },
    markdown: expect.any(String),
    mermaid: expect.any(String),
  });
  const invalid = await request("/api/explain/lab/section/unknown?snapshot=one");
  expect(invalid?.status).toBe(400);
  expect((await invalid?.json())?.error).toContain("unknown section");
  expect(command).not.toHaveBeenCalled();
});
test("live export errors, thrown transport failures and unmatched methods are distinct", async () => {
  command.mockResolvedValueOnce("");
  expect((await request("/api/explain/lab"))?.status).toBe(502);
  command.mockRejectedValueOnce(new Error("offline"));
  expect(await (await request("/api/explain/lab"))?.json()).toEqual({ error: "offline" });
  expect((await request("/api/explain/lab", {}))?.status).toBe(404);
  expect(await request("/api/elsewhere")).toBeNull();
});
