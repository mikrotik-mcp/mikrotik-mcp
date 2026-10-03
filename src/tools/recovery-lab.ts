import { z } from "zod";
import { defineTool, READ, WRITE, DESTRUCTIVE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { recoveryInput } from "../recovery-lab/model";
import {
  getRecovery,
  recoveryInventory,
  prepareRecovery,
  startRecovery,
  pollRecovery,
  destroyRecovery,
} from "../recovery-lab/service";
export const recoveryLabTools: ToolModule = [
  defineTool({
    name: "get_recovery_lab",
    title: "Read Recovery Lab",
    annotations: READ,
    description:
      "Read device-scoped recovery rehearsals and last-known runner evidence. Local only, no router or runner contact. A passed portable subset is not proof of a full physical-router restore or production upgrade safety.",
    inputSchema: {},
    async handler(_, ctx) {
      return JSON.stringify(await getRecovery(ctx));
    },
  }),
  defineTool({
    name: "recovery_lab_inventory",
    title: "Inspect Recovery Lab Inputs",
    annotations: READ,
    description:
      "List this router's local snapshots and read the administrator-configured runner's isolation claims and pinned CHR images. Does not provision VMs or transmit snapshots. Runner must be separately installed; no fallback to production routers.",
    inputSchema: {},
    async handler(_, ctx) {
      return JSON.stringify(await recoveryInventory(ctx));
    },
  }),
  defineTool({
    name: "prepare_recovery_lab",
    title: "Prepare Isolated Recovery Rehearsal",
    annotations: WRITE,
    description:
      "Build a local immutable preview from an existing device-owned snapshot: allowlisted additive literal commands only, coverage counts, no secrets/scripts/management settings. No raw export upload, VM creation or router contact. Unknown scopes are excluded and remain untested. Preview expires in ten minutes.",
    inputSchema: recoveryInput.shape,
    async handler(a, ctx) {
      return JSON.stringify(await prepareRecovery(a, ctx));
    },
  }),
  defineTool({
    name: "start_recovery_lab",
    title: "Start Approved Recovery Rehearsal",
    annotations: WRITE,
    description:
      "Only after explicit approval, transmit the reviewed portable subset to the pinned isolated runner and request a disposable 15-minute CHR lab. Revalidate snapshot and runner capabilities. No production router I/O. An ambiguous request is never retried; poll the same ID. Requires a separately deployed runner implementing the documented protocol.",
    inputSchema: { id: z.uuid(), confirm: z.boolean().default(false) },
    async handler(a, ctx) {
      return JSON.stringify(await startRecovery(a.id, a.confirm, ctx));
    },
  }),
  defineTool({
    name: "poll_recovery_lab",
    title: "Read Recovery Runner Evidence",
    annotations: READ,
    description:
      "Poll the exact existing rehearsal ID on its original approved runner. Check identity, request hash, target version, isolation, distinct checks and cleanup. Full pass requires authenticated boot/import/readback/reboot/isolation; excluded scopes and hardware remain untested. No write retry.",
    inputSchema: { id: z.uuid() },
    async handler(a, ctx) {
      return JSON.stringify(await pollRecovery(a.id, ctx));
    },
  }),
  defineTool({
    name: "destroy_recovery_lab",
    title: "Destroy Owned Disposable Lab",
    annotations: DESTRUCTIVE,
    description:
      "After explicit confirmation, request destruction of the VM/resources belonging only to this submitted rehearsal ID on its original runner. Local evidence is retained. Requires verified destruction response; never destroys production devices or accepts arbitrary VM IDs.",
    inputSchema: { id: z.uuid(), confirm: z.boolean().default(false) },
    async handler(a, ctx) {
      return JSON.stringify(await destroyRecovery(a.id, a.confirm, ctx));
    },
  }),
];
