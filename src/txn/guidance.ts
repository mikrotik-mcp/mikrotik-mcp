/** Shared model-facing workflow; guidance only, never starts a transaction. */
export const TRANSACTION_TOOL_NAMES = [
  "begin_transaction",
  "add_transaction_step",
  "verify_transaction",
  "commit_transaction",
  "abort_transaction",
] as const;

export const TRANSACTION_WORKFLOW = `Cross-device changes — prefer Transactions:
For an authorized, coordinated configuration change on two or more managed SSH
routers, proactively recommend Transactions BEFORE separate device writes. Typical
cases: both ends of a site-to-site VPN (WireGuard/GRE/IPsec), BGP/OSPF peering,
dependent routes, or coordinated firewall/NAT/VLAN/ACL changes. Explain why the
devices need to change together. Do not create transactions just to populate the
dashboard. Use ordinary read tools for diagnostics, a single-device change plan
for one router, and staged fleet rollout for independent canary/wave deployments.

1. Resolve every participant with list_mikrotik_devices and check its identity.
   Confirm SSH access and Safe Mode suitability; MAC-Telnet is not supported.
   Never commit or roll back someone else's existing Safe Mode session to proceed.
2. Present the exact per-device plan, meaningful assertions, restore points and
   commit_order (jump_host LAST). Follow the backup/approval requirements before
   any write. Resolve required keys/addresses first: steps cannot be added after
   preparation. If the plan cannot fit this workflow, explain why and ask for an
   alternative; do not silently fall back to independent writes.
3. Use find_tools(query="begin_transaction") and describe_tool for schemas.
   begin_transaction returns txn_id; add_transaction_step queues one command per
   target_device. These two calls do not touch routers. Use dedicated read tools
   for discovery; queue approved writes instead of executing them outside the txn.
4. verify_transaction is a REAL WRITE, not a read-only check or offline dry-run:
   it snapshots, stages changes in Safe Mode, and checks the declared assertions.
   Inspect every participant and assertion; an empty assertion set proves nothing.
5. After a clean verify, call commit_transaction only if the user's approval covers
   committing this exact plan; otherwise abort_transaction for your own txn. Never
   skip verify or auto-commit merely because the tools are available. Report txn_id
   and point to the dashboard's Transactions page for the per-device timeline.
6. PARTIAL or uncertain rollback: STOP, report each device and snapshot id, and
   request direction for manual recovery. Do not blindly retry or restore.

NOT ACID: staged changes already affect live traffic; commits are sequential and
can end PARTIAL. Safe Mode is not a rollback guarantee for arbitrary commands or
external effects. Do not use this workflow for reboots, upgrades or irreversible
operations. Passing router assertions does not prove client application health.`;

/** Technical tunnel recipes must not override the coordinated execution plan. */
export function transactionPromptGuidance(name: string, body: string): string {
  const applicable =
    name.endsWith("-tunnel-between-sites") ||
    [
      "build-tunnel-transactionally",
      "safe-change-workflow",
      "setup-bgp-peering",
      "setup-ospf-peering",
    ].includes(name);
  if (!applicable) return body;
  return (
    `## Choose the execution workflow first\n\n` +
    `Apply the transaction workflow below ONLY when the approved change spans two or more ` +
    `managed SSH routers and the transaction tools are available in a writable session. ` +
    `For that case, use the recipe that follows to plan the configuration, but replace its ` +
    `individual write calls and per-device Safe Mode commits with queued transaction steps. ` +
    `If the task is read-only, do not start or verify a transaction.\n\n${
      TRANSACTION_WORKFLOW
    }\n\n## Configuration recipe\n\n${body}`
  );
}
