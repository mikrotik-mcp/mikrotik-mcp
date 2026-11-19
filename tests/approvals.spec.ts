/** Human approval: a risky call waits for a person, and an approval is for one exact call. */
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import {
  checkApproval,
  decideApproval,
  fingerprintOf,
  listApprovals,
  needsApproval,
  resetApprovals,
  setApprovalNotifier,
} from "../src/core/approvals";
import { DESTRUCTIVE, READ, WRITE, defineTool, registerTools } from "../src/core/registry";
import { getConfig, setConfig } from "../src/core/runtime";
import { approvalRoutes } from "../src/observability/approval-routes";

const command = vi.hoisted(() => vi.fn(async () => ""));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const original = getConfig();
beforeEach(() => {
  resetApprovals();
  command.mockClear();
});
afterEach(() => {
  setConfig(original);
  setApprovalNotifier();
});

const call = (args: Record<string, unknown> = { name: "old-rule" }) => ({
  tool: "remove_filter_rule",
  title: "Remove rule",
  risk: "DESTRUCTIVE" as const,
  device: "edge",
  args,
  shownArgs: args,
});
const idOf = (text: string): string => text.match(/apr_[0-9a-f]{8}/)![0];

test("the policy picks the calls by risk", () => {
  expect(needsApproval(undefined, "DANGEROUS")).toBe(false);
  expect(needsApproval({ enabled: false }, "DANGEROUS")).toBe(false);
  expect(needsApproval({ enabled: true }, "WRITE")).toBe(false);
  expect(needsApproval({ enabled: true }, "DESTRUCTIVE")).toBe(true);
  expect(needsApproval({ enabled: true, minRisk: "WRITE" }, "WRITE_IDEMPOTENT")).toBe(true);
  expect(needsApproval({ enabled: true, minRisk: "WRITE" }, "READ")).toBe(false);
});

test("equal arguments hash equally, whatever the key order", () => {
  expect(fingerprintOf("t", "d", { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
    fingerprintOf("t", "d", { b: [1, { d: 3, c: 2 }], a: 1 }),
  );
  expect(fingerprintOf("t", "d", { a: 1 })).not.toBe(fingerprintOf("t", "other", { a: 1 }));
  expect(fingerprintOf("t", "d", { a: 1 })).not.toBe(fingerprintOf("t", "d", { a: 2 }));
});

test("a call waits, runs once after approval, and waits again", () => {
  const notified = vi.fn();
  setApprovalNotifier(notified);
  const policy = { enabled: true, ttlMinutes: 30 };
  const first = checkApproval(policy, call(), 1000);
  expect(first.allowed).toBe(false);
  const id = idOf((first as { text: string }).text);
  expect(notified).toHaveBeenCalledTimes(1);
  // Asking again makes no second request.
  expect((checkApproval(policy, call(), 2000) as { text: string }).text).toContain(
    `request ${id} still waits`,
  );
  expect(listApprovals(2000)).toHaveLength(1);

  // An approval is not valid for other arguments or another router.
  expect(decideApproval(id, true, " ok ", 30, 3000)).toMatchObject({
    status: "approved",
    note: "ok",
  });
  expect(checkApproval(policy, call({ name: "other-rule" }), 4000).allowed).toBe(false);
  expect(checkApproval(policy, { ...call(), device: "core" }, 4000).allowed).toBe(false);

  expect(checkApproval(policy, call(), 5000)).toEqual({ allowed: true, id });
  // It is spent: the same call needs a new request.
  expect(checkApproval(policy, call(), 6000).allowed).toBe(false);
  expect(listApprovals(6000).find((r) => r.id === id)!.status).toBe("used");
  // A decided request cannot be decided again.
  expect(decideApproval(id, true, undefined, 30, 7000)).toBeNull();
});

test("a rejection is told to the model, and requests and approvals expire", () => {
  const policy = { enabled: true, ttlMinutes: 10 };
  const id = idOf((checkApproval(policy, call(), 0) as { text: string }).text);
  decideApproval(id, false, "not during business hours", 10, 1000);
  const refused = checkApproval(policy, call(), 2000) as { text: string };
  expect(refused.text).toContain("rejected this change");
  expect(refused.text).toContain("not during business hours");

  const other = call({ name: "x" });
  const waiting = idOf((checkApproval(policy, other, 0) as { text: string }).text);
  // After the time to live, the old request is gone and a new one is made.
  const later = checkApproval(policy, other, 11 * 60_000) as { text: string };
  expect(idOf(later.text)).not.toBe(waiting);
  expect(decideApproval(waiting, true, undefined, 10, 11 * 60_000)).toBeNull();
  // An approval that is not used in time is worth nothing.
  const fresh = idOf(later.text);
  decideApproval(fresh, true, undefined, 10, 12 * 60_000);
  expect(checkApproval(policy, other, 23 * 60_000).allowed).toBe(false);
});

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ isError?: boolean; content: { text: string }[] }>;
function register(approvals: Record<string, unknown>): Record<string, Handler> {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { home: { host: "192.0.2.1" } },
      defaultDevice: "home",
      verifyWrites: false,
      approvals,
    }),
  );
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      handlers[name] = handler;
      return { enable() {}, disable() {} };
    },
  };
  const tool = (name: string, annotations: typeof READ) =>
    defineTool({
      name,
      title: name,
      description: "d",
      annotations,
      inputSchema: { name: z.string().optional(), password: z.string().optional() },
      handler: async (_a, ctx) => {
        await (command as unknown as (c: string, x: unknown) => Promise<string>)(
          `/run ${name}`,
          ctx,
        );
        return "done";
      },
    });
  registerTools(server as never, [
    [tool("list_x", READ), tool("add_x", WRITE), tool("remove_x", DESTRUCTIVE)],
  ]);
  return handlers;
}

test("through the registry: nothing reaches the router until a person approves", async () => {
  const tools = register({ enabled: true });
  await tools.list_x!({});
  await tools.add_x!({});
  expect(command).toHaveBeenCalledTimes(2);

  command.mockClear();
  const blocked = await tools.remove_x!({ name: "r1", password: "hunter2" });
  expect(blocked.isError).toBe(true);
  expect(blocked.content[0]!.text).toContain("needs a person to approve it");
  expect(command).not.toHaveBeenCalled();

  // The dashboard shows the request with the secret redacted, and decides it.
  const listed = await (await approvalRoutes(
    new Request("http://x/api/approvals"),
    new URL("http://x/api/approvals"),
  ))!.json();
  expect(listed.requests).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain("hunter2");
  const decide = (body: unknown, origin?: string) =>
    approvalRoutes(
      new Request("http://x/api/approvals/decide", {
        method: "POST",
        headers: origin ? { origin } : {},
        body: JSON.stringify(body),
      }),
      new URL("http://x/api/approvals/decide"),
    );
  // Another site cannot approve for the operator.
  expect(
    (await decide({ id: listed.requests[0].id, approve: true }, "http://evil.example"))!.status,
  ).toBe(403);
  expect((await decide({ id: "apr_missing", approve: true }))!.status).toBe(409);
  expect((await decide({ id: listed.requests[0].id, approve: true }))!.status).toBe(200);

  const ran = await tools.remove_x!({ name: "r1", password: "hunter2" });
  expect(ran.isError).toBeUndefined();
  expect(command).toHaveBeenCalledTimes(1);

  // Off (the default): nothing waits.
  resetApprovals();
  command.mockClear();
  const open = register({ enabled: false });
  await open.remove_x!({ name: "r1" });
  expect(command).toHaveBeenCalledTimes(1);
});
