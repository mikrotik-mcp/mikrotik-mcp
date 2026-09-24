import { createHash, randomUUID } from "node:crypto";
import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { Cmd, quoteValue } from "../core/routeros";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { parseKeyValues } from "../core/routeros-parse";
import { getSafeModeManager } from "../ssh/safe-mode";
import { captureSnapshot } from "../snapshots/capture";
import { isYes } from "../utils/yes";
import { policyInput, enabled, activeRoute, temporaryCommands, tagSelector } from "./model";
import type { PolicyPlan, PolicyInput, Row } from "./model";
import { checkedRead, rows } from "./read";
import type { Reader } from "./read";
import { homeStore } from "./store";

export interface PolicyFacts {
  leases: Row[];
  filters: Row[];
  connections: Row[];
  mangle: Row[];
  queues: Row[];
  tables: Row[];
  routes: Row[];
  addresses: Row[];
  ipv6: Row;
  deviceMode: Row;
}
/** Refuse to invent a QoS hierarchy, bypass FastTrack, or silently change IPv6/global routing. */
export function buildPolicy(id: string, input: PolicyInput, facts: PolicyFacts) {
  input = { ...input, mac: input.mac.toUpperCase() };
  if (!isYes(facts.deviceMode.scheduler))
    throw new Error(
      "Router device-mode must explicitly allow scheduler execution for automatic expiry.",
    );
  const candidates = facts.leases.filter((l) => l["mac-address"]?.toUpperCase() === input.mac);
  const lease = candidates[0];
  if (
    candidates.length !== 1 ||
    !lease ||
    isYes(lease.dynamic) ||
    /D/.test(lease.flags ?? "") ||
    !enabled(lease) ||
    lease.status !== "bound" ||
    !lease.address
  )
    throw new Error(
      "This control requires exactly one bound, static DHCP lease. Pin the client's IP in Clients first.",
    );
  if (
    facts.leases.some(
      (l) => l !== lease && (l.address === lease.address || l["active-address"] === lease.address),
    )
  )
    throw new Error("The client IP is ambiguous.");
  if (lease["active-address"] && lease["active-address"] !== lease.address)
    throw new Error("The client lease changed; reconnect it before continuing.");
  if (lease["active-mac-address"] && lease["active-mac-address"].toUpperCase() !== input.mac)
    throw new Error("The active client MAC does not match its reservation.");
  if (facts.addresses.some((r) => r.address?.split("/")[0] === lease.address))
    throw new Error("Cannot target a router address.");
  if (
    facts.filters.some((r) => enabled(r) && r.action === "fasttrack-connection") ||
    facts.connections.some((r) => isYes(r.fasttrack) || /F/.test(r.flags ?? ""))
  )
    throw new Error(
      "FastTrack is configured or still active. These controls cannot guarantee enforcement. Ask the administrator to design a per-client FastTrack exclusion first.",
    );
  if (
    input.action === "pause" &&
    !isYes(facts.ipv6["disable-ipv6"]) &&
    facts.ipv6.forward !== "no" &&
    facts.ipv6.forward !== "false"
  )
    throw new Error(
      "IPv6 forwarding is enabled or unknown. An IPv4-only pause could be bypassed; use a dual-stack policy instead.",
    );
  const tag = `mcp-home-${id}`,
    ip = lease.address;
  const setup: string[] = [],
    activate: string[] = [],
    revert: string[] = [];
  let queueBefore: PolicyPlan["queueBefore"];
  const warnings = [
    "Only this reserved IPv4 client is targeted. Other configuration is left in place.",
    "The router expires this policy even when the dashboard is closed. Scheduler cleanup can take up to 30 seconds. Reboot ends the policy.",
    "Existing connections may disconnect. Review before applying; this is not a speed guarantee.",
  ];
  const manage = (path: string) => {
    activate.push(new Cmd(`${path} enable ${tagSelector(tag)}`).build());
    revert.push(new Cmd(`${path} remove ${tagSelector(tag)}`).build());
  };
  if (input.action === "pause") {
    for (const direction of ["src", "dst"])
      setup.push(
        new Cmd("/ip firewall filter add")
          .set("chain", "forward")
          .set(`${direction}-address-list`, `${tag}-end`)
          .set("action", "drop")
          .set("comment", tag)
          .bool("disabled", true)
          .raw(facts.filters.length ? "place-before=0" : "")
          .build(),
      );
    manage("/ip firewall filter");
    warnings.push(
      "Pauses all routed traffic for this IP, including routed LAN traffic; router management and same-bridge traffic are not blocked.",
    );
  } else if (input.action === "route") {
    if (
      !input.table ||
      !facts.tables.some((t) => t.name === input.table && isYes(t.fib) && enabled(t)) ||
      !facts.routes.some(
        (r) =>
          r["routing-table"] === input.table && r["dst-address"] === "0.0.0.0/0" && activeRoute(r),
      )
    )
      throw new Error(
        "Select an enabled FIB table with an active default route. This feature does not create WANs or VPNs.",
      );
    if (facts.mangle.some((r) => enabled(r) && r.action === "mark-routing"))
      throw new Error(
        "Existing routing marks require an administrator review; this control will not override them.",
      );
    const exclusions = new Set([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "224.0.0.0/4",
      "255.255.255.255",
    ]);
    for (const a of facts.addresses) if (a.address) exclusions.add(a.address);
    for (const prefix of exclusions)
      setup.push(
        new Cmd("/ip firewall address-list add")
          .set("list", `${tag}-local`)
          .set("address", prefix)
          .set("comment", tag)
          .build(),
      );
    setup.push(
      new Cmd("/ip firewall mangle add")
        .set("chain", "prerouting")
        .set("src-address-list", `${tag}-end`)
        .set("src-mac-address", input.mac)
        .set("dst-address-type", "!local")
        .set("dst-address-list", `!${tag}-local`)
        .set("action", "mark-routing")
        .set("new-routing-mark", input.table)
        .bool("passthrough", false)
        .bool("disabled", true)
        .set("comment", tag)
        .raw(facts.mangle.length ? "place-before=0" : "")
        .build(),
    );
    manage("/ip firewall mangle");
    warnings.push(
      "IPv6 remains on its existing path. Private/local destinations are excluded. NAT, return routing and actual client delivery must already work for this table; no WAN/VPN/NAT is created.",
    );
  } else {
    const queues = facts.queues.filter((q) => q.target === `${ip}/32` && enabled(q));
    const q = queues[0],
      parent = facts.queues.find((r) => r.name === q?.parent && enabled(r));
    if (
      queues.length !== 1 ||
      !q?.name ||
      !parent ||
      !parent["max-limit"]?.split("/").every((r) => Number.parseFloat(r) > 0) ||
      !q["max-limit"]?.split("/").every((r) => Number.parseFloat(r) > 0) ||
      q["packet-marks"] ||
      !/^[1-8]\/[1-8]$/.test(q.priority ?? "")
    )
      throw new Error(
        "Meeting priority needs one existing /32 child simple queue with finite parent/child bandwidth and no packet marks. Configure QoS capacity first; this control never guesses line speed.",
      );
    if (facts.queues.some((r) => r.parent === q.name))
      throw new Error("Only leaf queues can receive meeting priority.");
    if (q.priority === "1/1")
      throw new Error("This client already has the highest queue priority.");
    queueBefore = { name: q.name, target: q.target, parent: q.parent, priority: q.priority };
    const selector = `[find where name=${quoteValue(q.name)} target=[:tostr ${quoteValue(q.target)}] parent=${quoteValue(q.parent)} priority=${quoteValue(q.priority)}]`;
    activate.push(new Cmd(`/queue simple set ${selector}`).set("priority", "1/1").build());
    const restoreSelector = `[find where name=${quoteValue(q.name)} target=[:tostr ${quoteValue(q.target)}] parent=${quoteValue(q.parent)} priority="1/1"]`;
    revert.push(
      new Cmd(`/queue simple set ${restoreSelector}`).set("priority", q.priority).build(),
    );
    warnings.push(
      "Priority applies to all IPv4 traffic of this device within its existing queue hierarchy, not just a meeting app. Externally changed queue settings are not overwritten during restoration.",
    );
  }
  const generated = temporaryCommands(id, input, ip, setup, activate, revert);
  if (generated.commands.length > 40)
    throw new Error(
      "This router needs too many policy objects for a bounded Safe Mode change. Ask an administrator to review it.",
    );
  // Remove transient row indices/counters before binding consent to the current configuration.
  const stable = JSON.stringify(facts, (key, value) => (key === "#" ? undefined : value));
  return {
    ip,
    ...generated,
    warnings,
    queueBefore,
    fingerprint: createHash("sha256").update(stable).digest("hex"),
  };
}

