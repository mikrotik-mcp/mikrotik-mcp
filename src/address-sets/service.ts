import { createHash, randomUUID } from "node:crypto";
import type { ToolContext } from "../core/context";
import { Cmd } from "../core/routeros";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { checkedRead } from "../home/read";
import { operationsStore } from "../operations/store";
import { readRoutingRows } from "../service-routing/read";
import { captureSnapshot } from "../snapshots/capture";
import { getSafeModeManager } from "../ssh/safe-mode";
import { addressSetInput, composeAddressSet, combinePrefixes, referenceSchema } from "./model";
import type { AddressSetRevision, SetReference } from "./model";

const KIND = "address-set";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pathFor = (r: AddressSetRevision) =>
  r.input.family === "ipv4" ? "/ip firewall" : "/ipv6 firewall";
function access(ctx: ToolContext, tool: string, write = false) {
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], tool, write ? "WRITE" : "READ");
  return device;
}
async function revision(id: string, device: string) {
  const r = (await operationsStore()).get<AddressSetRevision>(KIND, id, device);
  if (!r) throw new Error("Address-set revision not found on this device.");
  return r;
}
async function save(r: AddressSetRevision) {
  r.updatedAt = Date.now();
  (await operationsStore()).put(KIND, r);
  return r;
}
export async function listAddressSets(ctx: ToolContext) {
  const device = access(ctx, "list_address_sets");
  return { revisions: (await operationsStore()).list<AddressSetRevision>(KIND, device) };
}
export async function createAddressSet(input: unknown, ctx: ToolContext) {
  const device = access(ctx, "create_address_set", true);
  const a = addressSetInput.parse(input),
    composition = composeAddressSet(a);
  if (!composition.prefixes.length) throw new Error("An empty set cannot be saved or published.");
  let delta: AddressSetRevision["delta"];
  if (a.parent) {
    const parent = await revision(a.parent, device);
    if (parent.input.name !== a.name || parent.input.family !== a.family)
      throw new Error("Parent name/family differs; create a new set instead.");
    const added = combinePrefixes({
      ...a,
      operation: "difference",
      left: composition.prefixes,
      right: parent.prefixes,
    });
    const removed = combinePrefixes({
      ...a,
      operation: "difference",
      left: parent.prefixes,
      right: composition.prefixes,
    });
    delta = {
      added: added.prefixes,
      removed: removed.prefixes,
      addedAddresses: added.addresses,
      removedAddresses: removed.addresses,
      large:
        BigInt(added.addresses) * 2n > BigInt(parent.addresses) ||
        BigInt(removed.addresses) * 2n > BigInt(parent.addresses),
    };
  }
  const id = randomUUID();
  return save({
    id,
    device,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    input: a,
    ...composition,
    list: `mcp-as-${id}`,
    state: "draft",
    delta,
  });
}

async function facts(r: AddressSetRevision, refs: SetReference[], ctx: ToolContext) {
  const rules = [];
  for (const table of new Set(refs.map((ref) => ref.table))) {
    const rows = await readRoutingRows(`${pathFor(r)} ${table}`, undefined, ctx);
    for (const ref of refs.filter((item) => item.table === table)) {
      const rule = rows.find((row) => row[".id"] === ref.id);
      if (!rule) throw new Error(`Rule ${table} ${ref.id} no longer exists.`);
      const { "#": _position, ...stable } = rule;
      rules.push({ reference: ref, rule: stable });
    }
  }
  const entries = await readRoutingRows(`${pathFor(r)} address-list`, undefined, ctx, [r.list]);
  const names = [...new Set(refs.map((ref) => ref.expected.replace(/^!/, "")))];
  const originals = await readRoutingRows(`${pathFor(r)} address-list`, undefined, ctx, names);
  if (names.some((name) => !originals.some((entry) => entry.list === name)))
    throw new Error("An original list is empty or missing; refusing an unsafe reference change.");
  if (
    originals.some(
      (entry) =>
        ["yes", "true"].includes(entry.dynamic) || (entry.timeout && entry.timeout !== "0s"),
    )
  )
    throw new Error("Dynamic original lists cannot be safely versioned by this workflow.");
  return { rules, entries, originals: originals.map(({ "#": _position, ...entry }) => entry) };
}
function targetList(r: AddressSetRevision, ref: SetReference, rollback: boolean) {
  return rollback ? ref.expected : `${ref.expected.startsWith("!") ? "!" : ""}${r.list}`;
}
export function addressSetCommands(
  r: AddressSetRevision,
  refs: SetReference[],
  rollback: boolean,
): string[] {
  const path = pathFor(r);
  const commands = rollback
    ? []
    : r.prefixes.map((address) =>
        new Cmd(`${path} address-list add`)
          .set("list", r.list)
          .set("address", address)
          .set("comment", `mcp-address-set:${r.id}`)
          .build(),
      );
  for (const ref of refs)
    commands.push(
      new Cmd(`${path} ${ref.table} set`)
        .raw(ref.id)
        .set(ref.field, targetList(r, ref, rollback))
        .build(),
    );
  return commands;
}
function verifyEntries(r: AddressSetRevision, entries: Record<string, string>[]) {
  if (
    entries.length !== r.prefixes.length ||
    entries.some(
      (e) =>
        e.comment !== `mcp-address-set:${r.id}` ||
        ["yes", "true"].includes(e.disabled) ||
        ["yes", "true"].includes(e.dynamic) ||
        (e.timeout && e.timeout !== "0s"),
    )
  )
    throw new Error("Generation entries differ from the saved revision.");
  const actual = composeAddressSet({
    ...r.input,
    operation: "union",
    left: entries.map((e) => e.address),
    right: [],
  });
  if (actual.checksum !== r.checksum)
    throw new Error("Generation checksum does not match router read-back.");
}
export async function previewAddressSet(
  id: string,
  references: SetReference[],
  rollback: boolean,
  ctx: ToolContext,
  allowLargeChange = false,
) {
  const device = access(ctx, "preview_address_set");
  const r = await revision(id, device);
  if (
    !rollback &&
    !allowLargeChange &&
    (r.delta?.large || r.prefixes.some((p) => p.endsWith("/0")))
  )
    throw new Error(
      "Broad coverage change (>50% of parent or /0) requires explicit allowLargeChange acknowledgement.",
    );
  if (r.state !== (rollback ? "published" : "draft"))
    throw new Error(
      "Revision state does not permit this operation; uncertain writes require reconciliation.",
    );
  const refs = rollback
    ? (r.references ?? [])
    : referenceSchema.array().min(1).max(8).parse(references);
  if (
    !refs.length ||
    new Set(refs.map((v) => `${v.table}/${v.id}/${v.field}`)).size !== refs.length
  )
    throw new Error("Choose 1–8 unique rule references.");
  // RouterOS Safe Mode has a finite undo history; never silently exceed it.
  if (!rollback && r.prefixes.length > 64)
    throw new Error(
      "This release publishes at most 64 compacted prefixes plus 8 rule references per Safe Mode transaction. The saved composition remains available.",
    );
  const before = await facts(r, refs, ctx);
  for (const { reference, rule } of before.rules) {
    if (rule[reference.field] !== (rollback ? targetList(r, reference, false) : reference.expected))
      throw new Error("Rule reference differs from the expected list. Refresh and review again.");
  }
  if (rollback) {
    verifyEntries(r, before.entries);
    if (hash(before.originals) !== r.originalListsHash)
      throw new Error(
        "Original list contents changed since publication; automatic rollback refused.",
      );
  } else if (before.entries.length)
    throw new Error("Generation list already exists; refusing to adopt or overwrite it.");
  r.plan = {
    id: randomUUID(),
    expiresAt: Date.now() + 120_000,
    references: refs,
    fingerprint: hash(before),
    rollback,
    commands: addressSetCommands(r, refs, rollback),
  };
  return save(r);
}

