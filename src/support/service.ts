import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { investigationStore } from "../investigations/store";
import { openSnapshotStore } from "../snapshots/store";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { getEventStore } from "../observability/recorder";
import { workspaceStore } from "../workspaces/store";
import type { CheckSession } from "../client-check/model";
import { buildBundle, bundleInput } from "./bundle";

export async function createBundle(input: unknown, selected?: string) {
  const a = bundleInput.parse(input),
    device = resolveDeviceName(selected);
  assertDeviceAccess([device], "create_support_bundle", "WRITE");
  const store = await workspaceStore(),
    casesStore = await investigationStore();
  const cases = a.cases.map((id) => {
    const c = casesStore.get(id);
    if (!c || c.device !== device || c.createdAt < a.since || c.createdAt > a.until)
      throw new Error("Selected investigation is outside this router or time range.");
    assertDeviceAccess(c.devices, "create_support_bundle", "READ");
    return c;
  });
  const db = getEventStore(),
    missing: string[] = [];
  if (a.includeEvents && !db) missing.push("Event recorder is not active; events unavailable.");
  const snapshots = a.includeSnapshots ? await openSnapshotStore(DEFAULT_SNAPSHOT_DB) : null;
  try {
    const bundle = buildBundle(a, {
      device,
      cases,
      missing,
      events: a.includeEvents
        ? (db?.query({ device, since: a.since, until: a.until, limit: 200 }) ?? [])
        : [],
      snapshots: snapshots?.list(device, 500, true) ?? [],
      checks: a.includeChecks ? store.list<CheckSession>("client-check", device) : [],
    });
    store.save("support", bundle);
    return bundle;
  } finally {
    snapshots?.close();
  }
}
