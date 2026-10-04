# Service-aware routing

**Service Routing** (`#service-routing`) opens on **Router configuration**: the
selected router's actual IPv4/IPv6 routes, ordered Mangle and routing rules,
address lists, routing tables and VRFs. **MCP policies** is a separate workspace
for exact-domain or wildcard, single-family policies. Existing router rules are visible
without creating a policy or configuring probe targets; they are not silently
adopted or changed. Create separate policies for IPv4 and
IPv6. No policy, probe, failover authorization or router change is enabled merely
by installing this release or visiting the page.

## Inspect existing routing

- Search by address, gateway, list name or comment. Filter by IP family or table;
  dynamic, disabled and inactive entries are included. Rule order is preserved.
- **Inspect** shows the recorded properties and referenced address-list members.
  An active route is RouterOS forwarding state, not proof that a website works.
- Each section has its own read status and timestamp. Failures remain unavailable,
  not empty/zero. A refresh failure retains the previous snapshot with a warning.
- Structured `print detail as-value` preserves valueless FIB flags and dynamic
  routes that human-readable parsing missed. Boolean values are normalized before
  policy preflight and ownership checks.
- Read-only snapshots are coalesced per router and cached for 20 seconds (5 seconds
  if partial). The page refreshes every 30 seconds while visible; writes invalidate
  the cache. Each read has a 6-second limit, at most two reads run together, and
  no new reads start after the 25-second snapshot budget. Non-address sections over
  2,000 entries or 1 MiB are unavailable rather than silently truncated.
- **Address lists** and the **Inspect → Referenced address lists** explorer show
  compact, copyable addresses, list names, comments and dynamic/disabled status.
  Search IPs, comments or list names with typo tolerance; literal matches rank first
  and approximate matches are labelled. Persian/Arabic digits are accepted.
- Switch between **This rule’s lists** and **All router lists** (IPv4 + IPv6), then
  filter by family or list. All **200-entry pages** are read automatically, with
  explicit progress and incomplete/error states. Search is local to the accumulated
  snapshot, never a new SSH command per keystroke. Complete snapshots are shared
  between inspectors in this browser and reused for 60 seconds on reopening, in
  memory only. **Refresh** reads again; closing the last reader cancels pending work.
- Results are displayed 40 at a time using ScrollArea. Reads stop at 20,000 entries
  or 120 seconds per family (15-second request timeout), explicitly marked incomplete.
  Pages are live reads, not an atomic export; detected count/ID changes require a
  refresh. Changes that preserve counts may go undetected: refresh after editing
  router lists. Other routing sections remain usable independently.
- Draft exits require an observed active **forwarding** default route of the
  selected family: a blackhole/kill-switch is not a usable exit. The form explains
  missing defaults and VRF probe limitations before selection. Existing marks,
  jumps and FastTrack blockers are shown before preview; safety checks still run
  against fresh router data before applying.

The dashboard build and backend must be updated together. A running installed
package does not pick up source changes in a separate checkout automatically.

## Workflow

1. Choose **New MCP policy**, enter a domain (`api.example.com`) or wildcard
   (`*.example.com`), client CIDRs, up to three existing FIB exits and a primary.
   Wildcards exclude the apex and require the DNS-learning acknowledgement below.
   **Save draft** changes local state only. A manual domain route needs **no probe approval**.
2. Optionally add safe HTTPS health endpoints with **Service probes → Add service** in this
   workspace (or **Config → Edit config → Service Probes**). Review, save and keep
   the changes, then return to the policy draft. JSON is also supported under `serviceProbes.targets` in the MCP
   config. These are administrator-approved aliases with explicit IP/CIDR ranges;
   see [Service Health](service-contracts.md). A target should accept HEAD requests.
   The optional approved service must match the domain (a concrete subdomain for
   wildcards). A legacy request without `domain` still routes the selected alias's
   exact hostname. A probe verifies one host, not all wildcard subdomains.
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
   `mcp-sr-<UUID>`-owned rules and address-list records are removed. For wildcards,
   the exact owned DNS learner and its UUID-namespaced dynamic lists are removed too.

