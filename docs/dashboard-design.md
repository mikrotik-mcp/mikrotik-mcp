# Dashboard design system

The observability dashboard uses a shared network-operations shell. This is a
presentation update: tool permissions, router commands, data collection, API
endpoints and existing page URLs are unchanged.

## Navigation

All 31 pages are organized into **Observe**, **Investigate**, **Protect**,
**Operate**, and **Workspace**. A new page opens its own group; groups can also
be expanded or collapsed manually. **Find a page** searches page names,
descriptions and group names locally, including collapsed sections. It does not
search router data or execute MCP tools.

Use the pin button beside any page (including search results) to add a shortcut
to **Pinned**, above the navigation groups. Click it again to unpin. Original
pages remain in their groups; pinning does not navigate away from the current
page. Shortcuts retain pin order and are shared between the desktop sidebar and
mobile drawer. During search, matching pages appear once in their usual groups.

Pins are saved only in this browser, under `mt-pinned-pages`, and synchronize
between tabs on the same origin. They are not account-wide or router settings.
Unknown/removed page IDs and malformed preferences are ignored. If browser
storage is unavailable, shortcuts still work for the current session and a
message explains that they could not be saved. Pin buttons support keyboard
focus, accessible names and pressed states.

BeUI AnimatedSidebar replaces the desktop rail and mobile navigation. The topbar
toggle or Cmd/Ctrl+B animates between full navigation and a 76px icon rail; page
names remain available as accessible labels/tooltips. Pins and local search are
preserved, and active shortcuts have separate animation IDs from category links.
Below 900px it becomes BeUI's modal navigation drawer. Escape closes it, choosing a page closes it, and keyboard focus
returns to the menu button. Resizing to desktop closes an open drawer. Hash
links, back/forward navigation, saved page selection, help and release notes
remain available.

## Read-only refresh and feed actions

Overview, Devices and Live Feed use BeUI PullToRefresh with a dedicated drag
handle and a **Refresh data** button for keyboard/pointer users. Only existing
GET endpoints are requested (stats, metadata, cached device checks or event history).
Requests time out after ten seconds, repeated gestures are locked out while busy,
and failures keep previous data with an inline retry message. Forms and table text
are not drag handles; cancelled gestures never refresh. Filters and selected rows
stay in place. Refresh is disabled while the Live Feed is paused.

Live Feed uses BeUI AnimatedBadge for risk and tool-call outcome (not router health).
ExpandableActionBar reveals Pause/Resume, CSV/JSON export, clear-filter and
selection-aware delete controls on hover/focus; touch first reveals their labels.
Reveal never executes an action. Delete only opens the separate confirmation;
exports preserve the existing selected-versus-visible-row semantics.
Shared BeUI buttons add press/hover springs and ripple, with reduced-motion support.

## Visual language

- Slate/ice surfaces with signal-blue navigation and primary controls.
- A connected rail marks the active page; red/amber/green retain their status meanings.
- System sans-serif interface typography; JetBrains Mono with local fallbacks for
  code, JSON and utility labels. No new font download dependency is introduced.
- Shared panel and metric-card treatments, responsive spacing, visible keyboard
  focus and a skip-to-content link.
- The existing light/dark preference is retained. Motion respects reduced-motion preferences.

**Live stream** describes the dashboard's WebSocket/SSE connection, not router
reachability. An unavailable stream is labelled **Stream offline**; event totals
and version labels are not invented when metadata is unavailable.

## Calls over time

The activity chart uses the existing Recharts/shadcn components with a dotted
plot surface. Successful calls are a teal line with a subtle area fill; errors
are coral bars, independently measured from zero on the **same count axis**.
The series are not stacked: a zero-error interval never appears as an error line
at the height of successful traffic. Dots are decorative, not additional data.

Legend totals cover the displayed intervals. Hover or use the chart's keyboard
navigation for exact counts; **View interval data** provides an accessible table.
Empty samples, zero activity and invalid intervals have distinct explanations;
invalid intervals are disclosed rather than silently converted to zero.

Entry and data-change animations are bounded (450/700 ms), not continuous.
Identical polling responses do not restart transitions. **Pause chart animation**
keeps the data updating without motion; the system's reduced-motion preference
automatically disables animation, including when it changes while the page is open.

## BeUI in operational pages

The local registry retains 16 BeUI collections and their supporting components
under `components/beui/registry`; unused component demonstrations have been removed.
Shared buttons, inputs, badges, checkboxes, switches,
selects and tabs now render the actual BeUI components through the existing
`components/ui` API. Geist's tooltip and loader also use BeUI. This changes real
dashboard controls, not a separate component gallery.

