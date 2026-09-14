# Access Scope settings

Open **Protect → Access Scope** to manage the MCP server's permission boundary
without editing JSON. This controls tool calls in the running server process;
it does not modify RouterOS users, firewall rules or router configuration.

## Configure the operator policy

- **Enforcement:** enable or disable the configured access policy. Disabled rules
  are retained as configuration but are not enforced by that base policy.
- **Policy label:** an optional note shown with access denials.
- **Maximum risk:** allow reads, ordinary writes, destructive operations or the
  highest-risk operations. WRITE and WRITE_IDEMPOTENT share the same ceiling:
  being safe to retry does not make a write read-only.
- **Router boundaries:** allow all configured routers or explicitly select a
  group, then block exceptions. Blocks take precedence. “All” includes future
  configured routers. An empty selected group cannot be submitted as “all”.
- **Tool rules:** search the catalog in the BeUI Combobox and select exact tools,
  or type a glob such as `get_*`, `*_wireguard_*` or `remove_*` and choose
  **Add pattern**. Each removable token shows its current catalog match count.
  Glob rules stay as patterns, including future matching tools; zero-match
  patterns are allowed. Search covers the full catalog, with up to 80 results
  shown at once. An empty allow-list means all names; block patterns take
  precedence. Matching is whole-name and case-insensitive; only `*` is a
  wildcard (zero or more characters). These rules do not inspect tool arguments.

The Read only and Routine changes shortcuts adjust enforcement and the risk
ceiling without discarding existing device or tool rules.

## Preview before applying

The **Permission lens** evaluates the draft against the same access evaluator
used by MCP calls. Choose a router and search for a tool to see the decision and
its reason. Counts cover the catalog at the selected target, not actual traffic.
Tools with no device context ignore the router selection; an omitted target for
a device-bound tool uses the configured default router.

The preview includes active session restrictions and server read-only mode.
Passing this check does not guarantee that a tool is exposed, that approvals or
arguments are valid, or that a device supports it. It executes no tools, contacts
no router, and does not create denial-history entries.

## Apply, keep or revert

1. Select **Review changes** and inspect the exact before/after settings.
2. Select **Apply for 60 seconds**. The server backs up its configuration, saves
   only the access-policy change into the full existing configuration, applies
   it to subsequent calls, and arms a rollback timer.
3. Select **Keep changes** to make it permanent, or **Revert now** to restore the
   previous configuration. Without confirmation, the running server reverts it
   after 60 seconds, even if the browser tab closes.

Refresh recovers an existing pending confirmation. A second pending configuration
change cannot be started here. If another editor or a session changes the policy
after loading, the revision check rejects the stale draft; reload and review it
again. A timed-out save has an uncertain outcome: refresh before retrying.

The rollback timer lives in the server process, not in a durable job queue. A
server crash or restart during the confirmation window cannot run that timer;
the written file and its backup remain. If the process was launched using only
environment or inline configuration, later launches must use the saved config
file to retain dashboard changes. Existing in-flight calls are not cancelled.

## Understand the runtime layers

The page shows the saved operator policy separately from the effective policy.
Runtime narrowing requested through `narrow_access_scope` survives configuration
updates. This editor cannot reset that narrowing. Session expiry is shown when
present, but is not a base-policy setting. Server-wide read-only mode remains a
separate guard and is not changed by this editor.

Blocked call history contains up to 50 recent real denials, newest first. It is
held in memory and resets when the server restarts. No entries can mean no denied
calls, rather than missing router telemetry; failed loading is shown separately.

## Administrative boundary

Editing uses the dashboard's existing administrative access, including its bearer
token when configured. Access Scope restricts MCP calls, not dashboard operators.
Protect the dashboard with its token and a trusted bind address/network; do not
expose an unauthenticated dashboard as a public management interface.

The settings API exposes only policy data, configured device names and disabled
flags, and catalog metadata—not device hosts, passwords or SSH keys. Writes are
JSON-only and reject cross-site browser requests. No endpoint grants a model the
ability to widen its own scope.
