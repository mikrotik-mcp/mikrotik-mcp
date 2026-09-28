import { randomUUID } from "node:crypto";
import { createContext } from "../core/context";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { parseKeyValues, parseRecords, parseFlagLegend } from "../core/routeros-parse";
import { Cmd, quoteValue } from "../core/routeros";
import { checkedRead, rows } from "../home/read";
import { captureSnapshot } from "../snapshots/capture";
import { getSafeModeManager } from "../ssh/safe-mode";
import { workspaceStore } from "../workspaces/store";
import { buildMigration, inventoryHash, migrationInput } from "./model";
import type { MigrationPlan, MigrationItem, RouterInventory } from "./model";

export async function migrationInventory(selected: string): Promise<RouterInventory> {
  const device = resolveDeviceName(selected),
    ctx = createContext(undefined, device);
  assertDeviceAccess([device], "inspect_router_migration", "READ");
  const resource = parseKeyValues(await checkedRead("/system resource print", ctx));
  const interfaces = await rows("/interface", "name,type,mac-address", ctx),
    packages = await rows("/system package", "name,version", ctx);
  const body = await checkedRead("/export terse", ctx);
  if (
    !resource.version ||
    !interfaces.length ||
    !/^\/[a-z]/m.test(body) ||
    /#\s*error exporting/i.test(body)
  )
    throw new Error("Could not read a complete router inventory/export. Nothing was changed.");
  return {
    version: resource.version.split(" ")[0],
    model: resource["board-name"] ?? "unknown",
    architecture: resource["architecture-name"] ?? "unknown",
    packages: packages.map((p) => `${p.name}@${p.version}`),
    interfaces: interfaces.map((i) => ({ name: i.name, type: i.type, mac: i["mac-address"] })),
    export: body,
  };
}
export async function previewMigration(input: unknown, selected?: string): Promise<MigrationPlan> {
  const a = migrationInput.parse(input),
    target = resolveDeviceName(selected);
  if (target !== resolveDeviceName(a.target))
    throw new Error("Select the target router as this tool's device.");
  a.source = resolveDeviceName(a.source);
  a.target = target;
  if (a.source === target) throw new Error("Source and target resolve to the same router.");
  assertDeviceAccess([a.source, target], "preview_router_migration", "WRITE");
  const source = await migrationInventory(a.source),
    destination = await migrationInventory(target),
    id = randomUUID();
  const { export: _, ...sourceSummary } = source,
    { export: __, ...targetSummary } = destination;
  const p: MigrationPlan = {
    id,
    device: target,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300000,
    status: "preview",
    input: a,
    source: sourceSummary,
    target: targetSummary,
    ...buildMigration(id, a, source, destination),
  };
  (await workspaceStore()).save("migration", p);
  return p;
}
const busy = new Set<string>();
const equalValue = (a: string, b: string) =>
  a === b ||
  (["yes", "true"].includes(a) && ["yes", "true"].includes(b)) ||
  (["no", "false"].includes(a) && ["no", "false"].includes(b));
