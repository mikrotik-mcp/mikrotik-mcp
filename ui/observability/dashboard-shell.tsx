import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Pin,
  PinOff,
  Search,
  X,
} from "lucide-react";
import {
  AnimatedSidebar,
  AnimatedSidebarMenuButton,
  useAnimatedSidebar,
} from "./components/beui/registry/components/motion/animated-sidebar";
import { Button } from "./components/ui/button";
import { Input } from "@/components/ui/input";
import { navigationGroups, viewGroup, VIEWS } from "./navigation";
import {
  NAVIGATION_PINS_KEY,
  parseNavigationPins,
  readNavigationPins,
  saveNavigationPins,
  toggleNavigationPin,
} from "./navigation-pins";
import type { ViewId } from "./navigation";
import type { LiveMode } from "./types";
import { num } from "./format";

export function StreamStatus({ mode }: { mode: LiveMode }): ReactNode {
  return (
    <span
      className="shell-stream"
      data-connected={mode !== "off"}
      title="Dashboard event stream, not router health"
    >
      <span className="shell-stream-dot" aria-hidden="true" />
      {mode === "off" ? "Stream offline" : "Live stream"}
      {mode !== "off" && <span className="shell-stream-protocol">{mode.toUpperCase()}</span>}
    </span>
  );
}

