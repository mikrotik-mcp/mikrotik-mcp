import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Cmd, looksLikeError } from "../core/routeros";
import { createContext } from "../core/context";
import type { ToolContext } from "../core/context";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { executeMikrotikCommand } from "../core/connector";
import { rows, checkedRead } from "../home/read";
import { captureSnapshot } from "../snapshots/capture";
import { getSafeModeManager } from "../ssh/safe-mode";
import { addressAllowed } from "../service-contracts/model";
import { nativeProbeIO } from "../service-contracts/probe";
import { operationsStore } from "../operations/store";
import {
  routingInput,
  planCommands,
  fingerprint,
  ownerTag,
  routingPath,
  enabled,
  chooseExit,
} from "./model";
import type { RoutingPolicy, RoutingFacts, PathSample } from "./model";

const kind = "service-routing";
function access(ctx: ToolContext, tool: string, write = false): string {
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], tool, write ? "WRITE" : "READ");
  return device;
}
async function locked<T>(device: string, work: () => Promise<T>): Promise<T> {
  const store = await operationsStore(),
    owner = randomUUID();
  store.lock(device, owner);
  try {
    return await work();
  } finally {
    store.unlock(device, owner);
  }
}
export async function routingPolicy(id: string, device: string): Promise<RoutingPolicy> {
  const policy = (await operationsStore()).get<RoutingPolicy>(kind, id, device);
  if (!policy) throw new Error("Policy not found on the selected router.");
  return policy;
}
function save(policy: RoutingPolicy, message?: string): Promise<void> {
  policy.updatedAt = Date.now();
  if (message)
    policy.history = [{ at: policy.updatedAt, message }, ...policy.history].slice(0, 100);
  return operationsStore().then((store) => store.put(kind, policy));
}
export async function routingInventory(ctx: ToolContext) {
  access(ctx, "service_routing_inventory");
  const tables = await rows("/routing table", "name,fib,disabled", ctx);
  return {
    tables: tables.filter((r) => enabled(r) && ["yes", "true"].includes(r.fib)).map((r) => r.name),
    targets: Object.entries(getConfig().serviceProbes.targets)
      .filter(([, t]) => t.kind === "https")
      .map(([alias, t]) => ({ alias, host: t.host })),
  };
}
export async function listRouting(ctx: ToolContext) {
  const device = access(ctx, "list_service_routing");
  return { policies: (await operationsStore()).list<RoutingPolicy>(kind, device) };
}
export async function createRouting(input: unknown, ctx: ToolContext) {
  const device = access(ctx, "create_service_routing", true),
    a = routingInput.parse(input);
  const target = getConfig().serviceProbes.targets[a.target];
  if (!target || target.kind !== "https")
    throw new Error("Select an administrator-approved HTTPS probe alias first.");
  const store = await operationsStore();
  if (store.list(kind, device).length >= 100) throw new Error("Router policy limit reached (100).");
  const policy: RoutingPolicy = {
    ...a,
    id: randomUUID(),
    device,
    host: target.host,
    updatedAt: Date.now(),
    state: "draft",
    samples: [],
    history: [],
  };
  await save(policy, "Draft saved. No router changes or probes yet.");
  return policy;
}
async function facts(policy: RoutingPolicy, ctx: ToolContext): Promise<RoutingFacts> {
  const base = routingPath(policy.family);
  // Sequential bounded reads avoid occupying the entire shared SSH pool.
  const tables = await rows("/routing table", "name,fib,disabled", ctx);
  const routes = await rows(
    policy.family === "ipv4" ? "/ip route" : "/ipv6 route",
    "routing-table,dst-address,gateway,active,disabled",
    ctx,
  );
  const mangle = await rows(
    `${base} mangle`,
    "chain,action,new-routing-mark,jump-target,src-address-list,dst-address-list,dst-address-type,dst-address,passthrough,disabled,comment",
    ctx,
  );
  const filters = await rows(`${base} filter`, "action,disabled", ctx);
  if (policy.family === "ipv4") {
    const active = (
      await checkedRead("/ip firewall connection print count-only where fasttrack=yes", ctx)
    ).trim();
    if (!/^\d+$/.test(active) || Number(active) > 0)
      throw new Error("Active FastTrack connections must drain before routing can be changed.");
  }
  const vrfs = await rows("/ip vrf", "name,interfaces,disabled", ctx);
  const addresses = await rows(
    `${base} address-list`,
    "list,address,comment,dynamic,disabled",
    ctx,
  );
  return { tables, routes, mangle, filters, vrfs, addresses };
}
export function fetchCommand(
  address: string,
  table: string,
  host: string,
  path: string,
  port: number,
): string {
  return `:put [:serialize to=json value=[${new Cmd("/tool fetch").set("address", `${address}@${table}`).set("host", host).set("mode", "https").set("src-path", path).set("port", port).set("http-method", "head").set("check-certificate", "yes").set("http-max-redirect-count", 0).set("idle-timeout", "5s").set("output", "none").flag("as-value", true).build()}]]`;
}
async function probe(policy: RoutingPolicy, ctx: ToolContext): Promise<void> {
  const target = getConfig().serviceProbes.targets[policy.target];
  if (!target || target.kind !== "https" || target.host !== policy.host)
    throw new Error("Probe approval changed. Create a new policy.");
  const vrfs = await rows("/ip vrf", "name,disabled", ctx);
  let addresses: string[] = [];
  try {
    addresses = await nativeProbeIO.resolve(target.host, 3000);
    if (addresses.some((a) => !addressAllowed(a, target.addresses))) addresses = [];
  } catch {
    /* Explicit unknown below. */
  }
  const address = addresses.find((a) => isIP(a) === (policy.family === "ipv4" ? 4 : 6));
  for (const table of policy.tables) {
    const sample: PathSample = {
      table,
      at: Date.now(),
      state: "unknown",
      detail: "No approved DNS answer for this IP family.",
    };
    if (address) {
      sample.address = address;
      sample.detail =
        "This routing table is not a VRF. A table-only HTTPS path cannot be proved by fetch.";
      if (vrfs.some((v) => v.name === table && enabled(v))) {
        const start = Date.now();
        try {
          const raw = await executeMikrotikCommand(
            fetchCommand(address, table, target.host, target.path, target.port),
            ctx,
            { maxMs: 8000 },
          );
          sample.elapsedMs = Date.now() - start;
          if (looksLikeError(raw)) {
            // Parser/transport errors do not establish failure of the service itself.
            if (/failure:.*(?:fetch|SSL|connection|timeout|resolving|status)/i.test(raw)) {
              sample.state = "fail";
              sample.detail = "Router fetch reported an HTTP, TLS or connection failure.";
            } else
              sample.detail = "Router fetch was rejected or unsupported; path health is unknown.";
          } else {
            const result = JSON.parse(raw.trim()) as { status?: string; code?: number };
            if (
              result.status === "finished" &&
              (result.code === undefined ||
                (Number(result.code) >= 200 && Number(result.code) < 300))
            ) {
              sample.state = sample.elapsedMs <= policy.maxLatencyMs ? "pass" : "fail";
              sample.detail = `HTTPS HEAD completed via VRF ${table}; elapsed includes SSH overhead. Not a client-path or throughput test.`;
            }
          }
        } catch {
          sample.detail =
            "Router query did not produce verified fetch evidence. Connection or capability may be unavailable.";
        }
      }
    }
    policy.samples.push(sample);
  }
  policy.samples = policy.samples.slice(-180);
  await save(policy);
}
export async function probeRouting(id: string, ctx: ToolContext) {
  const device = access(ctx, "probe_service_routing");
  return locked(device, async () => {
    const policy = await routingPolicy(id, device);
    await probe(policy, ctx);
    return policy;
  });
}
async function preview(policy: RoutingPolicy, table: string, remove: boolean, ctx: ToolContext) {
  const snapshot = await facts(policy, ctx);
  policy.plan = {
    id: randomUUID(),
    table,
    remove,
    expiresAt: Date.now() + 120_000,
    fingerprint: fingerprint(snapshot),
    commands: planCommands(policy, table, snapshot, remove),
  };
  await save(policy, "Preview created. Review scope and commands; valid for two minutes.");
  return policy;
}
export async function previewRouting(id: string, table: string, remove: boolean, ctx: ToolContext) {
  const device = access(ctx, "preview_service_routing");
  return locked(device, async () => preview(await routingPolicy(id, device), table, remove, ctx));
}
async function apply(policy: RoutingPolicy, planId: string, ctx: ToolContext) {
  const plan = policy.plan;
  if (!plan || plan.id !== planId || plan.expiresAt < Date.now())
    throw new Error("Preview expired or changed. Preview again before confirming.");
  access(ctx, "apply_service_routing", true);
  if (fingerprint(await facts(policy, ctx)) !== plan.fingerprint)
    throw new Error("Router configuration changed after preview.");
  const safe = getSafeModeManager(policy.device);
  if (safe.isActive) throw new Error("Finish the existing Safe Mode session first.");
  policy.snapshot = await captureSnapshot(ctx, `Before service route ${policy.name}`, true);
  policy.state = "uncertain";
  policy.armedUntil = undefined;
  await save(policy, "Apply started; outcome must be read back before being considered active.");
  let owned = false,
    commitAttempted = false;
  try {
    if (!(await safe.enable()).startsWith("Safe mode ENABLED"))
      throw new Error("Could not acquire Safe Mode.");
    owned = true;
    if (fingerprint(await facts(policy, ctx)) !== plan.fingerprint)
      throw new Error("Router changed while entering Safe Mode.");
    for (const command of plan.commands) await checkedRead(command, ctx);
    const after = await facts(policy, ctx);
    const matched = after.mangle.filter((r) => r.comment === ownerTag(policy.id));
    if (
      plan.remove
        ? matched.length !== 0
        : matched.filter(
            (r) =>
              r.action === "mark-routing" && r["new-routing-mark"] === plan.table && enabled(r),
          ).length !== 1
    )
      throw new Error("Router read-back did not match this preview.");
    if (plan.remove) {
      if (after.addresses.some((r) => r.comment === ownerTag(policy.id)))
        throw new Error("Owned address-list removal not confirmed.");
    } else {
      planCommands({ ...policy, state: "active", activeTable: plan.table }, plan.table, after);
    }
    await checkedRead("/system identity print", ctx);
    commitAttempted = true;
    if (!(await safe.commit()).ok)
      throw new Error("Commit outcome uncertain. Do not replay the change.");
    owned = false;
    policy.state = plan.remove ? "removed" : "active";
    policy.activeTable = plan.remove ? undefined : plan.table;
    policy.lastSwitchAt = Date.now();
    policy.plan = undefined;
    policy.error = undefined;
    await save(
      policy,
      plan.remove
        ? "Owned routing policy removed."
        : `Routing read-back verified: ${plan.table}. Client delivery still requires a client check.`,
    );
  } catch (error) {
    if (owned && !commitAttempted) await safe.rollback().catch(() => {});
    policy.error = error instanceof Error ? error.message : "Apply failed";
    await save(
      policy,
      "Apply not confirmed; automation stopped. Inspect the saved backup and router state.",
    );
    throw error;
  }
  return policy;
}
export async function applyRouting(id: string, planId: string, confirm: boolean, ctx: ToolContext) {
  const device = access(ctx, "apply_service_routing", true);
  if (!confirm) throw new Error("Explicit confirmation of the exact preview is required.");
  return locked(device, async () => apply(await routingPolicy(id, device), planId, ctx));
}
export async function armRouting(id: string, minutes: number, confirm: boolean, ctx: ToolContext) {
  const device = access(ctx, "arm_service_routing", true);
  if (!confirm) throw new Error("Confirm the time-limited automatic failover authorization.");
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60)
    throw new Error("Authorization must be 0–60 minutes.");
  return locked(device, async () => {
    const policy = await routingPolicy(id, device);
    if (minutes) {
      const other = (await operationsStore())
        .list<RoutingPolicy>(kind, device)
        .some((p) => p.id !== id && (p.armedUntil ?? 0) > Date.now());
      if (other)
        throw new Error("Only one automatic service policy per router can be armed at a time.");
      if (policy.state !== "active" || policy.tables.length < 2)
        throw new Error("Apply a policy with at least two exits first.");
      const now = Date.now();
      if (
        policy.tables.some(
          (t) =>
            !policy.samples.some(
              (s) => s.table === t && s.state === "pass" && now - s.at < 120_000,
            ),
        )
      )
        throw new Error("Every authorized exit needs a fresh passing VRF probe before arming.");
    }
    policy.armedUntil = minutes ? Date.now() + minutes * 60_000 : undefined;
    await save(
      policy,
      minutes
        ? `Automatic failover authorized for ${minutes} minutes, only between the saved exits.`
        : "Automatic failover paused; the current route stays in place.",
    );
    return policy;
  });
}
let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
export function startRoutingMonitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    void routingTick().catch(() => {});
  }, 30_000);
  timer.unref();
}
export function stopRoutingMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
export async function routingTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const store = await operationsStore();
    for (const device of Object.keys(getConfig().devices)) {
      for (const saved of store
        .list<RoutingPolicy>(kind, device)
        .filter((p) => (p.armedUntil ?? 0) > Date.now())) {
        try {
          const ctx = createContext(undefined, device);
          access(ctx, "arm_service_routing", true);
          access(ctx, "probe_service_routing");
          access(ctx, "apply_service_routing", true);
          await locked(device, async () => {
            const policy = await routingPolicy(saved.id, device),
              until = policy.armedUntil;
            if ((until ?? 0) <= Date.now()) return;
            await probe(policy, ctx);
            const next = chooseExit(policy, Date.now());
            if (!next) return;
            await preview(policy, next, false, ctx);
            if ((until ?? 0) <= Date.now()) return;
            await apply(policy, policy.plan!.id, ctx);
            policy.armedUntil = until;
            await save(policy, "Automatic failover completed within the saved authorization.");
          });
        } catch {
          /* Recorded apply uncertainty stops automation; polling must not crash the host. */
        }
      }
    }
  } finally {
    ticking = false;
  }
}
