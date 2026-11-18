import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { animate, createScope } from "animejs";
import type { Scope } from "animejs";
import type { TipCard } from "./kit";
import { Check, ChevronDown, Ellipsis, RefreshCw, X } from "lucide-react";
import { api, postJson } from "./api";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  MonitorSearch,
  MonitorSelect,
  MonitorSwitch,
  PageIntro,
  StatusBadge,
} from "./monitoring-ui";
import { toast } from "./toast-action";
import { DUR, DetailList, EASE, RowDrawer, RowMenu, RowMore, tipProps } from "./kit";
import "./monitoring.css";
import "./modules.css";

// ── Tool Modules view ────────────────────────────────────────────────────────
// Every catalog module with a live on/off toggle. Flipping one writes the
// config file's `tools` block (added to disabledModules / enabledModules) and
// applies it live; the MCP client must reconnect for the tool list to change.

interface ModuleItem {
  slug: string;
  label: string;
  group: string;
  description: string;
  toolCount: number;
  enabled: boolean;
  /** Devices already known to fail this module's requirements, with the reason. */
  unsupported?: { device: string; reason: string }[];
}
interface ConfigSource {
  path: string;
  fromFile: boolean;
}
interface ModuleSurface {
  modules: ModuleItem[];
  total: number;
  enabledModules: number;
  enabledTools: number;
  totalTools: number;
  hasAllowList: boolean;
  source?: ConfigSource;
  appViews?: boolean;
}
interface ToggleResult extends ModuleSurface {
  ok?: boolean;
  persisted?: boolean;
  warning?: string;
  error?: string;
}

/** The tool count the MCP client handles well: below this band every tool is findable. */
const TARGET_LOW = 150;
const TARGET_HIGH = 200;
/** Groups listed in the "Modules on, by group" panel. */
const GROUP_BARS = 10;

function useNarrow(query = "(max-width: 639px)"): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = (): void => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/**
 * Exposed tools against the catalog, with the 150–200 target band marked.
 * The fill sweeps to its value.
 */
function SurfaceMeter({ exposed, total }: { exposed: number; total: number }): ReactNode {
  const root = useRef<SVGSVGElement>(null);
  const scope = useRef<Scope | null>(null);
  const w = 400;
  const x = (v: number): number => Math.round((Math.min(v, total) / (total || 1)) * w * 10) / 10;
  const fill = x(exposed);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({
      root: root as unknown as RefObject<HTMLElement | null>,
      mediaQueries: { reduceMotion: "(prefers-reduced-motion: reduce)" },
    }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate("[data-fill]", { width: [0, fill], duration: DUR.draw, ease: EASE.enter });
    });
    return () => scope.current?.revert();
  }, [fill]);
  const label = Math.max(fill, 70);
  const over = exposed > TARGET_HIGH;
  const card = (): TipCard => ({
    title: "Exposed tools",
    sub: `of ${total} in the catalog`,
    led: over ? "warn" : "ok",
    rows: [
      { label: "Exposed", value: `${exposed} tools`, color: "var(--sig)" },
      { label: "Catalog", value: `${total} tools` },
      { label: "Target", value: `${TARGET_LOW}–${TARGET_HIGH} tools`, color: "var(--brand)" },
    ],
    foot: over
      ? { label: "Over the target by", value: `${exposed - TARGET_HIGH} tools`, tone: "down" }
      : { label: "Room left", value: `${TARGET_HIGH - exposed} tools`, tone: "up" },
  });
  return (
    <svg
      ref={root}
      className="kit-tips"
      viewBox={`0 -6 ${w} 54`}
      width="100%"
      role="img"
      aria-label={`${exposed} of ${total} tools exposed`}
      {...tipProps(card)}
    >
      <rect x="0" y="14" width={w} height="12" rx="6" fill="var(--line)" />
      <rect
        data-fill
        x="0"
        y="14"
        width={fill}
        height="12"
        rx="6"
        fill="var(--sig)"
        opacity=".85"
      />
      <rect
        x={x(TARGET_LOW)}
        y="8"
        width={Math.max(x(TARGET_HIGH) - x(TARGET_LOW), 4)}
        height="24"
        rx="4"
        fill="none"
        stroke="var(--brand)"
        strokeDasharray="3 3"
      />
      <text
        x={x((TARGET_LOW + TARGET_HIGH) / 2)}
        y="44"
        textAnchor="middle"
        fontSize="10"
        fill="var(--brand)"
      >
        {TARGET_LOW}–{TARGET_HIGH} target
      </text>
      <text x={label} y="5" textAnchor="end" fontSize="10" fill="var(--success)">
        {exposed} exposed
      </text>
    </svg>
  );
}

