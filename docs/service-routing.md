# Service-aware routing

**Service Routing** (`#service-routing`) manages exact-hostname, single-family
policies on an explicitly selected router. Create separate policies for IPv4 and
IPv6. No policy, probe, failover authorization or router change is enabled merely
by installing this release or visiting the page.

## Workflow

1. Configure safe HTTPS health endpoints under `serviceProbes.targets` in the MCP
   config. These are administrator-approved aliases with explicit IP/CIDR ranges;
   see [Service Health](service-contracts.md). A target should accept HEAD requests.
2. Choose **New policy**, a target alias, client CIDRs, up to three existing FIB
   tables and a primary. **Save draft** changes local state only.
3. **Check exits** collects router-originated HTTPS HEAD evidence via matching
   RouterOS VRFs. Ordinary policy-routing tables are not VRFs and remain UNKNOWN.
4. **Preview route** reads current configuration. Review every command and the
   shared-CDN-IP implications, then explicitly confirm **Apply reviewed change**.
5. The server captures a configuration snapshot, enters a new exclusive Safe Mode
   session, rechecks the fingerprint, applies and reads back the mark before commit.
   An uncertain write stops the workflow; it is never automatically replayed.
6. Optionally authorize automatic failover for 30 minutes in the UI (1–60 via MCP).
   Every exit must have fresh passing evidence. Pause at any time. Authorization
   expiry **stops switching but leaves the current route in place**.
7. Remove an active policy through a separate preview/confirmation. Only exact
   `mcp-sr-<UUID>`-owned rules and address-list records are removed.

## Policy boundaries

Rules target forwarded client traffic in `prerouting`, not router-originated
`output` or management `input`. Local destinations and common private/link-local/
multicast ranges return untouched. The router resolves the exact hostname in an
owned address list and maintains its DNS-derived members. This is **IP-based**
policy: other domains sharing a CDN IP can be affected; subdomains are not implied.
Client DNS/DoH answers can differ from the router's answers. No DNS interception,
WAN, VPN, NAT or return route is created. Existing connections can be interrupted.

An enabled FIB table and observed active family-specific default route are
required. Foreign routing marks/jumps and configured or lingering IPv4 FastTrack
connections block changes rather than silently bypassing an existing policy.
Owned rule scope changes also block switching. Conservative conflict detection
can require an administrator to redesign existing policy routing first.

## Evidence and automation

The MCP host resolves the approved health target; every answer must satisfy its
configured address approval. One address of the selected family is pinned into
RouterOS fetch through `address=<IP>@<VRF>`, preserving the configured host,
validating certificates, disabling redirects and requesting headers only.
No credentials, response bodies or downloaded files are stored. Unsupported
commands, missing answers and transport errors are UNKNOWN, not a passing probe.
Elapsed time includes SSH overhead, not pure HTTP latency. Results describe a
router VRF, **not the actual forwarded client path, geolocation or throughput**.

The server polls armed policies every 30 seconds, sequentially, with no overlapping
tick. One policy per router may be armed at a time. Switching requires the configured
consecutive definite failures, two fresh passing samples for a fallback, a cooldown,
current access permission, fresh preflight and Safe Mode. UNKNOWN never triggers
failover. Primary is preferred among eligible fallbacks; there is no latency chasing
or automatic failback while the current path is healthy. Scope is durable and
time-limited across restarts. Router downtime does not extend the authorization.

## Tools and storage

- `service_routing_inventory`, `list_service_routing`
- `create_service_routing`, `probe_service_routing`
- `preview_service_routing`, `apply_service_routing`
- `arm_service_routing` (`minutes: 0` pauses)

Policies, the latest 180 samples and 100 decisions live in `operations.db` beside
the snapshot database. This location is covered by the Docker state volume.
All entry points enforce device/risk access and read-only mode for writes. Browser
operations require an explicit device, bounded bodies and same-origin requests.
Cross-process router locks prevent concurrent workspace changes. A crash-held lock
requires operator investigation; it is not automatically stolen. `uncertain`
policies must be inspected against their snapshot before manual reconciliation.

## Verification

`bunx vp test run tests/service-routing tests/observability/service-routing-view.spec.ts`
covers policy scope, family separation, FastTrack/conflict handling, preview binding,
read-back, ambiguous writes, authorization, failover hysteresis and UI confirmation.
These are offline tests. Verify fetch/VRF and DNS-list behavior on your RouterOS
version in a lab before production enrollment.

References: [RouterOS fetch](https://manual.mikrotik.com/docs/cli-reference/tool/fetch/),
[address lists](https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/address-lists/).
