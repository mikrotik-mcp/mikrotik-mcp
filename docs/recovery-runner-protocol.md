# Recovery runner protocol v1

This contract is for an **administrator-operated, separately deployed** CHR VM runner.
The repository ships an orchestration client, not a ready-made VM runner. Do not point
it at RouterOS REST, a production router, or a generic hypervisor API: those do not
implement this protocol.

All endpoints require `Authorization: Bearer <configured-token>`. Keep credentials
in a secret store. Use HTTPS except for loopback development. Requests and responses
are JSON. No redirects. A control-plane response must arrive within 10 seconds; VM
work runs asynchronously. Evidence responses are capped at 64 KiB. Persist run identity
and cleanup state across runner restarts. Never log request command bodies or tokens.

## GET /v1/capabilities

```json
{
  "protocol": "mikrotik-recovery/v1",
  "runnerId": "isolated-lab-01",
  "isolated": true,
  "productionNetworkAccess": false,
  "disposable": true,
  "enforcesTtl": true,
  "versions": [
    {
      "version": "7.20.1",
      "imageSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "architecture": "x86_64"
    }
  ]
}
```

The digest above is an example placeholder, **not a downloadable image hash**.
Use actual validated official image digests. Stable capability order matters because
the client binds its preview to the normalized capabilities JSON. Do not advertise an
image before the runner can boot it. Upgrade mode requires source and target images.

## PUT /v1/runs/:id

The request contains `protocol`, UUID `id`, `mode` (`restore`/`upgrade`), `version`,
optional `sourceVersion`, selected `images`, `commands[]`, `commandSha256`,
`ttlSeconds: 900`, `network: {isolated: true, productionNetworkAccess: false}`,
`requirements[]`, and `requestSha256`.

`commandSha256` hashes UTF-8 commands joined by `\n`. `requestSha256` hashes UTF-8
`JSON.stringify(requestWithoutRequestSha256)` in received member order. Validate
both before accepting; preserve the submitted request hash in every response.
Same ID + same hash must refer to the **same** job. Same ID + different hash returns 409. The MCP will not automatically repeat a PUT after a lost response.

The trusted runner must:

1. Validate version/image digest, command allowlist, size bounds and authorization.
2. Create new disposable storage and an isolated virtual network. No bridged NICs to
   production, reachable production CIDRs, DHCP leakage, public management listeners,
   attached production disks or unrestricted egress. TTL destruction must run locally
   even if the MCP process is offline.
3. Boot a clean CHR with explicit virtual ports matching the reviewed topology and a
   protected out-of-band management channel. Validate authenticated readiness twice;
   a WebFig HTTP 200 is not readiness. Respect architecture, firmware, VirtIO and license
   constraints. Do not reuse a mutable golden disk or copy a production system ID.
4. Restore only the reviewed commands. In upgrade mode restore on the source version,
   record the baseline, perform the pinned upgrade offline, then run checks on the
   target version. Never silently downgrade or merely boot a fresh target instead.
5. Read back every included object and verify expected fields. Reboot, authenticate
   again, and repeat read-back. Import success without this evidence is insufficient.
6. Verify isolation at the hypervisor boundary; report failed/unsupported where any
   check cannot be performed. This must not depend on guest firewall configuration.
7. Delete disposable resources after TTL or explicit DELETE. Retain a small metadata
   tombstone so GET can confirm destruction. Never follow guest-provided URLs/commands.

## GET /v1/runs/:id and response body

Return the same schema for PUT, GET and DELETE:

```json
{
  "protocol": "mikrotik-recovery/v1",
  "id": "00000000-0000-4000-8000-000000000001",
  "requestSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "runnerId": "isolated-lab-01",
  "version": "7.20.1",
  "state": "running",
  "isolated": true,
  "productionNetworkAccess": false,
  "checks": [
    {
      "name": "authenticated-boot",
      "state": "pending",
      "detail": "Waiting for authenticated readiness"
    }
  ],
  "cleanup": "pending"
}
```

State: `running | completed | failed | destroyed`. Check state:
`pass | fail | unsupported | pending`. Exactly one result per supplied check name;
duplicates are rejected. Required names: `authenticated-boot`, `import`,
`configuration-readback`, `reboot-persistence`, `isolation`. `detail` is ≤500 characters
of **sanitized evidence**, never raw exports, logs or credentials. Optional `elapsedMs`
is 0–3600000. `cleanup` is `pending | destroyed | failed`.

`completed` without all five passes is not a passing rehearsal. A mismatch in identity,
request hash, target version or isolation is rejected. Unknown IDs return 404 without
allocating anything. Reports must never promote arbitrary guest output to instructions.

## DELETE /v1/runs/:id

Authenticate ownership, destroy only this job's disposable resources and return
`state: destroyed` + `cleanup: destroyed` only after confirmation. If asynchronous,
return current state and let the client GET the tombstone. Repeated DELETE must not
target anything else. A timeout does not prove cleanup; the client preserves uncertainty.