export function DashboardSidebar({
  view,
  onNavigate,
  renderIcon,
  onMobileOpenChange,
  liveMode,
  version,
  transport,
  eventCount,
  feedCount,
  firingCount,
  releaseAvailable,
  onReleaseNotes,
  controls,
}: {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  renderIcon: (view: ViewId) => ReactNode;
  onMobileOpenChange: (open: boolean) => void;
  liveMode: LiveMode;
  version?: string;
  transport?: string;
  eventCount?: number;
  feedCount: number;
  firingCount: number;
  releaseAvailable: boolean;
  onReleaseNotes?: () => void;
  controls: ReactNode;
}): ReactNode {
  const sidebar = useAnimatedSidebar();
  const collapsed = !sidebar.open && !sidebar.isMobile;
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState(() => readNavigationPins());
  const [pinNotice, setPinNotice] = useState("");
  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === NAVIGATION_PINS_KEY || event.key === null)
      ) {
        setPins(parseNavigationPins(event.newValue));
        setPinNotice("");
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const activeGroup = viewGroup(view).id;
  const [groupState, setGroupState] = useState(() => ({ view, expanded: new Set([activeGroup]) }));
  // A newly navigated page reveals its own group without an effect-driven render.
  const expanded = groupState.view === view ? groupState.expanded : new Set([activeGroup]);
  // A desktop resize must not leave an invisible modal trapping keyboard focus.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 900px)");
    const close = (): void => {
      if (desktop.matches) onMobileOpenChange(false);
    };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, [onMobileOpenChange]);
  const groups = navigationGroups(query);
  const choose = (id: ViewId): void => {
    onNavigate(id);
    onMobileOpenChange(false);
    setQuery("");
  };
  const togglePin = (id: ViewId): void => {
    const next = toggleNavigationPin(pins, id);
    setPins(next);
    const saved = saveNavigationPins(next);
    const label = VIEWS.find((item) => item.id === id)!.label;
    setPinNotice(
      `${label} ${next.includes(id) ? "pinned" : "unpinned"}.${saved ? "" : " Browser storage unavailable; kept for this session only."}`,
    );
  };
  const pageRow = (item: (typeof VIEWS)[number], instance: string, inPinned = false): ReactNode => {
    const pinned = pins.includes(item.id);
    return (
      <div className="shell-nav-row" key={item.id}>
        <AnimatedSidebarMenuButton
          href={`#${item.id}`}
          isActive={view === item.id}
          activeLayoutId={inPinned ? "pinned" : "categories"}
          className="shell-nav-link"
          onSelect={() => choose(item.id)}
          icon={renderIcon(item.id)}
          badge={
            <>
              {item.id === "alerts" && firingCount > 0 && (
                <span className="shell-nav-count shell-nav-count-alert">{firingCount}</span>
              )}
              {item.id === "feed" && feedCount > 0 && (
                <span className="shell-nav-count">{feedCount > 999 ? "999+" : feedCount}</span>
              )}
            </>
          }
        >
          {item.label}
        </AnimatedSidebarMenuButton>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="shell-pin-toggle"
          aria-label={`${pinned ? "Unpin" : "Pin"} ${item.label}`}
          aria-pressed={pinned}
          title={`${pinned ? "Unpin" : "Pin"} ${item.label}`}
          onClick={() => {
            togglePin(item.id);
            // Removing a shortcut must not strand focus on an unmounted control.
            if (inPinned) document.getElementById(`${instance}-search`)?.focus();
          }}
        >
          {pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
        </Button>
      </div>
    );
  };
  const menu = (instance: string): ReactNode => (
    <>
      <a
        href="#overview"
        className="shell-brand"
        onClick={(event) => {
          event.preventDefault();
          choose("overview");
        }}
        aria-label="MikroTik MCP overview"
      >
        <span className="shell-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" fill="none">
            <path d="M10 11 20 21 30 11M20 21v10" stroke="currentColor" strokeWidth="2" />
            <circle cx="10" cy="11" r="3" fill="currentColor" />
            <circle cx="30" cy="11" r="3" fill="currentColor" />
            <circle cx="20" cy="31" r="3" fill="currentColor" />
            <circle cx="20" cy="21" r="4" fill="currentColor" />
          </svg>
        </span>
        <span>
          <strong>
            MikroTik <span>MCP</span>
          </strong>
          <small>Network operations</small>
        </span>
      </a>
      <div className="shell-workspace">
        <span className="shell-workspace-icon">
          <Activity size={17} aria-hidden="true" />
        </span>
        <div>
          <strong>Observability</strong>
          <span>{transport ? `${transport.toUpperCase()} workspace` : "Dashboard workspace"}</span>
        </div>
        <span className="shell-workspace-indicator" aria-hidden="true" />
      </div>
      <div className="shell-nav-search">
        <Search size={15} aria-hidden="true" />
        <Input
          id={`${instance}-search`}
          aria-label="Find a page"
          placeholder="Find a page…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear page search"
            onClick={() => {
              setQuery("");
              document.getElementById(`${instance}-search`)?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <nav className="shell-nav" aria-label="Dashboard navigation">
        {!query.trim() && (
          <section className="shell-pinned" aria-label="Pinned pages">
            <div className="shell-pinned-heading">
              <Pin size={12} aria-hidden="true" />
              <span>Pinned</span>
              <span>{pins.length}</span>
            </div>
            {pins.length > 0 ? (
              <div className="shell-nav-track">
                {pins.map((id) =>
                  pageRow(
                    VIEWS.find((item) => item.id === id)!,
                    instance,
                    true,
                  ),
                )}
              </div>
            ) : (
              <p className="shell-pin-hint">Pin your go-to pages for quick access.</p>
            )}
          </section>
        )}
        <p
          className={pinNotice.includes("unavailable") ? "shell-pin-hint" : "sr-only"}
          role="status"
        >
          {pinNotice}
        </p>
        {groups.map((group) => {
          const open = collapsed || Boolean(query.trim()) || expanded.has(group.id);
          return (
            <section className="shell-nav-group" key={group.id}>
              <button
                type="button"
                className="shell-group-heading"
                aria-expanded={open}
                aria-controls={`${instance}-${group.id}`}
                onClick={() =>
                  setGroupState(() => {
                    const next = new Set(expanded);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return { view, expanded: next };
                  })
                }
              >
                <span>{group.label}</span>
                <span className="shell-group-meta">
                  {group.views.includes("alerts") && firingCount > 0 && (
                    <span className="shell-alert-dot" aria-label={`${firingCount} alerts firing`} />
                  )}
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
              </button>
              <div id={`${instance}-${group.id}`} className="shell-nav-track" hidden={!open}>
                {group.items.map((item) => pageRow(item, instance))}
              </div>
            </section>
          );
        })}
        {groups.length === 0 && (
          <div className="shell-nav-empty" role="status">
            <Search size={20} />
            <strong>No matching pages</strong>
            <span>Try “flows”, “backup” or “router”.</span>
          </div>
        )}
      </nav>
      <footer className="shell-sidebar-footer">
        <div className="shell-instance">
          <StreamStatus mode={liveMode} />
          <span>
            {eventCount == null ? "Waiting for server" : `${num(eventCount)} recorded events`}
          </span>
        </div>
        <div className="shell-server-controls">{controls}</div>
        <button
          type="button"
          className="shell-version"
          disabled={!onReleaseNotes}
          onClick={onReleaseNotes}
        >
          <span>
            MikroTik MCP <b>{version ? `v${version}` : "—"}</b>
          </span>
          {releaseAvailable ? (
            <span className="shell-release-dot" aria-label="New release available" />
          ) : (
            <ArrowUpRight size={13} aria-hidden="true" />
          )}
        </button>
      </footer>
    </>
  );
  return (
    <AnimatedSidebar
      ariaLabel="Dashboard navigation"
      collapsible="icon"
      className={sidebar.isMobile ? "shell-mobile-nav" : "shell-animated-sidebar"}
      panelClassName="shell-sidebar"
    >
      {sidebar.isMobile && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => sidebar.setOpenMobile(false)}
          className="self-end"
        >
          <X size={14} />
          Close navigation
        </Button>
      )}
      {menu(sidebar.isMobile ? "mobile-nav" : "desktop-nav")}
    </AnimatedSidebar>
  );
}
