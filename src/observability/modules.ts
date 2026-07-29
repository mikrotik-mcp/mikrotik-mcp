/**
 * Tool-module surface helpers for the dashboard's Modules page.
 *
 * The dashboard lets you see every catalog module and toggle each one on/off,
 * persisting the choice to the config file's `tools` block. Two pure functions
 * back that page:
 *   • {@link moduleSurface} — every module with its live enabled/disabled state.
 *   • {@link applyModuleToggle} — a new `tools` filter with one module flipped.
 *
 * Both mirror `selectToolModules` (src/tools/index.ts) exactly, so the checkbox
 * the user sees always matches the surface the MCP server would actually
 * register. They are pure (no I/O) so the route stays a thin persistence wrapper
 * and the semantics are unit-testable.
 */
import type { ToolFilter } from "../config";
import { ALWAYS_ON_MODULES, moduleCatalog } from "../tools";
import type { ModuleInfo } from "../tools";
import { explainUnmet } from "../core/capability";
import type { ToolRequires } from "../core/capability";
import { peekCapabilities } from "../core/capability-cache";
import { getConfig } from "../core/runtime";

/**
 * Devices already known to fail `requires`, with the reason.
 *
 * Reads only resolved probes — an unprobed device is omitted rather than
 * reported as unsupported, so this never claims a device cannot do something on
 * no evidence.
 */
function unsupportedDevices(requires: ToolRequires): { device: string; reason: string }[] {
  const out: { device: string; reason: string }[] = [];
  for (const name of Object.keys(getConfig().devices)) {
    const caps = peekCapabilities(name);
    if (!caps) continue;
    const reason = explainUnmet(caps, requires);
    if (reason) out.push({ device: name, reason });
  }
  return out;
}

export interface ModuleSurfaceItem {
  slug: string;
  label: string;
  group: string;
  description: string;
  toolCount: number;
  /** True when this module would register under the current `tools` filter. */
  enabled: boolean;
  /**
   * Devices this module's tools cannot run on, with the reason — computed from
   * probes that have ALREADY resolved, so this is empty until a device has been
   * probed. Absence means "not known to be unsupported", never "supported".
   */
  unsupported?: { device: string; reason: string }[];
}

export interface ModuleSurface {
  modules: ModuleSurfaceItem[];
  /** Number of modules in the catalog. */
  total: number;
  /** Modules currently exposed. */
  enabledModules: number;
  /** Tools currently exposed (sum of enabled modules' tool counts). */
  enabledTools: number;
  /** Tools in the full catalog. */
  totalTools: number;
  /**
   * True when an allow-list is in force (any `enabledModules`/`enabledGroups`).
   * In that mode, unlisted modules are hidden — useful context for the UI.
   */
  hasAllowList: boolean;
}

const lcSet = (xs?: string[]): Set<string> => new Set((xs ?? []).map((s) => s.toLowerCase()));

/**
 * Whether a module is exposed under `filter` — the exact predicate
 * `selectToolModules` applies (deny-lists win; a non-empty allow-list gates).
 */
export function isModuleEnabled(filter: ToolFilter, slug: string, group: string): boolean {
  const enabledModules = lcSet(filter.enabledModules);
  const disabledModules = lcSet(filter.disabledModules);
  const enabledGroups = lcSet(filter.enabledGroups);
  const disabledGroups = lcSet(filter.disabledGroups);
  const hasAllow = enabledModules.size > 0 || enabledGroups.size > 0;
  const s = slug.toLowerCase();
  const g = group.toLowerCase();
  if (disabledModules.has(s) || disabledGroups.has(g)) return false;
  // The tool gateway bypasses the allow-list gate (mirrors selectToolModules),
  // so the dashboard shows it as on unless explicitly disabled above.
  if (ALWAYS_ON_MODULES.has(s)) return true;
  if (hasAllow && !(enabledModules.has(s) || enabledGroups.has(g))) return false;
  return true;
}

/** Build the full module list with each module's live enabled/disabled state. */
export function moduleSurface(
  filter: ToolFilter,
  catalog: ModuleInfo[] = moduleCatalog,
): ModuleSurface {
  const modules = catalog.map((m) => {
    // A module's requirement is uniform across its tools (they are applied with
    // `withRequires`), so the first declaring tool speaks for the module.
    const requires = m.tools.find((t) => t.requires)?.requires;
    const unsupported = requires ? unsupportedDevices(requires) : [];
    return {
      slug: m.slug,
      label: m.label,
      group: m.group,
      description: m.description,
      toolCount: m.tools.length,
      enabled: isModuleEnabled(filter, m.slug, m.group),
      ...(unsupported.length > 0 ? { unsupported } : {}),
    };
  });
  const hasAllowList =
    (filter.enabledModules?.length ?? 0) > 0 || (filter.enabledGroups?.length ?? 0) > 0;
  return {
    modules,
    total: modules.length,
    enabledModules: modules.filter((m) => m.enabled).length,
    enabledTools: modules.reduce((n, m) => n + (m.enabled ? m.toolCount : 0), 0),
    totalTools: modules.reduce((n, m) => n + m.toolCount, 0),
    hasAllowList,
  };
}

/**
 * Return a new `tools` filter with `slug` flipped to `enabled`. Pure — neither
 * the input nor the catalog is mutated. Operates on the module allow/deny lists
 * only (group lists pass through untouched), matching the user's mental model:
 *   • disable → add the slug to `disabledModules` (deny wins, so it's always
 *     hidden) and drop it from `enabledModules` (tidy under allow-list mode).
 *   • enable  → drop the slug from `disabledModules`; and when an allow-list is
 *     in force (so unlisted modules would stay hidden), add it to
 *     `enabledModules` so it actually surfaces.
 *
 * Idempotent: toggling to a state the filter already yields returns an
 * equivalent filter (no duplicate entries).
 */
export function applyModuleToggle(filter: ToolFilter, slug: string, enabled: boolean): ToolFilter {
  const eq = (x: string): boolean => x.toLowerCase() === slug.toLowerCase();
  let enabledModules = [...(filter.enabledModules ?? [])];
  let disabledModules = [...(filter.disabledModules ?? [])];
  const enabledGroups = [...(filter.enabledGroups ?? [])];
  const disabledGroups = [...(filter.disabledGroups ?? [])];
  const hasAllow = enabledModules.length > 0 || enabledGroups.length > 0;

  if (enabled) {
    disabledModules = disabledModules.filter((x) => !eq(x));
    if (hasAllow && !enabledModules.some(eq)) enabledModules.push(slug);
  } else {
    enabledModules = enabledModules.filter((x) => !eq(x));
    if (!disabledModules.some(eq)) disabledModules.push(slug);
  }
  return { enabledModules, disabledModules, enabledGroups, disabledGroups };
}