export async function policyFacts(
  ctx: ToolContext,
  read: Reader = executeMikrotikCommand,
): Promise<PolicyFacts> {
  const fasttrackCount = (
    await checkedRead("/ip firewall connection print count-only where fasttrack=yes", ctx, read)
  ).trim();
  if (!/^\d+$/.test(fasttrackCount))
    throw new Error("Cannot establish whether FastTrack connections remain active.");
  // Sequential bounded reads avoid opening a burst of SSH channels on small routers.
  return {
    leases: await rows(
      "/ip dhcp-server lease",
      "address,active-address,mac-address,active-mac-address,dynamic,disabled,status",
      ctx,
      read,
    ),
    filters: await rows("/ip firewall filter", "chain,action,disabled,comment", ctx, read),
    connections: Number(fasttrackCount) > 0 ? [{ fasttrack: "yes" }] : [],
    mangle: await rows("/ip firewall mangle", "chain,action,disabled,comment", ctx, read),
    queues: await rows(
      "/queue simple",
      "name,target,parent,priority,max-limit,packet-marks,disabled",
      ctx,
      read,
    ),
    tables: await rows("/routing table", "name,fib,disabled", ctx, read),
    routes: await rows("/ip route", "dst-address,routing-table,active,disabled,gateway", ctx, read),
    addresses: await rows("/ip address", "address,interface", ctx, read),
    ipv6: parseKeyValues(await checkedRead("/ipv6 settings print", ctx, read)),
    deviceMode: parseKeyValues(await checkedRead("/system device-mode print", ctx, read)),
  };
}
const busy = new Set<string>();
async function exclusive<T>(device: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(device))
    throw new Error("Another Home Internet operation is in progress for this router.");
  busy.add(device);
  try {
    return await work();
  } finally {
    busy.delete(device);
  }
}
export async function previewPolicy(input: unknown, ctx: ToolContext): Promise<PolicyPlan> {
  const a = policyInput.parse(input),
    device = resolveDeviceName(ctx.device);
  a.mac = a.mac.toUpperCase();
  assertDeviceAccess([device], "preview_home_policy", "WRITE");
  return exclusive(device, async () => {
    const id = randomUUID();
    const plan: PolicyPlan = {
      id,
      device,
      input: a,
      createdAt: Date.now(),
      previewExpiresAt: Date.now() + 300_000,
      status: "preview",
      ...buildPolicy(id, a, await policyFacts(ctx)),
    };
    (await homeStore()).savePlan(plan);
    return plan;
  });
}

