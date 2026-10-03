import { DEFAULT_SNAPSHOT_DB } from "../config";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import type { ToolContext } from "../core/context";
import { openSnapshotStore } from "../snapshots/store";
import { operationsStore } from "../operations/store";
import { callRunner, runnerConfig } from "./runner";
import {
  recoveryInput,
  buildRecoverySubset,
  capabilitiesSchema,
  sha256,
  validateRunnerResult,
  resultState,
} from "./model";
import type { RecoveryRun } from "./model";

const kind = "recovery-lab";
function access(ctx: ToolContext, tool: string, write = false) {
  const device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], tool, write ? "WRITE" : "READ");
  return device;
}
export async function getRecovery(ctx: ToolContext) {
  const device = access(ctx, "get_recovery_lab");
  let configured = false,
    configurationError: string | undefined;
  try {
    configured = !!runnerConfig();
  } catch {
    configurationError =
      "Runner configuration is invalid; ask the administrator to check the URL/token.";
  }
  return {
    runs: (await operationsStore()).list<RecoveryRun>(kind, device),
    configured,
    configurationError,
  };
}
export async function recoveryInventory(ctx: ToolContext) {
  const device = access(ctx, "recovery_lab_inventory"),
    store = await openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  try {
    const snapshots = store
      .list(device, 50)
      .map((s) => ({ id: s.id, at: s.ts, label: s.label, version: s.rosVersion }));
    const cfg = runnerConfig();
    return {
      snapshots,
      runner: cfg ? capabilitiesSchema.parse(await callRunner("GET", "/v1/capabilities")) : null,
    };
  } finally {
    store.close();
  }
}
export async function prepareRecovery(input: unknown, ctx: ToolContext) {
  const device = access(ctx, "prepare_recovery_lab", true),
    a = recoveryInput.parse(input);
  const snapshots = await openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  try {
    const source = snapshots.get(a.snapshotId);
    if (!source || source.device !== device) throw new Error("Snapshot not found on this router.");
    const subset = buildRecoverySubset(source.body),
      cfg = runnerConfig();
    const caps = cfg
      ? capabilitiesSchema.parse(await callRunner("GET", "/v1/capabilities"))
      : undefined;
    if (caps && !caps.versions.some((v) => v.version === a.version))
      throw new Error("Target version is not available as a pinned runner image.");
    if (
      a.mode === "upgrade" &&
      (!source.rosVersion || (caps && !caps.versions.some((v) => v.version === source.rosVersion)))
    )
      throw new Error(
        "Upgrade rehearsal requires a known source version and pinned source/target images.",
      );
    const now = Date.now();
    const run: RecoveryRun = {
      id: crypto.randomUUID(),
      device,
      updatedAt: now,
      preparedAt: now,
      snapshotId: source.id,
      snapshotSha: sha256(source.body),
      snapshotAt: source.ts,
      sourceVersion: source.rosVersion,
      version: a.version,
      mode: a.mode,
      ...subset,
      commandSha256: sha256(subset.commands.join("\n")),
      state: "prepared",
      runnerId: caps?.runnerId,
      runnerBinding: cfg?.binding,
      capabilitiesSha: caps ? sha256(JSON.stringify(caps)) : undefined,
    };
    const store = await operationsStore();
    if (store.list(kind, device).length >= 100)
      throw new Error(
        "100 rehearsal records reached. Archive/export old evidence before creating more.",
      );
    store.put(kind, run);
    return run;
  } finally {
    snapshots.close();
  }
}
async function editRun<T>(
  id: string,
  device: string,
  work: (run: RecoveryRun) => Promise<T>,
): Promise<T> {
  const store = await operationsStore(),
    owner = crypto.randomUUID();
  store.lock(`lab:${device}`, owner);
  try {
    const r = store.get<RecoveryRun>(kind, id, device);
    if (!r) throw new Error("Rehearsal not found on this router.");
    return await work(r);
  } finally {
    store.unlock(`lab:${device}`, owner);
  }
}
async function save(run: RecoveryRun) {
  run.updatedAt = Date.now();
  (await operationsStore()).put(kind, run);
}
function boundRunner(run: RecoveryRun) {
  const cfg = runnerConfig();
  if (!cfg || cfg.binding !== run.runnerBinding)
    throw new Error(
      "Runner changed or is unavailable. Never send an existing rehearsal to a different destination.",
    );
}
export async function startRecovery(id: string, confirm: boolean, ctx: ToolContext) {
  const device = access(ctx, "start_recovery_lab", true);
  if (!confirm)
    throw new Error(
      "Explicit confirmation is required to send the reviewed subset to the configured isolated runner.",
    );
  return editRun(id, device, async (run) => {
    if (run.state !== "prepared")
      throw new Error(
        "Already submitted or uncertain. Poll its existing ID; do not replay the write.",
      );
    if (Date.now() - run.preparedAt > 600000)
      throw new Error("Preview expired; prepare a fresh rehearsal.");
    if (!run.commands.length) throw new Error("There are no portable records to rehearse.");
    boundRunner(run);
    const caps = capabilitiesSchema.parse(await callRunner("GET", "/v1/capabilities"));
    if (sha256(JSON.stringify(caps)) !== run.capabilitiesSha)
      throw new Error("Runner capabilities changed; prepare again.");
    const snapshots = await openSnapshotStore(DEFAULT_SNAPSHOT_DB);
    try {
      const source = snapshots.get(run.snapshotId);
      if (!source || source.device !== device || sha256(source.body) !== run.snapshotSha)
        throw new Error("Source snapshot changed or was removed.");
    } finally {
      snapshots.close();
    }
    const request = {
      protocol: "mikrotik-recovery/v1",
      id: run.id,
      mode: run.mode,
      version: run.version,
      sourceVersion: run.sourceVersion,
      images: caps.versions.filter(
        (v) =>
          v.version === run.version || (run.mode === "upgrade" && v.version === run.sourceVersion),
      ),
      commands: run.commands,
      commandSha256: run.commandSha256,
      ttlSeconds: 900,
      network: { isolated: true, productionNetworkAccess: false },
      requirements: [
        "authenticated-boot",
        "import",
        "configuration-readback",
        "reboot-persistence",
        "isolation",
      ],
    };
    run.requestSha256 = sha256(JSON.stringify(request));
    run.startedAt = Date.now();
    run.state = "uncertain";
    await save(run);
    try {
      const result = validateRunnerResult(
        await callRunner("PUT", `/v1/runs/${run.id}`, {
          ...request,
          requestSha256: run.requestSha256,
        }),
        run,
      );
      run.result = result;
      run.state = resultState(result);
      run.error = undefined;
    } catch {
      run.error =
        "Submission outcome is uncertain. Poll this run ID before any further action; no automatic retry was attempted.";
    }
    await save(run);
    return run;
  });
}
export async function pollRecovery(id: string, ctx: ToolContext) {
  const device = access(ctx, "poll_recovery_lab");
  return editRun(id, device, async (run) => {
    if (!run.requestSha256) throw new Error("This rehearsal has not been submitted.");
    boundRunner(run);
    try {
      const result = validateRunnerResult(await callRunner("GET", `/v1/runs/${run.id}`), run);
      run.result = result;
      run.state = resultState(result);
      run.error = undefined;
    } catch {
      run.state = "uncertain";
      run.error =
        "Runner evidence unavailable or mismatched. Last-known results retained, not treated as fresh.";
    }
    await save(run);
    return run;
  });
}
export async function destroyRecovery(id: string, confirm: boolean, ctx: ToolContext) {
  const device = access(ctx, "destroy_recovery_lab", true);
  if (!confirm) throw new Error("Confirm deletion of this disposable lab only.");
  return editRun(id, device, async (run) => {
    if (!run.requestSha256) throw new Error("This rehearsal has not been submitted.");
    boundRunner(run);
    run.state = "uncertain";
    await save(run);
    try {
      const result = validateRunnerResult(await callRunner("DELETE", `/v1/runs/${run.id}`), run);
      run.result = result;
      if (result.state !== "destroyed" || result.cleanup !== "destroyed")
        throw new Error("Cleanup not confirmed");
      run.state = "destroyed";
      run.error = undefined;
    } catch {
      run.error =
        "Lab cleanup is not confirmed. Inspect the runner and poll this ID; production routers were not contacted.";
    }
    await save(run);
    return run;
  });
}