export async function verifyMigrationItem(item: MigrationItem, device: string): Promise<void> {
  const key = item.path === "/ip/pool" || item.path === "/routing/table" ? "name" : "comment",
    value = key === "name" ? item.fields.name : item.tag;
  const output = await checkedRead(
    new Cmd(`${item.path} print detail without-paging`)
      .raw(`where ${key}=${quoteValue(value)}`)
      .build(),
    createContext(undefined, device),
  );
  const actual = parseRecords(output).rows;
  // Several RouterOS tables report disabled only through their X flag, not a key=value pair.
  const disabledFlag = Object.entries(parseFlagLegend(output)).find(
    ([, meaning]) => meaning.toLowerCase() === "disabled",
  )?.[0];
  if (actual.length === 1 && actual[0].disabled === undefined && disabledFlag)
    actual[0].disabled = (actual[0].flags ?? "").includes(disabledFlag) ? "yes" : "no";
  if (
    actual.length !== 1 ||
    Object.entries(item.fields).some(([k, v]) => !equalValue(actual[0][k] ?? "", v))
  )
    throw new Error(
      `Read-back did not match ${item.path} line ${item.line}. The result is not verified.`,
    );
}
/** Stage only. Never activates duplicate IPs, DHCP or routes on a live LAN. */
export async function applyMigration(
  id: string,
  mode: "rehearse" | "stage",
  confirm: boolean,
  acknowledgeManual: boolean,
  selected?: string,
): Promise<MigrationPlan> {
  const device = resolveDeviceName(selected),
    store = await workspaceStore(),
    p = store.get<MigrationPlan>("migration", id, device);
  if (!p) throw new Error("Migration not found on this target.");
  assertDeviceAccess([device, p.input.source], "apply_router_migration", "WRITE");
  if (getDevice(device).mac) throw new Error("Migration requires SSH Safe Mode, not MAC-Telnet.");
  if (!confirm || (p.manual.length && !acknowledgeManual))
    throw new Error(
      "Review commands and manual items; explicit approval is required even for rehearsal.",
    );
  if (p.status !== "preview" || p.expiresAt < Date.now() || p.blockers.length)
    throw new Error("Create a fresh, unblocked preview first.");
  if (busy.has(device)) throw new Error("A migration operation is already running.");
  const safe = getSafeModeManager(device);
  busy.add(device);
  let owned = false,
    commitAttempted = false,
    claimed = false;
  try {
    if (safe.isActive) throw new Error("Finish the existing Safe Mode session first.");
    const source = await migrationInventory(p.input.source),
      target = await migrationInventory(device);
    if (inventoryHash(source, target) !== p.fingerprint)
      throw new Error("Router state changed after preview. Rebuild the plan.");
    // Captures contain hidden-secret exports, not complete cryptographic disaster recovery.
    p.snapshots = {
      source: await captureSnapshot(
        createContext(undefined, p.input.source),
        "Before router migration (source)",
        true,
      ),
      target: await captureSnapshot(
        createContext(undefined, device),
        "Before router migration (target)",
        true,
      ),
    };
    p.status = "applying";
    store.claim("migration", p, "preview");
    claimed = true;
    if (!(await safe.enable()).startsWith("Safe mode ENABLED"))
      throw new Error("Could not acquire a new Safe Mode session.");
    owned = true;
    if (
      inventoryHash(await migrationInventory(p.input.source), await migrationInventory(device)) !==
      p.fingerprint
    )
      throw new Error("Configuration changed while acquiring Safe Mode.");
    const started = Date.now();
    for (const item of p.items) {
      if (Date.now() - started > 120000) throw new Error("Migration time budget exceeded.");
      assertDeviceAccess([device], "apply_router_migration", "WRITE");
      if (!safe.isActive) throw new Error("Safe Mode was lost. Do not retry.");
      await checkedRead(item.command, createContext(undefined, device));
      await verifyMigrationItem(item, device);
    }
    await checkedRead("/system identity print", createContext(undefined, device));
    if (mode === "rehearse") {
      await safe.rollback();
      owned = false;
      if (inventoryHash(source, await migrationInventory(device)) !== p.fingerprint)
        throw new Error("Rollback has not been verified. Inspect target before continuing.");
      p.status = "rehearsed";
    } else {
      commitAttempted = true;
      const result = await safe.commit();
      owned = false;
      if (!result.ok)
        throw new Error("Commit outcome is uncertain. Inspect the target; do not retry.");
      p.status = "staged";
    }
    store.save("migration", p);
    return p;
  } catch (e) {
    if (owned && !commitAttempted) await safe.rollback().catch(() => {});
    if (claimed && p.status === "applying") {
      p.status = "uncertain";
      p.error = e instanceof Error ? e.message : "Migration could not be confirmed";
      store.save("migration", p);
    }
    throw e;
  } finally {
    busy.delete(device);
  }
}
export async function undoMigration(id: string, confirm: boolean, selected?: string) {
  const device = resolveDeviceName(selected),
    store = await workspaceStore(),
    p = store.get<MigrationPlan>("migration", id, device);
  assertDeviceAccess([device], "undo_router_migration", "DESTRUCTIVE");
  if (!confirm || !p || p.status !== "staged")
    throw new Error(
      "Only a confirmed staged migration can be removed automatically. Inspect uncertain results manually.",
    );
  if (busy.has(device)) throw new Error("Migration already running.");
  const safe = getSafeModeManager(device);
  if (safe.isActive) throw new Error("Finish existing Safe Mode first.");
  busy.add(device);
  let owned = false,
    commitAttempted = false,
    claimed = false;
  try {
    await captureSnapshot(
      createContext(undefined, device),
      "Before undoing staged migration",
      true,
    );
    p.status = "undoing";
    store.claim("migration", p, "staged");
    claimed = true;
    if (!(await safe.enable()).startsWith("Safe mode ENABLED"))
      throw new Error("Safe Mode unavailable.");
    owned = true;
    // Refuse to erase objects an operator has since activated or edited.
    for (const item of p.items) await verifyMigrationItem(item, device);
    const started = Date.now();
    for (const item of [...p.items].reverse()) {
      assertDeviceAccess([device], "undo_router_migration", "DESTRUCTIVE");
      if (!safe.isActive || Date.now() - started > 120000)
        throw new Error("Undo lost Safe Mode or exceeded its time budget.");
      await checkedRead(item.undo, createContext(undefined, device));
    }
    const beforeTarget = (await import("../snapshots/store")).openSnapshotStore;
    const db = await beforeTarget((await import("../config")).DEFAULT_SNAPSHOT_DB);
    try {
      const original = db.get(p.snapshots!.target);
      if (!original) throw new Error("Original target snapshot unavailable.");
      const { normalizeExport } = await import("../snapshots/format");
      if (
        normalizeExport((await migrationInventory(device)).export) !==
        normalizeExport(original.body)
      )
        throw new Error("Target differs from its backup. Undo verification failed.");
    } finally {
      db.close();
    }
    commitAttempted = true;
    if (!(await safe.commit()).ok)
      throw new Error("Undo commit uncertain. Inspect target; do not retry.");
    owned = false;
    p.status = "undone";
    store.save("migration", p);
    return p;
  } catch (e) {
    if (claimed) {
      p.status = "uncertain";
      p.error = e instanceof Error ? e.message : "Undo uncertain";
      store.save("migration", p);
    }
    throw e;
  } finally {
    if (owned && !commitAttempted) await safe.rollback().catch(() => {});
    busy.delete(device);
  }
}
