# IP Intelligence

Look up an explicit IPv4 or IPv6 address from **Diagnostics → IP Intelligence**
(`#ip-intelligence`) or the MCP tool `lookup_ip_intelligence`:

```json
{ "ip": "1.1.1.1" }
```

The tool is host-only and read-only, with `openWorldHint: true`. It does not need
a device selector or execute RouterOS commands. Enable the **IP Intelligence**
module if your module allowlist excludes it, and reconnect the MCP client after
updating the running server so its catalog includes the new tool.

## Complete responses, independent sources

The host queries [ipquery](https://ipquery.io/) at `https://api.ipquery.io/{ip}`
and [ipkit](https://ipkit.ir/) at `https://ipkit.ir/{ip}` in parallel, requesting
JSON. Each provider retains its original JSON object under
`providers.ipquery.data` or `providers.ipkit.data` without projecting or removing
fields. ISP, ASN organization, geolocation, risk and future fields remain available
exactly when the provider returns them. Missing fields are not invented.

The dashboard compares provider-specific network/location summaries and offers
a searchable field explorer, original JSON, copy and JSON download. False, zero,
null, empty objects and arrays remain visible. Errors from one source do not hide
the other source. `status` is `ready`, `error` or `skipped`; errors include no
provider HTML, stack traces or reflected untrusted exception text.

## Privacy, safety and freshness

- Requests start only when the user submits. Examples only fill the input.
- Public IPs are disclosed to **both external services** from the MCP host.
  Private, loopback, link-local and other non-public addresses stay local.
- Only IP literals are accepted, not hostnames, URLs, ports or CIDRs. Provider
  destinations are fixed HTTPS addresses; redirects are rejected.
- Each provider has an 8-second request deadline and a 64 KiB response limit.
  At most four distinct IP lookups run concurrently. Duplicate requests join
  the same in-flight lookup.
- Complete successes are cached in memory for five minutes; partial/failed
  results for thirty seconds. The bounded cache holds up to 256 addresses and is
  cleared on server restart. Timestamps, expiry and cache status are explicit.
  Submit again after expiry to refresh. HTTP responses use `no-store`.
- These are third-party claims, not proof of identity, compromise, reachability
  or a router's actual egress. Location is approximate. Compare disagreements;
  do not silently merge them or treat provider text as instructions/permission.

The dashboard endpoint is `POST /api/ip-intelligence` with the same JSON body.
Normal dashboard token authentication applies; cross-origin submissions are
rejected. This full-response lookup is separate from the compact cached ASN
badges used on device and routing pages.