/** A preview token is one-use, device-bound and revalidated immediately before a Safe Mode write. */
export async function applyPolicy(
  id: string,
  confirm: boolean,
  ctx: ToolContext,
): Promise<PolicyPlan> {
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], "apply_home_policy", "WRITE");
  if (!confirm) throw new Error("Review the preview and explicitly confirm before applying.");
  return exclusive(device, async () => {
    const store = await homeStore(),
      plan = store.plan(id, device);
    if (!plan || plan.status !== "preview" || plan.previewExpiresAt < Date.now())
      throw new Error("Preview expired, already used, or belongs to another router.");
    if (
      store
        .unresolved(device)
        .some(
          (p) =>
            p.input.mac === plan.input.mac &&
            ["applying", "scheduled", "active", "uncertain"].includes(p.status),
        )
    )
      throw new Error("Undo or reconcile the previous policy for this device first.");
    const fresh = buildPolicy(id, plan.input, await policyFacts(ctx));
    if (fresh.fingerprint !== plan.fingerprint)
      throw new Error("Router state changed after the preview. Create a fresh preview.");
    const safe = getSafeModeManager(device);
    if (safe.isActive)
      throw new Error(
        "An existing Safe Mode session is active; finish it before applying a Home Internet policy.",
      );
    plan.snapshot = await captureSnapshot(ctx, `Before Home Internet ${plan.input.action}`, true);
    plan.status = "applying";
    store.claim(plan); // Atomic, cross-process claim before I/O; no automatic retry of ambiguous writes.
    let owned = false;
    try {
      const status = await safe.enable();
      if (!status.startsWith("Safe mode ENABLED"))
        throw new Error("Could not acquire a new Safe Mode session.");
      owned = true;
      const lockedFacts = await policyFacts(ctx);
      if (buildPolicy(id, plan.input, lockedFacts).fingerprint !== plan.fingerprint)
        throw new Error("Configuration changed while acquiring Safe Mode; create a new preview.");
      const started = Date.now();
      for (const command of plan.commands) {
        if (Date.now() - started > 120_000)
          throw new Error("Policy apply exceeded its time budget.");
        await checkedRead(command, ctx);
      }
      const tag = `mcp-home-${id}`;
      const count = (
        await checkedRead(
          new Cmd("/system scheduler print count-only")
            .raw(`where comment=${quoteValue(tag)}`)
            .build(),
          ctx,
        )
      ).trim();
      if (count !== "2") throw new Error("Router-side expiry could not be verified.");
      const parsed = (
        await checkedRead(
          `:put [:typeof [:parse [/system scheduler get [find where name=${quoteValue(tag)}] on-event]]]`,
          ctx,
        )
      ).trim();
      if (parsed !== "code") throw new Error("Router could not compile the expiry script.");
      await verifyPolicyObjects(plan, lockedFacts, ctx);
      await checkedRead("/system identity print", ctx);
      const outcome = await safe.commit();
      if (!outcome.ok)
        throw new Error("Commit outcome is uncertain; inspect the router before retrying.");
      owned = false;
      plan.startsAt = started + plan.input.startInMinutes * 60_000;
      plan.endsAt = plan.startsAt + plan.input.minutes * 60_000;
      plan.status = plan.input.startInMinutes ? "scheduled" : "active";
      store.savePlan(plan);
      return plan;
    } catch (error) {
      if (owned) await safe.rollback().catch(() => {});
      plan.status = "uncertain";
      plan.error = error instanceof Error ? error.message : "Policy operation failed";
      store.savePlan(plan);
      throw new Error(
        `Policy not confirmed: ${plan.error}. Inspect/undo policy ${id}; do not blindly retry.`,
      );
    }
  });
}
export async function undoPolicy(
  id: string,
  confirm: boolean,
  ctx: ToolContext,
): Promise<PolicyPlan> {
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], "undo_home_policy", "WRITE");
  if (!confirm) throw new Error("Explicit confirmation is required to undo a policy.");
  return exclusive(device, async () => {
    const store = await homeStore(),
      plan = store.plan(id, device);
    if (!plan || plan.status === "preview") throw new Error("No applied policy on this router.");
    if (plan.status === "undone") return plan;
    const safe = getSafeModeManager(device);
    if (safe.isActive) throw new Error("Finish the active Safe Mode session first.");
    const status = await safe.enable();
    if (!status.startsWith("Safe mode ENABLED")) throw new Error("Could not acquire Safe Mode.");
    try {
      // Disable the scheduler before removing its objects, preventing a concurrent activation.
      await checkedRead(
        new Cmd(`/system scheduler disable ${tagSelector(`mcp-home-${id}`)}`).build(),
        ctx,
      );
      for (const cmd of plan.undo) await checkedRead(cmd, ctx);
      if (plan.input.action === "priority") {
        const expected = plan.queueBefore;
        if (!expected)
          throw new Error("Missing queue restoration evidence; reconcile this policy manually.");
        const current = await rows("/queue simple", "name,target,parent,priority", ctx);
        const matching = current.filter(
          (q) =>
            q.name === expected.name &&
            q.target === expected.target &&
            q.parent === expected.parent,
        );
        if (matching.length !== 1 || matching[0].priority !== expected.priority)
          throw new Error(
            "Queue restoration was not verified. External queue changes require manual reconciliation.",
          );
      }
      for (const path of [
        "/system scheduler",
        "/ip firewall address-list",
        "/ip firewall filter",
        "/ip firewall mangle",
      ]) {
        const remaining = (
          await checkedRead(
            new Cmd(`${path} print count-only`)
              .raw(`where comment=${quoteValue(`mcp-home-${id}`)}`)
              .build(),
            ctx,
          )
        ).trim();
        if (remaining !== "0")
          throw new Error("Policy cleanup could not be verified; the undo was not committed.");
      }
      const committed = await safe.commit();
      if (!committed.ok) throw new Error("Undo commit could not be confirmed");
      plan.status = "undone";
      store.savePlan(plan);
      return plan;
    } catch (e) {
      await safe.rollback().catch(() => {});
      throw e;
    }
  });
}

