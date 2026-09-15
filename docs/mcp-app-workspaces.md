# MCP App workspaces

MCP App Views display a tool's result inside a compatible client's sandboxed iframe.
They are separate from the observability dashboard. Enable `mcp.appViews` (enabled
by default) and use a client that supports MCP Apps. Text results remain available
to clients without a graphical host.

## Workspaces

The server ships 13 views. Device health, searchable records, interfaces, firewall
rules, firewall audit, connected devices and RADIUS/User Manager share the same
responsive visual system. Six additional workspaces cover newer tool families:

| Workspace      | Representative tools                                                       | What it displays                                                                                                                          |
| -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Investigations | `get_investigation`, `inspect_flow_path`                                   | Historical case evidence, client/router/destination scope, or exported ingress/egress branches with exact interface names when available. |
| Round-trip lab | `trace_round_trip`                                                         | Separate forward/return columns, numbered hops, interface pairs, modelled/blocked/unknown outcomes and snapshot provenance.               |
| Service health | `run_service_contract`, `service_contract_history`                         | Approved endpoint checks, latency, per-check results and historical runs.                                                                 |
| L2 fabric      | `map_l2_fabric`, `locate_host_port`                                        | Port cards, learned hosts, bridge membership and inferred roles; host lookup details.                                                     |
| Operations     | `plan_changes`, transaction tools, `rollout_status`, `get_access_scope`    | Existing operation results, plan evidence, scope and recovery information.                                                                |
| Reports        | `diagnose`, security/compliance auditors, simulation and explanation tools | Readable report sections, structured fields, expandable evidence and original text.                                                       |

The complete explicit mapping lives in `src/core/report-views.ts`. Other eligible
read tools continue to use the generic records viewer. Existing explicit views
take precedence over automatic mappings.

## Reading evidence

- The initial investigation diagram shows the declared scope, **not** a captured
  packet route. `inspect_flow_path` can name exported interfaces when mapping data
  exists; absent exports do not identify a blocking hop.
- A round-trip result is an offline snapshot simulation. **MODELLED** does not prove
  delivery; **UNKNOWN** stays unresolved. A **BLOCKED** hop is a model result.
- Service probes originate from the MCP host, not the client or router. A saved
  successful run is historical evidence, not a current availability guarantee.
- Fabric roles are inferred. Multiple learned hosts can be behind another switch;
  they are not necessarily physically attached to the displayed port.
- Transactions are best-effort across routers. A **PARTIAL** result still requires
  the recovery steps reported by the tool.

## Interaction and layout

Search examines the original evidence, so filtering does not masquerade as a full
path. Expand individual records or the original result to inspect colored JSON.
Copy preserves the tool text; JSON export preserves the complete data even when
the on-screen JSON preview is bounded. Large collections progressively reveal more
rows. Grids collapse on narrow screens and wide tables scroll within their panels.
Host theme/fonts are respected, with local light/dark fallbacks and reduced-motion
support. Fonts and icons require no external network fetches.

The six new workspaces are **result-only**: opening, searching, copying or exporting
does not invoke a tool, run a probe, apply a plan or commit a transaction. Existing
interactive views retain their established controls and authorization checks.

## Build and compatibility

Run `bun run build:ui` to produce self-contained `dist/ui/<id>.html` resources.
Tool UI metadata and resource registration share the same view IDs. Existing
structured-result contracts are retained: when a tool already returns structured
data, presentation metadata is added separately for the host rather than replacing
that data. Disabling `mcp.appViews` removes App metadata without changing tool risk
or execution permissions.

Tests under `tests/mcp-apps/` validate catalog coverage, host result delivery,
entrypoints and evidence rendering using synthetic data. They do not connect to
routers or establish that a particular third-party host displays every view.
