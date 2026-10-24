import { beforeEach, expect, test, vi } from "vite-plus/test";
import { AlertRuleSchema } from "../../src/alerts/model";
import type { AlertRule } from "../../src/alerts/model";
import { alertRoutes } from "../../src/observability/alert-routes";
import type { EventStore } from "../../src/observability/store";

const state = vi.hoisted(() => ({ enabled: true, rules: [] as AlertRule[] }));
vi.mock("../../src/alerts/engine", () => ({
  getAlertEngine: () =>
    state.enabled
      ? {
          snapshot: () =>
            state.rules.map((rule) => ({
              rule,
              subject: "lab",
              state: { status: "firing", since: 1 },
            })),
          history: async () => [{ ruleId: "ssh-errors", kind: "fire", ts: 1 }],
          configuredRules: () => state.rules,
          setRules: (rules: AlertRule[]) => {
            state.rules = rules;
          },
        }
      : null,
}));
const rule = AlertRuleSchema.parse({
  id: "ssh-errors",
  when: { event: "tool_call", isError: true },
  channels: ["mcp"],
});
async function request(path: string, init?: RequestInit) {
  const req = new Request(`http://localhost${path}`, init);
  const response = await alertRoutes(req, new URL(req.url), null);
  if (!response && path.startsWith("/api/alerts"))
    throw new Error(`Unexpected unhandled alert route: ${path}`);
  return response;
}
function post(data: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(data) };
}
beforeEach(() => {
  state.enabled = true;
  state.rules = [];
});

test("unconfigured alerting exposes honest empty state and rejects rule creation", async () => {
  expect(await request("/api/other")).toBeNull();
  state.enabled = false;
  expect(await (await request("/api/alerts"))!.json()).toMatchObject({
    configured: false,
    rules: [],
  });
  expect(await (await request("/api/alerts/history"))!.json()).toEqual({ history: [] });
  expect((await request("/api/alerts/rules", post(rule)))?.status).toBe(400);
});

test("rule CRUD preserves validated schema and rejects duplicates or invalid mute duration", async () => {
  expect((await request("/api/alerts/rules", post({ id: "broken" })))?.status).toBe(400);
  expect((await request("/api/alerts/rules", post(rule)))?.status).toBe(200);
  expect((await request("/api/alerts/rules", post(rule)))?.status).toBe(409);
  expect(
    ((await (await request("/api/alerts"))!.json()) as { active: unknown[] }).active,
  ).toHaveLength(1);
  expect(
    (
      await request("/api/alerts/rules/ssh-errors", {
        method: "PATCH",
        body: JSON.stringify({ mute: "invalid" }),
      })
    )?.status,
  ).toBe(400);
  expect(
    (
      await request("/api/alerts/rules/ssh-errors", {
        method: "PATCH",
        body: JSON.stringify({ mute: "5m" }),
      })
    )?.status,
  ).toBe(200);
  expect((await request("/api/alerts/rules/unknown", { method: "DELETE" }))?.status).toBe(404);
  expect((await request("/api/alerts/rules/ssh-errors", { method: "DELETE" }))?.status).toBe(200);
  expect(state.rules).toEqual([]);
});

test("history and preview distinguish no event store from a quiet rule", async () => {
  expect(
    ((await (await request("/api/alerts/history?hours=2"))!.json()) as { history: unknown[] })
      .history,
  ).toHaveLength(1);
  const preview = await request("/api/alerts/preview", post(rule));
  expect(await preview!.json()).toMatchObject({ sampled: 0, noHistory: true });
  expect((await request("/api/alerts/preview", post({ id: "bad" })))?.status).toBe(400);
  const req = new Request("http://localhost/api/alerts/preview?hours=1", post(rule));
  const withHistory = await alertRoutes(req, new URL(req.url), {
    query: () => [{ ts: Date.now(), tool: "probe", device: "lab", risk: "READ", isError: true }],
  } as unknown as EventStore);
  expect(await withHistory!.json()).toMatchObject({ sampled: 1, matched: 1, fires: 1 });
});