/** Read back the enforcing objects, not only the timer that should remove them. */
async function verifyPolicyObjects(
  plan: PolicyPlan,
  before: PolicyFacts,
  ctx: ToolContext,
): Promise<void> {
  const tag = `mcp-home-${plan.id}`;
  const marker = (
    await checkedRead(
      new Cmd("/ip firewall address-list print count-only")
        .raw(`where list=${quoteValue(`${tag}-end`)}`)
        .build(),
      ctx,
    )
  ).trim();
  if (marker !== "1") throw new Error("Expiry marker could not be verified.");
  if (plan.input.action === "priority") {
    const old = before.queues.find((q) => q.target === `${plan.ip}/32` && enabled(q))!;
    const current = await rows(
      "/queue simple",
      "name,target,parent,priority,max-limit,disabled",
      ctx,
    );
    const q = current.find(
      (r) => r.name === old.name && r.target === old.target && r.parent === old.parent,
    );
    if (!q || q.priority !== (plan.input.startInMinutes ? old.priority : "1/1"))
      throw new Error("Meeting queue priority was not verified.");
  } else {
    const path = plan.input.action === "pause" ? "/ip firewall filter" : "/ip firewall mangle";
    const current = await rows(
      path,
      "comment,disabled,action,chain,src-address-list,dst-address-list,new-routing-mark,src-mac-address,dst-address-type",
      ctx,
    );
    const owned = current.filter((r) => r.comment === tag);
    if (
      owned.length !== (plan.input.action === "pause" ? 2 : 1) ||
      owned.some((r) => enabled(r) === plan.input.startInMinutes > 0)
    )
      throw new Error("Policy rules were not verified in their expected state.");
    if (plan.input.action === "pause") {
      if (
        owned.some((r) => r.chain !== "forward" || r.action !== "drop") ||
        owned.filter((r) => r["src-address-list"] === `${tag}-end`).length !== 1 ||
        owned.filter((r) => r["dst-address-list"] === `${tag}-end`).length !== 1
      )
        throw new Error("Pause rule targeting could not be verified.");
    } else if (
      owned.some(
        (r) =>
          r.chain !== "prerouting" ||
          r.action !== "mark-routing" ||
          r["src-address-list"] !== `${tag}-end` ||
          r["src-mac-address"]?.toUpperCase() !== plan.input.mac ||
          r["new-routing-mark"] !== plan.input.table ||
          r["dst-address-type"] !== "!local" ||
          r["dst-address-list"] !== `!${tag}-local`,
      )
    ) {
      throw new Error("Path selection targeting could not be verified.");
    }
  }
}