export async function applyAddressSet(
  id: string,
  planId: string,
  confirm: boolean,
  ctx: ToolContext,
) {
  const device = access(ctx, "apply_address_set", true);
  if (!confirm) throw new Error("Explicit confirmation is required after reviewing the preview.");
  const store = await operationsStore(),
    owner = randomUUID();
  store.lock(device, owner);
  try {
    const r = await revision(id, device),
      plan = r.plan;
    if (!plan || plan.id !== planId || plan.expiresAt < Date.now())
      throw new Error("Preview expired or changed; preview again.");
    if (r.state !== (plan.rollback ? "published" : "draft"))
      throw new Error("Revision requires reconciliation before another write.");
    const safe = getSafeModeManager(device);
    if (getDevice(device).mac || safe.isActive)
      throw new Error("Requires SSH and no existing Safe Mode session.");
    const before = await facts(r, plan.references, ctx);
    if (hash(before) !== plan.fingerprint) throw new Error("Router changed after preview.");
    if (!plan.rollback) r.originalListsHash = hash(before.originals);
    r.snapshot = await captureSnapshot(ctx, `Before address set ${r.input.name}`, true);
    r.state = "uncertain";
    await save(r);
    let owned = false,
      commitAttempted = false;
    try {
      if (!(await safe.enable()).startsWith("Safe mode ENABLED"))
        throw new Error("Could not acquire Safe Mode.");
      owned = true;
      const started = Date.now();
      if (plan.expiresAt < started)
        throw new Error("Preview expired while capturing the backup; preview again.");
      if (hash(await facts(r, plan.references, ctx)) !== plan.fingerprint)
        throw new Error("Router changed while entering Safe Mode.");
      for (const [index, command] of plan.commands.entries()) {
        if (Date.now() - started > 120_000)
          throw new Error("Publication time budget exceeded; aborting.");
        if (!plan.rollback && index === r.prefixes.length)
          verifyEntries(r, (await facts(r, plan.references, ctx)).entries);
        await checkedRead(command, ctx);
      }
      const after = await facts(r, plan.references, ctx);
      verifyEntries(r, after.entries);
      if (
        after.rules.some(
          ({ reference, rule }) =>
            rule[reference.field] !== targetList(r, reference, plan.rollback),
        )
      )
        throw new Error("Rule read-back did not match the approved plan.");
      await checkedRead("/system identity print", ctx);
      commitAttempted = true;
      if (!(await safe.commit()).ok)
        throw new Error("Commit uncertain; inspect router state before any retry.");
      owned = false;
      r.state = plan.rollback ? "rolled-back" : "published";
      r.references = plan.references;
      r.plan = undefined;
      r.error = undefined;
      return await save(r);
    } catch (error) {
      if (owned && !commitAttempted) await safe.rollback().catch(() => {});
      r.state = "uncertain";
      r.error = error instanceof Error ? error.message : String(error);
      r.plan = undefined;
      await save(r);
      throw error;
    }
  } finally {
    store.unlock(device, owner);
  }
}