/** One module: switch, name, slug, scope, tool count. */
function ModuleCard({
  m,
  busy,
  onToggle,
  unmet,
}: {
  m: ModuleItem;
  busy: boolean;
  onToggle: (slug: string, enabled: boolean) => void;
  /** Dim + explain when this module cannot run on the selected device. */
  unmet?: string;
}): ReactNode {
  return (
    <label
      className="modules-card"
      data-on={m.enabled || undefined}
      data-unmet={unmet ? true : undefined}
      title={unmet ? `Unavailable on the selected device: ${unmet}` : m.description}
    >
      <span className="mt-px">
        <MonitorSwitch
          checked={m.enabled}
          disabled={busy}
          label={m.label}
          onChange={() => onToggle(m.slug, !m.enabled)}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex flex-wrap items-center gap-2">
          <b className="text-[13px] font-semibold text-foreground">{m.label}</b>
          <span className="monitor-chip">{m.slug}</span>
        </span>
        <span className="monitor-hint">{m.description}</span>
        {unmet && <span className="text-[11px] text-warning">Unavailable here: {unmet}</span>}
      </span>
      <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
        {m.toolCount} tool{m.toolCount === 1 ? "" : "s"}
      </span>
    </label>
  );
}

/** List every module grouped by scope, with per-module and bulk on/off toggles. */
export function ModulesView(): ReactNode {
  const [data, setData] = useState<ModuleSurface | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [appViews, setAppViews] = useState<boolean>(false);
  const [appViewsBusy, setAppViewsBusy] = useState(false);
  // The App Views value the server started with: a change needs a restart.
  const [appViewsAtLoad, setAppViewsAtLoad] = useState<boolean | null>(null);
  // Which device to judge module availability against. Empty = judge none, which
  // is the honest default: capabilities are per-device and may not be probed yet.
  const [capDevice, setCapDevice] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The open "unavailable" row, kept per device so a new device starts closed.
  const [unavailSel, setUnavailSel] = useState<{ device: string; i: number }>();
  const unavailRow = unavailSel?.device === capDevice ? unavailSel.i : undefined;
  const setUnavailRow = (i: number | undefined): void =>
    setUnavailSel(i === undefined ? undefined : { device: capDevice, i });
  const phone = useNarrow();
  // Only devices that some module reports on are offerable — a device with no
  // resolved probe contributes no `unsupported` entries, so selecting it would
  // dim nothing and imply everything is supported.
  const capDevices = useMemo(
    () =>
      [
        ...new Set((data?.modules ?? []).flatMap((m) => m.unsupported?.map((u) => u.device) ?? [])),
      ].sort(),
    [data],
  );

  const load = useCallback(() => {
    void api<ModuleSurface>("/api/modules")
      .then((d) => {
        setData(d);
        if (d.appViews !== undefined) {
          setAppViews(d.appViews);
          setAppViewsAtLoad((v) => v ?? d.appViews ?? null);
        }
      })
      .catch(() => setMsg("could not load modules"));
  }, []);
  useEffect(() => load(), [load]);

  // Apply a toggle result (or the initial load) into state, keeping the surface
  // counts and every module's enabled flag in sync with the server's answer.
  const adopt = (r: ModuleSurface): void => setData((prev) => (prev ? { ...prev, ...r } : r));

  const toggle = useCallback(
    async (slug: string, enabled: boolean): Promise<void> => {
      setBusy((s) => new Set(s).add(slug));
      // Optimistic flip so the switch responds instantly.
      setData((prev) =>
        prev
          ? { ...prev, modules: prev.modules.map((m) => (m.slug === slug ? { ...m, enabled } : m)) }
          : prev,
      );
      const r = await postJson<ToggleResult>("/api/modules/toggle", { slug, enabled }).catch(
        (): ToggleResult => ({ error: "request failed" }) as ToggleResult,
      );
      setBusy((s) => {
        const next = new Set(s);
        next.delete(slug);
        return next;
      });
      if (r.error || r.ok === false) {
        setMsg(r.error ?? "toggle failed");
        toast.error(r.error ?? "Toggle failed");
        load(); // resync from the server (undo the optimistic flip)
        return;
      }
      adopt(r);
      const where = r.persisted ? "saved to config" : "applied live (not saved)";
      const warn = r.warning ? ` ⚠ ${r.warning}` : "";
      setMsg(
        `${slug} ${enabled ? "enabled" : "disabled"} — ${where}. Reconnect the MCP client ` +
          `(or restart the server) for the tool list to update.${warn}`,
      );
      toast.success(`Module ${enabled ? "enabled" : "disabled"}`);
    },
    [load],
  );

  // Bulk enable/disable by toggling each one whose state differs from the
  // target — sequentially so each write lands on the prior result's filter.
  const bulk = useCallback(
    async (slugs: string[], enabled: boolean): Promise<void> => {
      for (const slug of slugs) await toggle(slug, enabled);
    },
    [toggle],
  );

  const toggleAppViews = useCallback(async (enabled: boolean): Promise<void> => {
    setAppViewsBusy(true);
    setAppViews(enabled);
    const r = await postJson<{
      ok?: boolean;
      persisted?: boolean;
      warning?: string;
      error?: string;
      appViews?: boolean;
    }>("/api/modules/app-views", { enabled }).catch(() => ({ error: "request failed" }));
    setAppViewsBusy(false);
    if ("error" in r && r.error) {
      setMsg(r.error);
      toast.error(r.error);
      setAppViews(!enabled);
      return;
    }
    if ("appViews" in r && r.appViews !== undefined) setAppViews(r.appViews);
    const where = "persisted" in r && r.persisted ? "saved to config" : "applied live (not saved)";
    const warn = "warning" in r && r.warning ? ` — ${r.warning}` : "";
    setMsg(
      `App views ${enabled ? "enabled" : "disabled"} — ${where}. ` +
        `Restart the server for the change to take effect.${warn}`,
    );
    toast.success(`App Views ${enabled ? "enabled" : "disabled"}`);
  }, []);

  const groups = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const match = (m: ModuleItem): boolean =>
      !q ||
      m.slug.toLowerCase().includes(q) ||
      m.label.toLowerCase().includes(q) ||
      m.group.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q);
    const byGroup = new Map<string, ModuleItem[]>();
    for (const m of data.modules) {
      if (!match(m)) continue;
      const arr = byGroup.get(m.group) ?? [];
      arr.push(m);
      byGroup.set(m.group, arr);
    }
    return [...byGroup.entries()].map(([group, modules]) => ({ group, modules }));
  }, [data, query]);

  const groupBars = useMemo(() => {
    const byGroup = new Map<string, { n: number; on: number }>();
    for (const m of data?.modules ?? []) {
      const g = byGroup.get(m.group) ?? { n: 0, on: 0 };
      g.n += 1;
      if (m.enabled) g.on += 1;
      byGroup.set(m.group, g);
    }
    return [...byGroup.entries()]
      .map(([group, g]) => ({ group, ...g }))
      .sort((a, b) => b.n - a.n || a.group.localeCompare(b.group));
  }, [data]);

  if (!data) return <LoadingState label="Loading modules" layout="cards" />;

  const shown = groups.reduce((n, g) => n + g.modules.length, 0);
  const over = data.enabledTools > TARGET_HIGH;
  const hidden = data.total - data.enabledModules;
  const appViewsChanged = appViewsAtLoad !== null && appViews !== appViewsAtLoad;
  const unavailable = capDevice
    ? data.modules.flatMap((m) =>
        (m.unsupported ?? [])
          .filter((u) => u.device === capDevice)
          .map((u) => ({ slug: m.slug, reason: u.reason })),
      )
    : [];
  const unavailItem = unavailRow === undefined ? undefined : unavailable[unavailRow];
  const unavailModule = unavailItem
    ? data.modules.find((m) => m.slug === unavailItem.slug)
    : undefined;
  const enableAll = (): void =>
    void bulk(
      data.modules.filter((m) => !m.enabled).map((m) => m.slug),
      true,
    );
  const disableAll = (): void =>
    void bulk(
      data.modules.filter((m) => m.enabled).map((m) => m.slug),
      false,
    );
  const availability =
    capDevices.length > 0 ? (
      <MonitorSelect
        label="Module availability by probed device"
        value={capDevice}
        onChange={setCapDevice}
        options={[
          { value: "", label: phone ? "All routers" : "Availability: all devices" },
          ...capDevices.map((d) => ({ value: d, label: phone ? d : `Availability: ${d}` })),
        ]}
      />
    ) : null;
  const meter = (
    <div className="glass modules-meter">
      <div className="flex items-center gap-2">
        <b className="text-[13px] font-semibold text-foreground">Exposed tools</b>
        <span className="flex-1" />
        <span className="font-mono text-xs text-muted-foreground">
          {data.enabledTools} / {data.totalTools}
        </span>
      </div>
      <SurfaceMeter exposed={data.enabledTools} total={data.totalTools} />
      <span className="monitor-hint modules-phone-hide">
        Writes to{" "}
        <span className="font-mono text-fg-secondary">{data.source?.path ?? "config file"}</span> ·{" "}
        <span className="font-mono">tools.disabledModules</span> ·{" "}
        {data.hasAllowList ? "allow-list active" : "all modules on by default"}
      </span>
    </div>
  );

  return (
    <div className="modules-page flex min-w-0 flex-col gap-[18px]">
      <PageIntro
        eyebrow="Tool surface"
        verdict={
          <>
            {data.enabledTools} tools exposed.{" "}
            {over ? (
              <span className="w">Aim for {TARGET_HIGH}.</span>
            ) : (
              <span className="s">On target.</span>
            )}
          </>
        }
        lead={
          phone
            ? `Below about ${TARGET_LOW}–${TARGET_HIGH} tools the client finds every tool reliably. Reconnect the client after a change.`
            : `Turn a module off to hide all of its tools. Below about ${TARGET_LOW}–${TARGET_HIGH} tools the MCP client finds every remaining tool reliably. Clients must reconnect to see a change.`
        }
        actions={
          phone ? undefined : (
            <>
              <MonitorButton icon={<Check aria-hidden="true" />} onClick={enableAll}>
                Enable all
              </MonitorButton>
              <MonitorButton icon={<X aria-hidden="true" />} onClick={disableAll}>
                Disable all
              </MonitorButton>
              <MonitorButton variant="ghost" icon={<RefreshCw aria-hidden="true" />} onClick={load}>
                Refresh
              </MonitorButton>
            </>
          )
        }
        aside={phone ? undefined : meter}
      />
      {phone && meter}
      <MetricStrip label="Tool surface" minCell={phone ? 140 : 200}>
        <Metric
          label="Modules on"
          tone="good"
          value={
            <>
              {data.enabledModules}
              <small>/{data.total}</small>
            </>
          }
          hint={phone ? `${hidden} hidden` : `${hidden} hidden from the client`}
        />
        {!phone && (
          <Metric
            label="Tools exposed"
            tone={over ? "warn" : "good"}
            value={
              <>
                {data.enabledTools}
                <small>/{data.totalTools}</small>
              </>
            }
            hint={`Target: ${TARGET_LOW}–${TARGET_HIGH}`}
          />
        )}
        {!phone && (
          <Metric
            label="Allow-list"
            value={data.hasAllowList ? "On" : "Off"}
            hint={
              data.hasAllowList ? "Only listed modules are on" : "All modules on unless disabled"
            }
          />
        )}
        <Metric
          label="App Views"
          value={appViews ? "On" : "Off"}
          hint={
            appViewsChanged
              ? phone
                ? "Restart to apply"
                : "Changed · restart to apply"
              : "A change needs a restart"
          }
        />
      </MetricStrip>
      <div className="modules-layout">
        {!phone && (
          <div className="flex min-w-0 flex-col gap-3.5">
            <MonitorPanel
              title="Modules on, by group"
              description="Where the tool surface comes from."
            >
              <div className="kit-tips flex flex-col gap-[11px]">
                {groupBars.slice(0, GROUP_BARS).map((g) => (
                  <div
                    key={g.group}
                    className="modules-bar-row"
                    {...tipProps(() => ({
                      title: g.group,
                      sub: "modules",
                      rows: [
                        { label: "On", value: g.on, color: "var(--sig)" },
                        { label: "Off", value: g.n - g.on },
                        { label: "Total", value: g.n },
                      ],
                      foot: { label: "Share on", value: `${Math.round((g.on / g.n) * 100)}%` },
                      action: { label: `Show only ${g.group}`, onClick: () => setQuery(g.group) },
                    }))}
                  >
                    <span className="truncate text-fg-secondary">{g.group}</span>
                    <span className="modules-bar" aria-hidden="true">
                      <i style={{ width: `${(g.on / g.n) * 100}%` }} />
                    </span>
                    <span className="text-right text-muted-foreground tabular-nums">
                      {g.on}/{g.n}
                    </span>
                  </div>
                ))}
              </div>
              {groupBars.length > GROUP_BARS && (
                <p className="monitor-hint mt-3">
                  {groupBars.length - GROUP_BARS} smaller groups not shown.
                </p>
              )}
            </MonitorPanel>
            {capDevice && (
              <MonitorPanel
                title={`Unavailable on ${capDevice}`}
                description="From the last capability probe. Dimmed in the list."
                flush
              >
                <div className="monitor-thead modules-unavail">
                  <span>Module</span>
                  <span>Reason</span>
                  <span />
                </div>
                {unavailable.map((u, i) => (
                  <RowMenu
                    key={u.slug}
                    title={u.slug}
                    sub={`Unavailable on ${capDevice}`}
                    onOpen={() => setUnavailRow(i)}
                    cells={{
                      module: { value: u.slug, kind: "id", search: () => setQuery(u.slug) },
                      reason: { value: u.reason },
                    }}
                    copies={[{ label: "Module slug", value: u.slug }]}
                    row={u}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${u.slug}, ${u.reason}`}
                      className="monitor-row modules-unavail cursor-pointer"
                      data-selected={unavailRow === i || undefined}
                      onClick={() => setUnavailRow(i)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setUnavailRow(i);
                        }
                      }}
                    >
                      <span data-col="module" className="p truncate font-mono text-xs">
                        {u.slug}
                      </span>
                      <span data-col="reason" className="truncate text-warning">
                        {u.reason}
                      </span>
                      <RowMore />
                    </div>
                  </RowMenu>
                ))}
              </MonitorPanel>
            )}
          </div>
        )}
        <MonitorPanel
          title="Tool modules"
          description={`${data.enabledModules}/${data.total} modules · ${data.enabledTools}/${data.totalTools} tools exposed`}
          className="modules-list-panel"
        >
          <div className="flex flex-col gap-3.5">
            <label
              className="modules-card modules-appviews"
              data-on={appViews || undefined}
              title="Emit MCP App view metadata (_meta.ui) on read tools"
            >
              <span className="mt-px">
                <MonitorSwitch
                  checked={appViews}
                  disabled={appViewsBusy}
                  label="MCP App Views"
                  onChange={() => void toggleAppViews(!appViews)}
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <b className="text-[13px] font-semibold text-foreground">MCP App Views</b>
                <span className="monitor-hint">
                  Read tools send interactive table and detail widgets through{" "}
                  <span className="font-mono">_meta.ui</span>. Turn off to keep the model’s context
                  lean. Needs a server restart.
                </span>
              </span>
              {appViewsChanged && (
                <StatusBadge tone="warn" dot={false}>
                  Restart needed
                </StatusBadge>
              )}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <MonitorSearch
                className="min-w-[min(100%,300px)] flex-1"
                label="Filter modules"
                placeholder={
                  phone ? "Filter modules…" : "Filter by name, slug, group or description…"
                }
                value={query}
                onChange={setQuery}
              />
              {!phone && availability}
            </div>
            {phone && (
              <div className="flex items-center gap-2">
                <MonitorButton size="sm" onClick={enableAll}>
                  Enable all
                </MonitorButton>
                <MonitorButton size="sm" onClick={disableAll}>
                  Disable all
                </MonitorButton>
                <span className="flex-1" />
                {availability}
              </div>
            )}
            {msg && (
              <p className="monitor-hint font-mono" role="status">
                {msg}
              </p>
            )}
            {shown === 0 ? (
              <MonitorEmpty compact title="No modules match">
                Nothing matches “{query}”.
              </MonitorEmpty>
            ) : (
              groups.map(({ group, modules }, i) => {
                const on = modules.filter((m) => m.enabled).length;
                const expanded = !phone || open.has(group) || (i === 0 && !open.has(`-${group}`));
                const setExpanded = (next: boolean): void =>
                  setOpen((s) => {
                    const n = new Set(s);
                    n.delete(group);
                    n.delete(`-${group}`);
                    n.add(next ? group : `-${group}`);
                    return n;
                  });
                const enableGroup = (): void =>
                  void bulk(
                    modules.filter((m) => !m.enabled).map((m) => m.slug),
                    true,
                  );
                const disableGroup = (): void =>
                  void bulk(
                    modules.filter((m) => m.enabled).map((m) => m.slug),
                    false,
                  );
                return (
                  <section key={group} className="flex flex-col gap-2.5" aria-label={group}>
                    <div className="modules-group-head">
                      <h3 className="text-sm font-semibold text-foreground">{group}</h3>
                      <span className="text-xs text-muted-foreground">
                        {on}/{modules.length} on
                      </span>
                      {!phone && (
                        <span
                          className="modules-bar w-20 flex-none"
                          aria-label={`${on} of ${modules.length} modules on`}
                          {...tipProps(() => ({
                            title: group,
                            sub: "modules",
                            rows: [
                              { label: "On", value: on, color: "var(--sig)" },
                              { label: "Off", value: modules.length - on },
                            ],
                          }))}
                        >
                          <i style={{ width: `${(on / modules.length) * 100}%` }} />
                        </span>
                      )}
                      <span className="flex-1" />
                      {phone ? (
                        expanded ? (
                          <details className="modules-more">
                            <summary aria-label={`${group} actions`}>
                              <Ellipsis aria-hidden="true" />
                            </summary>
                            <div className="glass">
                              <MonitorButton size="sm" variant="ghost" onClick={enableGroup}>
                                Enable group
                              </MonitorButton>
                              <MonitorButton size="sm" variant="ghost" onClick={disableGroup}>
                                Disable group
                              </MonitorButton>
                              <MonitorButton
                                size="sm"
                                variant="ghost"
                                onClick={() => setExpanded(false)}
                              >
                                Collapse
                              </MonitorButton>
                            </div>
                          </details>
                        ) : (
                          <button
                            type="button"
                            className="monitor-icon-btn"
                            aria-label={`Show ${group}`}
                            aria-expanded={false}
                            onClick={() => setExpanded(true)}
                          >
                            <ChevronDown aria-hidden="true" />
                          </button>
                        )
                      ) : (
                        <>
                          <MonitorButton size="sm" variant="ghost" onClick={enableGroup}>
                            Enable group
                          </MonitorButton>
                          <MonitorButton size="sm" variant="ghost" onClick={disableGroup}>
                            Disable group
                          </MonitorButton>
                        </>
                      )}
                    </div>
                    {expanded && (
                      <div className="modules-grid">
                        {modules.map((m) => (
                          <ModuleCard
                            key={m.slug}
                            m={m}
                            busy={busy.has(m.slug)}
                            onToggle={(slug, enabled) => void toggle(slug, enabled)}
                            unmet={
                              capDevice
                                ? m.unsupported?.find((u) => u.device === capDevice)?.reason
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </MonitorPanel>
      </div>
      <RowDrawer
        open={Boolean(unavailItem)}
        onClose={() => setUnavailRow(undefined)}
        label={`Module details: ${unavailItem?.slug ?? ""}`}
        status={{ tone: "warn", label: `Unavailable on ${capDevice}` }}
        title={unavailModule?.label ?? unavailItem?.slug ?? ""}
        meta={unavailModule ? `${unavailModule.group} · ${unavailModule.slug}` : unavailItem?.slug}
        nav={
          unavailRow !== undefined && unavailItem
            ? {
                index: unavailRow,
                total: unavailable.length,
                onPrev: unavailRow > 0 ? () => setUnavailRow(unavailRow - 1) : undefined,
                onNext:
                  unavailRow < unavailable.length - 1
                    ? () => setUnavailRow(unavailRow + 1)
                    : undefined,
              }
            : undefined
        }
        rowKey={unavailItem?.slug}
        storageKey="modules-unavailable"
        actions={
          unavailItem && (
            <MonitorButton size="sm" variant="ghost" onClick={() => setQuery(unavailItem.slug)}>
              Show in list
            </MonitorButton>
          )
        }
      >
        {unavailItem && (
          <DetailList
            items={[
              { label: "Module", value: unavailItem.slug, mono: true },
              ...(unavailModule
                ? [
                    { label: "Name", value: unavailModule.label },
                    { label: "Group", value: unavailModule.group },
                    { label: "Tools", value: unavailModule.toolCount },
                    { label: "State", value: unavailModule.enabled ? "On" : "Off" },
                  ]
                : []),
              { label: "Router", value: capDevice, mono: true },
              { label: "Reason", value: unavailItem.reason },
            ]}
          />
        )}
      </RowDrawer>
    </div>
  );
}
