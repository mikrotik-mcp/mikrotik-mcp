# BeUI dashboard components

Official registry: https://beui.dev/r (retrieved 2026-09-14).
Upstream: https://github.com/starc007/ui-components. MIT license: `LICENSE`.
The UI build embeds this license into the self-contained dashboard HTML.

The local registry retains **16 collections** (17 component source files),
including shared component dependencies, after removing unused component demos.
`registry-manifest.json` records the retained collections' URLs, upstream update
dates and file paths. Internal imports are namespaced and shared files deduplicated.
Tests compare installed component files with the manifest to catch stale references.

## Operational integration

The shared `components/ui` adapters render BeUI Button, Input, AnimatedBadge,
Checkbox, Switch, Select and Tabs. Existing dashboard call sites retain their
semantic colours, events, refs, validation constraints and controlled state.
Geist's Tooltip and Spinner use BeUI Tooltip and Loader. The shell uses BeUI's
ThemeToggle with the existing `mt-theme` preference. The chart uses `DigitSwap`.
Shared buttons enable BeUI's press/hover spring and ripple. The dashboard uses
AnimatedSidebar with an icon rail and mobile drawer, keeping page search and pins.
Live Feed uses AnimatedBadge for call risk/result and ExpandableActionBar for
pause, export, filter clearing and selection-aware deletion requests. The separate
delete confirmation remains mandatory. PullToRefresh powers explicit read-only
refresh handles in Overview, Devices and Live Feed, with a keyboard button too.

`operations-island.tsx` uses DynamicIsland and DynamicIslandView as a fixed
cross-page companion with Pulse, Routers and Activity views. It consumes the
existing dashboard data, never opens an extra socket and never queries or changes
a router. Its pure evidence/freshness model is covered by offline tests.

There is no Component Lab route or demonstration gallery. Components are used in
the actual product. Existing modal focus traps and destructive-action confirmations
are retained; demonstration payment/approval actions are never wired to MCP tools.

## Local adaptations

- Input bridges native React change events for existing forms and supports file inputs.
  The shared adapter uses compact 13px text; the field owns focus so the shell
  does not add a second outline to its inner input.
- Checkbox preserves indeterminate state, external labels and pointer metadata.
- Switch forwards native button props and labels.
- Select preserves registered React labels; adds keyboard/typeahead navigation,
  disabled-option skipping, Escape, focus return, viewport placement and a portal
  inside the trigger's modal focus scope when applicable.
  Menus fit their option labels independently of trigger width, stay inside
  viewport/modal bounds, and wrap unusually long labels rather than clipping them.
- Tabs adds ARIA relationships/keyboard navigation and unmounts inactive panels,
  avoiding eager router reads from hidden operational panels.
- AnimatedSidebar follows the dashboard's 900px breakpoint, skips hidden focus
  targets, retains modified link clicks and scopes duplicate active pin highlights.
- PullToRefresh supports handle-only gestures, excludes interactive descendants,
  cancels without running refresh and handles rejected refresh promises.
- ExpandableActionBar preserves keyboard focus and names icon-only actions.
- DynamicIsland can disable its full-content live region in favour of the
  dashboard's concise status announcement. Its bottom anchor keeps compact
  content pinned to the baseline during a 260ms, non-bouncing resize.
- Number primitives avoid effect-driven state updates, resume interrupted values,
  and respect reduced motion. The chart offers an explicit motion pause.
- Source formatting and callback/context declarations follow repository lint rules.
  Upstream advisory warnings remain visible; the registry is not excluded.

The component dependency packages are build-time UI dependencies, not device
transport dependencies. All production assets still inline into the dashboard HTML.

Verification:
`bunx vp test run tests/observability/beui.spec.ts tests/observability/beui-controls.spec.ts tests/observability/operations-island.spec.ts`
and `bunx tsc --noEmit -p ui/tsconfig.json`, then `bun run build:ui`.
DOM tests use Motion's JavaScript fallback because Happy DOM's partial Web
Animations API rejects cancelled animations; real motion is browser-checked.
