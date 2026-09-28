import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { checkConnectionState, CHECK_PRESENCE_TTL_MS } from "../../src/client-check/model";
import { setConfig } from "../../src/core/runtime";
import { MikrotikConfigSchema } from "../../src/config";
import {
  createCheck,
  authorizedCheck,
  saveCheckRun,
  publicSession,
} from "../../src/client-check/service";
import { clientCheckRoutes } from "../../src/client-check/routes";
const saved = vi.hoisted(() => new Map<string, any>());
vi.mock("../../src/workspaces/store", () => ({
  workspaceStore: async () => ({
    save: (_k: string, v: any) => saved.set(v.id, structuredClone(v)),
    get: (_k: string, id: string) => structuredClone(saved.get(id)),
    replace: (_k: string, before: any, after: any) => {
      if (JSON.stringify(saved.get(before.id)) !== JSON.stringify(before))
        throw new Error("concurrent update");
      saved.set(after.id, structuredClone(after));
    },
  }),
}));
vi.mock("../../src/investigations/store", () => ({
  investigationStore: async () => ({ get: () => undefined }),
}));
beforeEach(() => {
  saved.clear();
  setConfig(
    MikrotikConfigSchema.parse({ devices: { home: { host: "192.0.2.1" } }, defaultDevice: "home" }),
  );
});
afterEach(() => vi.useRealTimers());
const input = {
  label: "Wi-Fi",
  path: "wifi",
  idleMs: [1, 2, 3, 4, 5],
  loadedMs: [10],
  download: { bytes: 1024, ms: 100 },
  upload: { bytes: 1024, ms: 100 },
  errors: [],
};
test("tokens are hashed, linked cases checked, expired/revoked capabilities rejected", async () => {
  const s = await createCheck({ label: "phone" }, "home");
  expect(JSON.stringify(saved.get(s.id))).not.toContain(s.token);
  expect(publicSession(saved.get(s.id))).not.toHaveProperty("tokenHash");
  await expect(authorizedCheck(s.id, "x".repeat(43))).rejects.toThrow();
  saved.get(s.id).expiresAt = 1;
  await expect(authorizedCheck(s.id, s.token)).rejects.toThrow();
  saved.get(s.id).expiresAt = Date.now() + 60000;
  saved.get(s.id).status = "closed";
  await expect(authorizedCheck(s.id, s.token)).rejects.toThrow();
  await expect(
    createCheck({ label: "phone", caseId: crypto.randomUUID() }, "home"),
  ).rejects.toThrow("belong");
});
test("stores server-observed family; concurrent submissions cannot silently replace evidence", async () => {
  const s = await createCheck({ label: "phone" }, "home");
  const results = await Promise.allSettled([
    saveCheckRun(s.id, s.token, input, "2001:db8::1", "https://host"),
    saveCheckRun(s.id, s.token, input, "192.0.2.1", "https://host"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(saved.get(s.id).runs).toHaveLength(1);
  expect(saved.get(s.id).runs[0].family).toBe("IPv6");
  saved.get(s.id).runs = Array.from({ length: 6 }, () => saved.get(s.id).runs[0]);
  await expect(saveCheckRun(s.id, s.token, input, "192.0.2.1", "https://host")).rejects.toThrow(
    "Six-run",
  );
});
test("probe surface isolates methods, origins, sizes and cumulative transfer budget", async () => {
  const s = await createCheck({ label: "phone" }, "home"),
    url = `http://localhost/client-check-api/${s.id}/`;
  const call = (phase: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-client-check-token", s.token);
    const req = new Request(url + phase, {
      ...init,
      headers,
    });
    return clientCheckRoutes(req, new URL(req.url), "192.0.2.10");
  };
  expect((await call("info"))!.status).toBe(200);
  expect((await call("ping", { headers: { origin: "https://attacker.example" } }))!.status).toBe(
    403,
  );
  expect((await call("delete", { method: "POST" }))!.status).toBe(405);
  expect((await call("upload", { method: "POST", body: new Uint8Array(1048577) }))!.status).toBe(
    413,
  );
  expect((await call("result", { method: "POST", body: "x".repeat(20000) }))!.status).toBe(413);
  for (let i = 0; i < 31; i++) {
    const r = (await call("download"))!;
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(4194304);
  }
  expect((await call("download"))!.status).toBe(429);
  expect(
    await clientCheckRoutes(
      new Request("http://localhost/api/config"),
      new URL("http://localhost/api/config"),
    ),
  ).toBeNull();
});

test("only an authorized heartbeat connects; sleeping clients go stale and reconnect without a saved run", async () => {
  vi.useFakeTimers();
  const s = await createCheck({ label: "phone" }, "home");
  const view = () => publicSession(saved.get(s.id));
  const heartbeat = async (token = s.token, origin = "http://192.0.2.1:9091") => {
    const url = new URL(`http://192.0.2.1:9091/client-check-api/${s.id}/presence`);
    return clientCheckRoutes(
      new Request(url, {
        method: "POST",
        body: "{}",
        headers: {
          "x-client-check-token": token,
          origin,
          "user-agent": "Mozilla/5.0 (Linux; Android 15)",
        },
      }),
      url,
      "192.0.2.10",
    );
  };
  expect(checkConnectionState(view(), Date.now())).toBe("pending");
  expect((await heartbeat("x".repeat(43)))!.status).toBe(400);
  expect((await heartbeat(s.token, "https://attacker.example"))!.status).toBe(403);
  expect(view().connection).toBeNull();
  expect((await heartbeat())!.status).toBe(200);
  expect(checkConnectionState(view(), Date.now())).toBe("connected");
  expect(view().connection).toMatchObject({
    peerAddress: "192.0.2.10",
    deviceLabel: "Android device",
  });
  expect(view().runs).toEqual([]);
  expect(saved.get(s.id)).not.toHaveProperty("connection");
  vi.advanceTimersByTime(CHECK_PRESENCE_TTL_MS);
  expect(checkConnectionState(view(), Date.now())).toBe("disconnected");
  expect((await heartbeat())!.status).toBe(200);
  expect(checkConnectionState(view(), Date.now())).toBe("connected");
  // Presence must not race the optimistic write used for actual measurements.
  await Promise.all([
    heartbeat(),
    saveCheckRun(s.id, s.token, input, "192.0.2.10", "http://192.0.2.1:9091"),
  ]);
  expect(view().runs).toHaveLength(1);
  saved.get(s.id).status = "closed";
  expect((await heartbeat())!.status).toBe(400);
  expect(checkConnectionState(view(), Date.now())).toBe("closed");
  saved.get(s.id).status = "open";
  saved.get(s.id).expiresAt = Date.now();
  expect((await heartbeat())!.status).toBe(400);
  expect(checkConnectionState(view(), Date.now())).toBe("expired");
});

test("presence has its own bounded budget, leaving measurement requests available", async () => {
  const s = await createCheck({ label: "hour", minutes: 60 }, "home");
  const call = (action: string) => {
    const url = new URL(`http://localhost/client-check-api/${s.id}/${action}`);
    return clientCheckRoutes(
      new Request(url, {
        method: action === "presence" ? "POST" : "GET",
        headers: { "x-client-check-token": s.token },
      }),
      url,
    );
  };
  for (let n = 0; n < 450; n++) expect((await call("presence"))!.status).toBe(200);
  expect((await call("presence"))!.status).toBe(429);
  expect((await call("ping"))!.status).toBe(200);
});