## Exact domains and wildcards

- **Exact**: the router resolves the FQDN in an owned address list, without
  changing client DNS settings. DNS/CDN answers may differ between router and client.
- **Wildcard**: `*.example.com` matches `api.example.com` and `a.b.example.com`,
  **not** `example.com` or `notexample.com`. MCP generates an anchored, restricted
  regex for an owned `/ip dns static type=FWD` entry; arbitrary regex, URLs and
  wildcard placement are rejected. Existing upstream DNS is used.
- Wildcard preflight requires stable **RouterOS 7.17+**, existing
  `allow-remote-requests=yes`, and explicit DNS-learning consent. Clients must
  query this router's DNS. DNS provided by a different router, external DNS,
  client DoH/DoT, cached answers, and connections started before learning are not
  guaranteed to match. `:resolve` on the router does not establish client learning.
- DNS learning is shared by all DNS clients of that router; the routing rule still
  restricts the source subnets and IP family. **FWD bypasses adlists for matching
  DNS names**. This side effect is disclosed both in the form and the apply preview.
- No DHCP, DNS redirect, open resolver, cache flush, WAN, VPN or NAT is created.
  Keep DNS access protected from the internet. Learned addresses expire with DNS TTL.
- Overlapping existing static DNS entries, including a second overlapping wildcard
  policy in the other IP family, are blocked for manual review rather than silently
  overriding or sharing ownership. Independent, non-overlapping generated wildcards
  can coexist. Other regex entries are conservatively treated as conflicts.

## Traffic for each policy

Select an active policy under **MCP policies** to see **Traffic matched by this route**:
matched bytes, packets, current bit rate and a fluid five-minute chart. Reads use
only that policy's exact-owned `mark-routing` rule, not the sum of all its jump,
exclusion and mark rules (which would double-count packets).

These are **client → service** counters, not download/return traffic, successful
delivery, billing usage or whole-connection totals. Totals are since the router's
last counter reset; the chart is only this browser session. Shared CDN IPs can
include other services. A zero counter alone does not prove the domain was learned.

The selected visible policy polls about every five seconds with a four-second
server cache and coalesced reads. Drafts, removed policies and paused operations
do not poll. Missing/disabled/changed marks and read failures stay **unavailable**.
64-bit counters travel as decimal strings, and deltas use BigInt before formatting.
Counter resets, long gaps, device/rule/exit changes and unavailable samples break
the rate baseline; they are not plotted as zero or a spike. No reset is sent.

## Policy boundaries

Rules target forwarded client traffic in `prerouting`, not router-originated
`output` or management `input`. Local destinations and common private/link-local/
multicast ranges return untouched. The router resolves the exact hostname in an
owned address list and maintains its DNS-derived members. This is **IP-based**
policy: other domains sharing a CDN IP can be affected; subdomains require wildcard mode.
Client DNS/DoH answers can differ from the router's answers. No DNS interception,
WAN, VPN, NAT or return route is created. Existing connections can be interrupted.

An enabled FIB table and observed active family-specific default route are
required. Foreign routing marks/jumps block changes by default. After inspecting
existing rules, the operator can explicitly select **Place this scoped route before
existing routing rules** (`precedence: "before-existing"`). The reviewed preview
then inserts the scoped jump first; it never rewrites the other rules. Fresh full
mangle configuration remains bound to the preview. Configured FastTrack and
lingering IPv4 FastTrack connections always block changes.
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

- `service_routing_inventory`, `service_routing_address_page`, `list_service_routing`
- `service_routing_traffic` (read-only, explicit policy ID and router)
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
Domain, counter and live-polling component tests also cover wildcard boundaries,
DNS consent/conflicts, decimal precision, counter resets and missing samples.
These are offline tests. Verify fetch/VRF and DNS-list behavior on your RouterOS
version in a lab before production enrollment.

References: [RouterOS fetch](https://manual.mikrotik.com/docs/cli-reference/tool/fetch/),
[address lists](https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/address-lists/),
[DNS learning and FWD](https://manual.mikrotik.com/docs/network-management/dns/).
