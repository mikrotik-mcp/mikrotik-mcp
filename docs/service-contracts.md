# Service health contracts

A contract defines the endpoint checks that must pass, their latency thresholds,
and optionally a saved packet regression suite. Results are explicit PASS, FAIL or
UNKNOWN. **Live probes originate from the MCP host**, not from a branch, router or
end user's machine. This is not an endpoint-agent deployment or proof of every
application workflow.

## Approve endpoints first

Nothing can be probed until an administrator configures named targets. Contracts
reference these aliases, not arbitrary URLs, hosts, credentials or request bodies.
Example config fragment (documentation addresses; replace deliberately):

```json
{
  "serviceProbes": {
    "timeoutMs": 5000,
    "targets": {
      "checkout_dns": {
        "kind": "dns",
        "host": "payments.example.com",
        "addresses": ["203.0.113.10/32"]
      },
      "checkout_https": {
        "kind": "https",
        "host": "payments.example.com",
        "port": 443,
        "path": "/health",
        "addresses": ["203.0.113.10/32"]
      }
    },
    "scheduled": {}
  }
}
```

Load this through the usual `--config` file (or full `MIKROTIK_DEVICES` document).
Config Studio and Raycast expose the timeout; use the JSON editor for the target
map and scheduled enrollment. Creating a contract does not grant target access.
Use narrow IP/CIDR ranges: DNS answers outside them invalidate the check. Every
answer must be approved; the socket pins the first approved IP and never resolves
the hostname again during connection. Private ranges are permitted only when
explicitly configured by the administrator. Update approval when provider IPs change.

## Create and check

In **Service Health**, select the owning router, contract name, approved aliases
and latency threshold. Saving does not probe anything. **Run checks** records a
new result; **View history** only reads existing results. The form expects HTTPS
200; use MCP for other explicitly accepted status codes.

MCP tools:

| Tool                         | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `list_service_probe_targets` | Discover approved aliases and probe kinds                       |
| `create_service_contract`    | Save a new immutable definition                                 |
| `list_service_contracts`     | List the selected router's definitions                          |
| `run_service_contract`       | Run a UUID-owned contract and persist its evidence              |
| `service_contract_history`   | Read the latest 100 results for that contract                   |
| `audit_service_contracts`    | Check explicitly enrolled contracts for scheduled finding diffs |

```json
{
  "device": "branch",
  "name": "Checkout availability",
  "checks": [
    { "target": "checkout_dns", "maxLatencyMs": 500 },
    { "target": "checkout_https", "maxLatencyMs": 1500, "expectedStatus": [200, 204] }
  ]
}
```

Use the returned `id` with `run_service_contract` under the same `device`. To
revise a definition, create a new contract and explicitly change its consumers.
Definitions are not overwritten. Device/tool access is enforced on dashboard
paths too; read-only server mode rejects definition writes. Case and contract
POST routes bound bodies to 8 KiB and reject cross-origin browser operations.
Reverse proxies should preserve the public Host when forwarding these requests.

## What a passing check proves

- **DNS:** address resolution succeeded and all answers are inside approved ranges.
- **TCP:** a connection was established to the configured port. No application
  request or SSH login was attempted.
- **TLS:** a TLS handshake with certificate/hostname validation succeeded.
- **HTTPS:** a GET returned response headers with an expected status over validated
  TLS, within the latency threshold. Bodies are not collected or checked.

There is no insecure TLS switch, redirect following, cookie jar, authentication
header, query string or model-controlled request body. Configure a safe health
endpoint: GET is not guaranteed side-effect-free on every application. Failed
connections/status/latency are FAIL; unavailable approval/resolution/evidence is
UNKNOWN. Neither passes a gate. Raw exceptions, HTTP bodies and credentials are
not stored. IP allowlists protect destination scope; they do not authenticate users.

Limits: 1–10 checks per contract; 100–10000 ms per probe (DNS plus connection);
at most four concurrent contract runs per process, with duplicate concurrent runs
rejected. Only the first approved address is connected; this does not measure every
backend of an anycast/load-balanced service. DNS uses the host's configured resolver.
IPv4 literals and DNS hostnames are accepted; a hostname may resolve to approved IPv6.

## Optional packet regressions

Set `packetSuiteId` to an existing simulator suite of 1–100 packets. Each run reads
a fresh `/export terse` through the shared RouterOS connector. It never substitutes
an old snapshot after a change. The pure simulator evaluates the expected
accept/drop/reject results and records the export SHA. Missing exports/suites or
unmodelled packet behavior are UNKNOWN, not skipped checks. The export read obeys
the connector's connection/transport timeouts and an 8-second read budget; it is
not covered by the native endpoint probe deadline. No router configuration changes.

These are simulated firewall regressions, not live negative-connectivity proof.
Combine them with the live service checks instead of treating either as complete
end-to-end network verification.

## Rollout gates

`start_rollout` accepts an optional `service_contracts` array:

```json
{
  "service_contracts": [{ "device": "branch", "id": "<UUID returned by create_service_contract>" }]
}
```

This fragment accompanies the existing commands/targets/strategy parameters.
With `confirm=false`, no checks or changes run. Confirmed rollouts check contracts
before the first change and after every wave, including contracts on untouched
targets. Every contract owner must be in the target set and initially reachable.
Unknown/failure/storage error prevents a passing service gate. `onFailure=continue`
is rejected when contracts are supplied. Existing halt/revert policy remains in
charge; this does not add crash-safe orchestration or stronger rollback guarantees.
Gate history includes contract/run IDs and explicitly names the MCP-host viewpoint.

## Continuous checks and notifications

Enroll up to five contract UUIDs per device under
`serviceProbes.scheduled`, for example `{"branch": ["<contract UUID>"]}`. Then
create an ordinary scheduled audit using tool `audit_service_contracts`, the same
device and an appropriate cron. Newly created contracts are **not** automatically
enrolled. The selected contracts may contain at most ten endpoint probes in total;
configure the scheduler timeout to cover their deadlines and optional export reads.

The existing scheduled-audit engine compares stable finding IDs and notifies on
new/worsened/resolved findings through its configured channels. Unknown evidence
is a finding; no enrollment produces an informational finding, not a false healthy
result. No schedules, notifications or external services are enabled by installation.

## Persistence and verification

Definitions and runs live in `service_contracts` / `service_contract_runs` tables
in the local snapshot database. Storage failure is an operation error, not a
successful recorded run. Histories show the latest 100 records; this version has
no automatic deletion, tenant isolation or immutable/WORM storage.

Run:

```sh
bunx vp test run tests/service-contracts tests/observability/bounded-request.spec.ts
bun run tests/service-contracts/store.smoke.ts
```

Tests cover approved IP ranges, mixed DNS answers, exact IP pinning, DNS-only
checks, latency/status failures, unknown evidence, native localhost TCP/TLS/HTTPS
failure handling, fresh-export packet regressions, history/access checks, explicit
schedule enrollment, and rollback progression with fake devices. No production
device mutations are used to test gates.

On 2026-09-11 the new native probe engine established TCP connections to the SSH
ports of the MCP-discovered `home-ax3` and `netherlands` devices. No SSH login or
RouterOS command was issued by that smoke check. This verifies TCP connectivity,
not live TLS/HTTP service correctness or a production rollout. The currently running
MCP server must load this version before new tools can be invoked through it.