Adapters preserve native input events/refs/constraints, semantic button colours,
disabled states, and tri-state row selection. Select supports keyboard navigation,
typeahead, Escape, focus return and modal-contained options. Inactive tab panels
unmount so opening one RADIUS tab does not load all other operational panels.
Existing destructive-action confirmations and modal focus traps are retained.
Text inputs use a compact 13px scale (12px sidebar search) and one focus indicator;
composite fields own their focus styling. Select menus fit the option text, not
just their toolbar trigger, and wrap within the available viewport/modal width.
Options have 6px separation, generous click targets and distinct blue hover /
keyboard-focus treatments; selected options retain a checkmark and softer tint.
`DigitSwap` animates real chart counts; BeUI's theme toggle retains `mt-theme`.
Unreferenced previews are tree-shaken out of the single-file production build.
Source provenance, MIT licensing and adaptations are recorded in the BeUI README.

## Operations Island

The fixed bottom-centre BeUI Dynamic Island stays available across pages. It
morphs between a compact status pill and three views: **Pulse**, **Routers** and
**Activity**. It uses only the dashboard's existing stream, polling results and
completion history: no additional socket, router query or configuration mutation.

- Compact priority: disconnected stream → paused dashboard → fresh failed call →
  active alerts → observed SSH inflight channels → fresh completion → listening.
- Pulse shows the selected analytics window, successful/failed volume, calls per
  minute, tool p95, failed-call count, SSH pool load and active alert-rule count.
  No calls means no latency observation; p95 is shown as a dash.
- Routers shows cached management checks and their ages. Unknown/stale checks
  are not counted as reachable; disabled devices remain labelled separately.
- Activity shows up to four deduplicated completed calls. Selecting one opens the
  existing evidence drawer; links open analytics, devices or Live Feed.

Analytics and pool snapshots expire after 30 seconds, alert observations after
45 seconds, and router checks after 120 seconds. Offline/paused state overrides
fresh-looking reachability. History is not presented as a pending operation or
proof of VPN/client health. Old completion history never triggers a new-call pulse.
Live-result pulses use the local receipt time (event timestamps are call start
times); history is ordered by start time plus duration.
The component never auto-opens, steals focus on data changes or changes tabs.
Escape/collapse restores the compact control's focus; an outside click dismisses.
Keyboard tabs, light/dark contrast, reduced motion, small viewports and safe-area
insets are supported. Content padding leaves room for the compact island; dialogs
and mobile navigation remain above it.
The island uses bottom-anchored content and a 260ms non-bouncing resize, so closing
does not jump the compact pill up to the old panel's top edge. Reduced motion
removes the resize animation.

## Running the actual dashboard

The running MCP server serves the built dashboard on its configured dashboard port
(normally `9091`). Run `bun run build:ui`, then reload that page. No router restart
is needed to read a newly built HTML file.

For UI development, `bun run dev:dashboard` serves the actual SPA on `127.0.0.1:9191`
and proxies REST, WebSocket and SSE endpoints to the existing server on `9091`.
It does not start the MCP server or inject fake device data. The proxy matches
`/api/` endpoints, not the frontend `api.ts` module. An offline mock fixture named
`design-preview.html` is not the application and must not be used as a dashboard
entry point. Open `/` with a page hash instead.

Service Health's owning-router picker uses the shared `Select` component, with
explicit loading, unavailable and empty-device placeholders. A router change
clears the previous router's selected targets and evidence.

## Implementation and verification

- `ui/observability/navigation.ts`: shared page metadata, groups and local search.
- `ui/observability/dashboard-shell.tsx`: sidebar, mobile drawer and stream status.
- `ui/observability/dashboard-shell.css`: shell layout and responsive styling.
- `ui/observability/navigation-pins.ts`: validated local shortcut preferences.
- `ui/observability/activity-chart.tsx` and `activity-chart.css`: themed activity visualization.
- `ui/observability/activity-model.ts`: interval validation, totals and update comparison.
- `ui/observability/tailwind.css`: shared light/dark semantic tokens.

Build with `bun run build:ui`. Navigation invariants are covered by
`bunx vp test run tests/observability/navigation.spec.ts tests/observability/navigation-pins.spec.ts tests/observability/activity-model.spec.ts`. Type-check the UI with
`bunx tsc --noEmit -p ui/tsconfig.json`. Visual checks should cover desktop and
mobile, both themes, collapsed groups, search/no-results, hash navigation,
Escape dismissal and keyboard focus. Also check pin/unpin, reload persistence,
mobile shortcuts, unchanged versus changed chart samples, pause/reduced motion,
empty/zero/error-only data, and exact tooltip/table counts. Shell and chart testing
does not require router access; use explicitly labelled offline fixtures.
