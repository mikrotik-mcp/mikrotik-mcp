import { beforeEach, expect, test, vi } from "vite-plus/test";
import { AlertRuleSchema } from "../src/alerts/model";
import type { ToolContext } from "../src/core/context";
import { alertTools } from "../src/tools/alerts";

const mocks = vi.hoisted(() => ({ getEngine: vi.fn(), deliver: vi.fn() }));
vi.mock("../src/alerts/engine", () => ({ ANY_SUBJECT: "*", getAlertEngine: mocks.getEngine }));
vi.mock("../src/alerts/channels", () => ({
  deliver: mocks.deliver,
  redactChannels: () => ({}),
}));

const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = AlertRuleSchema.parse({
  id: "ssh-errors",
  when: { event: "tool_call", isError: true },
  channels: ["mcp"],
});
let rules = [initial];
const engine = {
  snapshot: vi.fn(),
  history: vi.fn(),
  configuredRules: vi.fn(),
  setRules: vi.fn(),
};

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = alertTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown alert tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  rules = [initial];
  engine.snapshot.mockImplementation(() =>
    rules.map((rule) => ({ rule, subject: "fixture", state: { status: "clear" } })),
  );
  engine.configuredRules.mockImplementation(() => rules);
  engine.setRules.mockImplementation((next) => {
    rules = next;
  });
  engine.history.mockResolvedValue([]);
  mocks.getEngine.mockReturnValue(engine);
  mocks.deliver.mockResolvedValue({ ok: true, durationMs: 12, attempts: 1 });
});

test("rule list includes per-subject state and reports an unconfigured engine", async () => {
  expect(await call("list_alert_rules")).toContain("ssh-errors  on fixture");
  expect(await call("list_alert_rules")).toContain("CHANNELS: none configured");
  mocks.getEngine.mockReturnValueOnce(null);
  expect(await call("list_alert_rules")).toContain("Alerting is not configured");
  rules = [];
  expect(await call("list_alert_rules")).toContain("No alert rules configured");
});

test("history distinguishes empty, failed delivery and missing engine", async () => {
  expect(await call("get_alert_history", { hours: 2, limit: 5 })).toContain(
    "No alerts in the last 2h",
  );
  engine.history.mockResolvedValueOnce([
    {
      ts: Date.UTC(2026, 9, 24),
      kind: "fire",
      ruleId: "ssh-errors",
      severity: "high",
      device: "fixture",
      title: "SSH failed",
      body: "Review the source",
      deliveries: [{ channel: "mcp", ok: false, error: "offline" }],
    },
  ]);
  expect(await call("get_alert_history", { hours: 2, rule_id: "ssh-errors", limit: 5 })).toContain(
    "mcp FAILED (offline)",
  );
  expect(engine.history).toHaveBeenLastCalledWith(
    expect.objectContaining({ ruleId: "ssh-errors", limit: 5 }),
  );
  mocks.getEngine.mockReturnValueOnce(null);
  expect(await call("get_alert_history", { hours: 2, limit: 5 })).toContain(
    "Alerting is not configured",
  );
});

test("add validates JSON and schema before changing running rules", async () => {
  expect(
    await call("add_alert_rule", {
      id: "bad",
      trigger: "{",
      channels: ["mcp"],
      severity: "medium",
      cooldown: "15m",
    }),
  ).toContain("not valid JSON");
  expect(
    await call("add_alert_rule", {
      id: "bad",
      trigger: '{"nonsense":true}',
      channels: ["mcp"],
      severity: "medium",
      cooldown: "15m",
    }),
  ).toContain("Invalid rule");
  expect(rules).toHaveLength(1);
  const args = {
    id: "ssh-errors",
    trigger: '{"event":"tool_call"}',
    channels: ["mcp"],
    severity: "medium",
    cooldown: "15m",
  };
  expect(await call("add_alert_rule", args)).toContain("already exists");
  expect(await call("add_alert_rule", { ...args, id: "new-rule" })).toContain("new-rule' added");
  expect(rules).toHaveLength(2);
  mocks.getEngine.mockReturnValueOnce(null);
  expect(await call("add_alert_rule", { ...args, id: "another" })).toContain(
    "Alerting is not configured",
  );
});

test("update preserves omitted fields and rejects invalid changes without replacing a rule", async () => {
  expect(await call("update_alert_rule", { id: "missing" })).toContain("No alert rule");
  expect(await call("update_alert_rule", { id: "ssh-errors", trigger: "{" })).toContain(
    "not valid JSON",
  );
  expect(
    await call("update_alert_rule", { id: "ssh-errors", trigger: '{"invalid":true}' }),
  ).toContain("Invalid rule");
  expect(rules[0].when).toEqual(initial.when);
  expect(
    await call("update_alert_rule", { id: "ssh-errors", enabled: false, cooldown: "20m" }),
  ).toContain("updated");
  expect(rules[0]).toMatchObject({ enabled: false, cooldown: "20m", when: initial.when });
});

test("remove reports missing rules and deletes only the requested id", async () => {
  expect(await call("remove_alert_rule", { id: "missing" })).toContain("No alert rule");
  expect(await call("remove_alert_rule", { id: "ssh-errors" })).toContain("removed");
  expect(rules).toEqual([]);
  mocks.getEngine.mockReturnValueOnce(null);
  expect(await call("remove_alert_rule", { id: "ssh-errors" })).toContain(
    "Alerting is not configured",
  );
});

test("mute rejects malformed duration and un-mute removes the deadline", async () => {
  expect(await call("mute_alert_rule", { id: "ssh-errors", duration: "soon" })).toContain(
    "Invalid duration",
  );
  expect(await call("mute_alert_rule", { id: "missing", duration: "1h" })).toContain(
    "No alert rule",
  );
  expect(await call("mute_alert_rule", { id: "ssh-errors", duration: "1h" })).toContain(
    "muted until",
  );
  expect(rules[0].mutedUntil).toBeGreaterThan(Date.now());
  expect(await call("mute_alert_rule", { id: "ssh-errors", duration: "0s" })).toContain("un-muted");
  expect(rules[0].mutedUntil).toBeUndefined();
});
