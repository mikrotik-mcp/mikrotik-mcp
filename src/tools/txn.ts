/**
 * Cross-device transactions — Safe Mode coordinated across several routers.
 *
 * Five thin tool faces over `src/txn/`: the pure state machine decides, the
 * coordinator performs, these render. A transaction spans tool calls, so its id
 * is the handle: `begin_transaction` opens it, `add_transaction_step` queues
 * work, `verify_transaction` prepares the whole fleet and asserts against the
 * uncommitted state, and `commit_transaction` / `abort_transaction` end it.
 *
 * The honest limits are repeated in the descriptions on purpose (this is NOT
 * ACID; commits are sequential; a failure after the first commit leaves PARTIAL
 * needing a human) — the model reads those descriptions to decide whether to
 * reach for this at all.
 */
import { z } from "zod";
import { DANGEROUS, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { resolveDeviceName } from "../core/runtime";
import { busyDevices, createDeviceExecutor, runTransaction } from "../txn/coordinator";
import type { TxnRun } from "../txn/coordinator";
import { beginTransaction, requestAbort } from "../txn/model";
import type { Assertion, Txn } from "../txn/model";
import {
  dropTxn,
  getTxn,
  listTxns,
  logTxnEvent,
  newTxnId,
  persistTxn,
  putTxn,
} from "../txn/session";
import type { LiveTxn } from "../txn/session";

/** The declarative assertions the verify phase can evaluate. */
const assertionSchema = z.union([
  z.object({
    kind: z.literal("ping"),
    from: z.string().describe("Device that sends the ping"),
    to: z.string().describe("Target address"),
  }),
  z.object({
    kind: z.literal("wireguard-peer-handshake"),
    device: z.string(),
    peer: z.string().describe("Peer public key"),
  }),
  z.object({
    kind: z.literal("route-present"),
    device: z.string(),
    dst: z.string().describe('Destination prefix, e.g. "10.0.0.0/30"'),
  }),
  z.object({ kind: z.literal("reachable"), device: z.string() }),
]);

const LIMITS =
  "NOT ACID: commits are issued sequentially, so between the first and the last commit the fleet " +
  "is briefly inconsistent, and a failure after something has committed ends PARTIAL — already-" +
  "committed devices are reported with the snapshot id to restore them from, by hand.";

/** Resolve a live transaction or explain why it is gone. */
function live(txnId: string): LiveTxn | string {
  const entry = getTxn(txnId);
  if (!entry) {
    const open = listTxns().map((t) => t.txn.id);
    const known = open.length > 0 ? ` Open transactions: ${open.join(", ")}.` : " None are open.";
    return `No open transaction '${txnId}'.${known}`;
  }
  return entry;
}

/** The report every terminal (or paused) run renders. */
function report(txnId: string, run: TxnRun, headline: string): string {
  const lines = [headline, "", `Transaction: ${txnId}`, "", "Participants:"];
  for (const line of run.summary) lines.push(`  ${line}`);
  if (run.txn.results.length > 0) {
    lines.push("", "Assertions:");
    for (const r of run.txn.results) {
      const target = "device" in r.assertion ? r.assertion.device : r.assertion.from;
      lines.push(`  [${r.ok ? "PASS" : "FAIL"}] ${r.assertion.kind} @ ${target} — ${r.detail}`);
    }
  }
  if (run.txn.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const w of run.txn.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join("\n");
}

/** Run the coordinator over a live transaction and persist what happened. */
async function advance(
  entry: LiveTxn,
  ctx: Parameters<typeof createDeviceExecutor>[0],
  stopWhen?: (action: { kind: string }) => boolean,
): Promise<TxnRun> {
  const run = await runTransaction({
    txn: entry.txn,
    steps: entry.steps,
    executor: createDeviceExecutor(ctx, entry.txn.id),
    stopWhen,
    onEvent: ({ action, outcome, txn }) => {
      entry.txn = txn;
      void logTxnEvent({
        txnId: txn.id,
        kind: action.kind,
        device: "device" in action ? action.device : undefined,
        ok: "ok" in outcome ? outcome.ok : outcome.results.every((r) => r.ok),
        detail:
          "error" in outcome
            ? outcome.error
            : "results" in outcome
              ? outcome.results
                  .map((r) => `${r.assertion.kind}:${r.ok ? "pass" : "fail"}`)
                  .join(" ")
              : undefined,
      });
    },
  });
  entry.txn = run.txn;
  await persistTxn(entry);
  if (run.state !== undefined) dropTxn(entry.txn.id);
  return run;
}

/** Devices are resolved once, so an alias and its config key can't split a txn. */
function resolveAll(devices: string[]): string[] {
  return devices.map((d) => resolveDeviceName(d));
}

export const txnTools: ToolModule = [
  defineTool({
    name: "begin_transaction",
    title: "Begin Cross-Device Transaction",
    annotations: WRITE,
    description:
      `Opens a cross-device transaction over several routers and returns its id — the handle every ` +
      `other transaction tool takes. Use this when a change must land on ALL of the named devices ` +
      `or on none of them (both ends of a tunnel, a routing peering, a fleet-wide ACL): each ` +
      `participant gets its own Safe Mode session, so nothing is persisted until commit_transaction. ` +
      `Queue the work with add_transaction_step, then verify_transaction, then commit_transaction ` +
      `(or abort_transaction). ` +
      `\`assertions\` are checked while everything is still uncommitted — that is where the safety ` +
      `comes from, so declare them. \`commit_order\` decides which router commits last: put the one ` +
      `you reach the others THROUGH last, and pass it as \`jump_host\` to get a warning if you don't. ` +
      `No device is touched by this call. ${LIMITS}`,
    inputSchema: {
      devices: z
        .array(z.string())
        .min(1)
        .describe("Configured device names taking part, in the order they should be prepared"),
      commit_order: z
        .array(z.string())
        .optional()
        .describe(
          "Order commits are issued in (defaults to `devices`); the safest device goes LAST",
        ),
      jump_host: z
        .string()
        .optional()
        .describe("Participant the others are reached through — warns unless it commits last"),
      assertions: z
        .array(assertionSchema)
        .optional()
        .describe("Checks run against the prepared-but-uncommitted fleet"),
      label: z.string().optional().describe('Human label, e.g. "site-a↔site-b tunnel"'),
    },
    handler(a, ctx) {
      const devices = resolveAll(a.devices);
      const busy = busyDevices(devices);
      if (busy.length > 0) {
        return (
          `Cannot start: Safe Mode is already active on ${busy.join(", ")}. A transaction needs its ` +
          "own session per device — commit or roll back the open one first (safe_mode_status, " +
          "commit_safe_mode, rollback_safe_mode)."
        );
      }

      let txn: Txn;
      try {
        txn = beginTransaction({
          id: newTxnId(),
          devices,
          commitOrder: a.commit_order ? resolveAll(a.commit_order) : undefined,
          jumpHost: a.jump_host ? resolveDeviceName(a.jump_host) : undefined,
          assertions: a.assertions as Assertion[] | undefined,
        });
      } catch (e) {
        return `Failed to begin transaction: ${e instanceof Error ? e.message : String(e)}`;
      }

      const entry = putTxn({ txn, steps: {}, ts: Date.now(), label: a.label });
      void persistTxn(entry);
      ctx.info(`Transaction ${txn.id} opened over ${devices.join(", ")}`);

      const lines = [
        `Transaction ${txn.id} opened over ${devices.length} device(s): ${devices.join(", ")}.`,
        `Commit order: ${txn.commitOrder.join(" → ")}.`,
        `Assertions: ${txn.assertions.length === 0 ? "none declared" : txn.assertions.map((x) => x.kind).join(", ")}.`,
        "",
        "Next: add_transaction_step for each change, then verify_transaction.",
      ];
      for (const w of txn.warnings) lines.push(`! ${w}`);
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "add_transaction_step",
    title: "Queue a Transaction Step",
    annotations: WRITE,
    description:
      "Queues one RouterOS command against one participant of an open transaction. Nothing runs " +
      "yet — the command is applied inside that device's Safe Mode session when verify_transaction " +
      "or commit_transaction prepares the fleet, so it can still be abandoned with no trace. " +
      "Call once per command; order is preserved per device. " +
      "Steps can only be added before the fleet is prepared.",
    inputSchema: {
      txn_id: z.string().describe("Transaction id from begin_transaction"),
      target_device: z.string().describe("Which participant this command runs on"),
      command: z.string().describe('Full RouterOS CLI command, e.g. "/ip address add address=..."'),
    },
    handler(a, ctx) {
      const entry = live(a.txn_id);
      if (typeof entry === "string") return entry;
      const device = resolveDeviceName(a.target_device);
      if (!entry.txn.devices.includes(device)) {
        return `'${device}' is not a participant of ${a.txn_id} (${entry.txn.devices.join(", ")}).`;
      }
      if (
        entry.txn.phase !== "prepare" ||
        entry.txn.participants.some((p) => p.stage !== "pending")
      ) {
        return (
          `Transaction ${a.txn_id} is already past PREPARE (phase ${entry.txn.phase}) — steps can ` +
          "only be queued beforehand. Abort it and open a new one to change the plan."
        );
      }

      entry.steps[device] = [...(entry.steps[device] ?? []), a.command];
      ctx.info(`[${device}] queued step ${entry.steps[device].length} for ${a.txn_id}`);
      const total = Object.values(entry.steps).reduce((n, s) => n + s.length, 0);
      return (
        `Queued for '${device}' (${entry.steps[device].length} step(s) on this device, ${total} in ` +
        `the transaction). Nothing has run yet — call verify_transaction when the plan is complete.`
      );
    },
  }),

  defineTool({
    name: "verify_transaction",
    title: "Prepare and Verify a Transaction",
    annotations: WRITE,
    description:
      "PREPARE + VERIFY: opens a Safe Mode session on every participant, snapshots each device, " +
      "applies its queued steps, then evaluates the declared assertions against the result — all " +
      "while NOTHING is committed. This is where the safety of a cross-device change comes from: a " +
      "step that errors or an assertion that fails rolls the entire fleet back automatically and " +
      "returns ABORTED, having changed nothing anywhere. " +
      "On success the fleet is left PREPARED and waiting: call commit_transaction to persist or " +
      "abort_transaction to discard. " +
      "Annotated WRITE, not read-only: it does stage changes on the devices (auto-reverted on " +
      "failure or disconnect), so it is not an inspection call.",
    inputSchema: {
      txn_id: z.string().describe("Transaction id from begin_transaction"),
    },
    async handler(a, ctx) {
      const entry = live(a.txn_id);
      if (typeof entry === "string") return entry;

      const run = await advance(entry, ctx, (action) => action.kind === "commit");
      if (run.state === "ABORTED") {
        return report(
          a.txn_id,
          run,
          "ABORTED — prepare or verification failed; every device was rolled back and NOTHING was changed.",
        );
      }
      if (run.state !== undefined)
        return report(a.txn_id, run, `${run.state} — transaction ended.`);

      return report(
        a.txn_id,
        run,
        "PREPARED and VERIFIED — all assertions passed and the changes are staged but NOT committed. " +
          `Call commit_transaction ${a.txn_id} to persist, or abort_transaction to discard. ` +
          "The Safe Mode sessions stay open until then; if this server loses them, RouterOS reverts everything.",
      );
    },
  }),

  defineTool({
    name: "commit_transaction",
    title: "Commit a Cross-Device Transaction",
    annotations: DANGEROUS,
    description:
      `Commits every participant, in the transaction's commit order. If the fleet has not been ` +
      `prepared yet this runs PREPARE and VERIFY first, so a failure before the first commit still ` +
      `ends ABORTED with nothing changed. ` +
      `Once a device HAS committed, a later failure cannot be undone cleanly: the coordinator ` +
      `reports PARTIAL and names each device's state and the snapshot id to restore it from. ` +
      `High blast radius and not repeatable — prefer verify_transaction first and read its output. ${LIMITS}`,
    inputSchema: {
      txn_id: z.string().describe("Transaction id from begin_transaction"),
    },
    async handler(a, ctx) {
      const entry = live(a.txn_id);
      if (typeof entry === "string") return entry;

      const run = await advance(entry, ctx);
      switch (run.state) {
        case "COMMITTED":
          return report(a.txn_id, run, "COMMITTED — every device persisted its changes.");
        case "ABORTED":
          return report(
            a.txn_id,
            run,
            "ABORTED — the transaction failed before anything was committed; nothing changed on any device.",
          );
        default:
          return report(
            a.txn_id,
            run,
            "PARTIAL — NEEDS A HUMAN. Some devices committed and could not be undone automatically. " +
              "Restore each flagged device from the snapshot id below (diff_config_snapshots <id> live, " +
              "then config_reconcile or restore_backup).",
          );
      }
    },
  }),

  defineTool({
    name: "abort_transaction",
    title: "Abort a Cross-Device Transaction",
    annotations: WRITE,
    description:
      "Rolls back every participant of an open transaction — closes each Safe Mode session so " +
      "RouterOS reverts the staged changes, leaving no trace. This is the clean exit and is always " +
      "safe to call while the transaction is prepared-but-uncommitted. " +
      "If some devices already committed (a PARTIAL transaction), those cannot be reverted this " +
      "way; the report names them and the snapshot to restore them from.",
    inputSchema: {
      txn_id: z.string().describe("Transaction id from begin_transaction"),
      reason: z.string().optional().describe("Recorded in the transaction log"),
    },
    async handler(a, ctx) {
      const entry = live(a.txn_id);
      if (typeof entry === "string") return entry;

      entry.txn = requestAbort(entry.txn, a.reason);
      const run = await advance(entry, ctx);
      return report(
        a.txn_id,
        run,
        run.state === "ABORTED"
          ? "ABORTED — every participant was rolled back; nothing was changed."
          : `${run.state ?? "OPEN"} — abort could not return the fleet to clean; see the per-device state below.`,
      );
    },
  }),
];
