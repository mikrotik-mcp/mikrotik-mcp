import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Archive,
  ChevronRight,
  Layers,
  Menu,
  Network,
  PanelLeft,
  Pin,
  PinOff,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { animate, createScope, spring, stagger } from "animejs";
import { ScrollArea } from "./components/ui/scroll-area";
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
import { NewFeatureBadge } from "./new-feature-badge";
import { newFeatureRelease } from "./feature-releases";
import { ThemeToggle } from "./theme";

// ── shared shell helpers ─────────────────────────────────────────────────────

export const MOBILE_QUERY = "(max-width: 899px)";
export const REDUCE_MOTION = "(prefers-reduced-motion: reduce)";
export const SIDEBAR_COLLAPSED_KEY = "mt-sidebar-collapsed";

/** One icon per navigation group, used by the rail and the breadcrumb. */
export const GROUP_ICONS: Record<string, LucideIcon> = {
  monitoring: Activity,
  network: Network,
  "users-vpn": Users,
  diagnostics: Wrench,
  security: Shield,
  configuration: SlidersHorizontal,
  recovery: Archive,
  workspace: Layers,
};

export function motionAllowed(): boolean {
  return typeof window !== "undefined" && !window.matchMedia?.(REDUCE_MOTION).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (change) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener?.("change", change);
      return () => list?.removeEventListener?.("change", change);
    },
    () => Boolean(window.matchMedia?.(query).matches),
    () => false,
  );
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** "Ctrl K" on Windows and Linux, "⌘ K" on a Mac. */
export function shortcutLabel(key: string): string {
  return `${IS_MAC ? "⌘" : "Ctrl"} ${key}`;
}

/** Whether the desktop sidebar is collapsed to the rail, kept across reloads. */
export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setState] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setState(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
  }, []);
  return [collapsed, set];
}

export function BrandMark(): ReactNode {
  return (
    <svg className="shell-ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7l5 5 5-5M12 12v5" />
      <circle cx="7" cy="7" r="1.6" fill="currentColor" />
      <circle cx="17" cy="7" r="1.6" fill="currentColor" />
      <circle cx="12" cy="17.5" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
    </svg>
  );
}

/** Lets modified clicks (new tab, new window) reach the browser. */
function plainClick(event: MouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement | null): HTMLElement[] {
  return root
    ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => !node.closest("[hidden], [inert]"),
      )
    : [];
}

// ── stream status ────────────────────────────────────────────────────────────

export function StreamStatus({ mode }: { mode: LiveMode }): ReactNode {
  return (
    <span
      className="shell-stream"
      data-connected={mode !== "off"}
      title="Dashboard event stream, not router health"
    >
      <span className="shell-dot" data-tone={mode === "off" ? "off" : "ok"} aria-hidden="true" />
      <span className="shell-stream-label">
        {mode === "off" ? "Stream offline" : "Live stream"}
      </span>
      {mode !== "off" && <span className="kbd2 shell-stream-protocol">{mode.toUpperCase()}</span>}
    </span>
  );
}

// ── sidebar ──────────────────────────────────────────────────────────────────

interface SidebarProps {
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
  /** Reload and Restart, full size, for the open sidebar and the drawer. */
  controls: ReactNode;
  /** Icon-only server controls for the rail. */
  compactControls?: ReactNode;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  mobileOpen?: boolean;
  /** Opens the search palette. */
  onSearch?: () => void;
}

export function DashboardSidebar(props: SidebarProps): ReactNode {
  const {
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
    compactControls,
    collapsed = false,
    onToggleCollapsed,
    mobileOpen = false,
    onSearch,
  } = props;
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const instance = isMobile ? "mobile-nav" : "desktop-nav";
  const asideRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const navigationViewport = useRef<HTMLDivElement>(null);
  const [pins, setPins] = useState(() => readNavigationPins());
  const [pinNotice, setPinNotice] = useState("");
  // The rail replaces the open sidebar only after its labels have faded out.
  const [railShown, setRailShown] = useState(collapsed);
  const [flyout, setFlyout] = useState<string | null>(null);

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

  // Collapse: fade the labels first, then swap in the rail. Expand at once,
  // and skip the fade when motion is reduced.
  if (collapsed !== railShown && (!collapsed || isMobile || !motionAllowed()))
    setRailShown(collapsed);
  useEffect(() => {
    if (!collapsed || railShown || !innerRef.current) return;
    const fade = animate(innerRef.current, {
      opacity: [1, 0],
      duration: 90,
      ease: "outQuad",
      onComplete: () => setRailShown(true),
    });
    return () => {
      fade.revert();
    };
  }, [collapsed, railShown]);

  // The width springs between 264 and 64 px; the new content settles in after.
  const firstLayout = useRef(true);
  useLayoutEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const aside = asideRef.current;
    if (!aside) return;
    const scope = createScope({
      root: asideRef,
      mediaQueries: { reduceMotion: REDUCE_MOTION },
    }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate(aside, {
        width: railShown ? [264, 64] : [64, 264],
        ease: spring({ bounce: 0.12, duration: 320 }),
      });
      if (railShown)
        animate(".ri", {
          opacity: [0, 1],
          x: [-4, 0],
          duration: 220,
          delay: stagger(14, { start: 80 }),
          ease: "outQuart",
        });
      else
        animate(".shell-sidebar-inner", {
          opacity: [0, 1],
          duration: 180,
          delay: 120,
          ease: "outQuad",
        });
    });
    return () => scope.revert();
  }, [railShown]);

  // Active page: the highlight and its accent bar slide to the new row.
  const lastHighlight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const highlight = innerRef.current?.querySelector<HTMLElement>(
      ".shell-nav-group .shell-nav-hl",
    );
    const before = lastHighlight.current;
    if (!highlight || before == null || !motionAllowed()) return;
    const offset = before - highlight.getBoundingClientRect().top;
    if (!offset || Math.abs(offset) > 640) return;
    const slide = animate(highlight, {
      y: [offset, 0],
      ease: spring({ bounce: 0.15, duration: 280 }),
    });
    return () => {
      slide.revert();
    };
  }, [view]);
  useLayoutEffect(() => {
    const highlight = innerRef.current?.querySelector<HTMLElement>(
      ".shell-nav-group .shell-nav-hl",
    );
    lastHighlight.current = highlight ? highlight.getBoundingClientRect().top : null;
  });

  // Group open: height eases, rows fade up 4px with a 20 ms stagger.
  const opening = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = opening.current;
    opening.current = null;
    if (!id || !motionAllowed()) return;
    const track = document.getElementById(`${instance}-${id}`);
    if (!track) return;
    const height = track.scrollHeight;
    const animations = [
      animate(track, {
        height: [0, height],
        duration: 220,
        ease: "outQuart",
        onComplete: () => {
          track.style.height = "";
        },
      }),
      animate(`[aria-controls="${instance}-${id}"] .chev`, {
        rotate: [0, 90],
        duration: 200,
        ease: "outQuart",
      }),
      animate(track.querySelectorAll(".it"), {
        opacity: [0, 1],
        y: [4, 0],
        duration: 200,
        delay: stagger(20),
        ease: "outQuart",
      }),
    ];
    return () => {
      for (const animation of animations) animation.revert();
    };
  });

  useEffect(() => {
    if (isMobile && !mobileOpen) return;
    const viewport = navigationViewport.current;
    const activeLink = viewport?.querySelector<HTMLElement>(
      '.shell-nav-group .shell-nav-link[aria-current="page"]',
    );
    if (!viewport || !activeLink) return;
    const bounds = viewport.getBoundingClientRect();
    const link = activeLink.getBoundingClientRect();
    if (!bounds.height || !link.height) return;
    // Scroll this viewport only: scrollIntoView would also move the dashboard.
    if (link.bottom > bounds.bottom) viewport.scrollTop += link.bottom - bounds.bottom + 12;
    else if (link.top < bounds.top) viewport.scrollTop += link.top - bounds.top - 12;
  }, [view, railShown, isMobile, mobileOpen]);

  // A desktop resize must not leave an invisible modal trapping keyboard focus.
  useEffect(() => {
    const desktop = window.matchMedia?.("(min-width: 900px)");
    if (!desktop) return;
    const close = (): void => {
      if (desktop.matches) onMobileOpenChange(false);
    };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, [onMobileOpenChange]);

  const groups = navigationGroups("");
  const choose = (id: ViewId): void => {
    onNavigate(id);
    onMobileOpenChange(false);
    setFlyout(null);
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
  const toggleGroup = (id: string): void => {
    const open = expanded.has(id);
    const commit = (): void =>
      setGroupState(() => {
        const next = new Set(expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { view, expanded: next };
      });
    if (!open) {
      opening.current = id;
      commit();
      return;
    }
    const track = document.getElementById(`${instance}-${id}`);
    if (!track || !motionAllowed()) {
      commit();
      return;
    }
    animate(`[aria-controls="${instance}-${id}"] .chev`, {
      rotate: [90, 0],
      duration: 180,
      ease: "outQuart",
      onComplete: (self) => self.revert(),
    });
    animate(track, {
      height: [track.offsetHeight, 0],
      opacity: [1, 0],
      duration: 180,
      ease: "outQuart",
      onComplete: () => {
        track.style.height = "";
        track.style.opacity = "";
        commit();
      },
    });
  };
  const pageLabel = (item: (typeof VIEWS)[number]): string => {
    const release = newFeatureRelease(item.id, version);
    return release ? `${item.label} · New in v${release}` : item.label;
  };

  const pageRow = (item: (typeof VIEWS)[number], inPinned = false, inFlyout = false): ReactNode => {
    const pinned = pins.includes(item.id);
    const release = newFeatureRelease(item.id, version);
    const active = view === item.id;
    return (
      <div className="shell-nav-row" key={item.id}>
        <a
          href={`#${item.id}`}
          className="it shell-nav-link"
          data-active={active || undefined}
          aria-current={active ? "page" : undefined}
          aria-label={release ? pageLabel(item) : undefined}
          tabIndex={inFlyout ? -1 : undefined}
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            choose(item.id);
          }}
        >
          {active && <span className="shell-nav-hl" aria-hidden="true" />}
          {renderIcon(item.id)}
          <span className="lbl">{item.label}</span>
          <span className="shell-nav-badges">
            <NewFeatureBadge view={item.id} version={version} />
            {item.id === "alerts" && firingCount > 0 && (
              <span className="pill-bad">{firingCount}</span>
            )}
            {item.id === "feed" && feedCount > 0 && (
              <span className="cnt">{feedCount > 999 ? "999+" : feedCount}</span>
            )}
          </span>
        </a>
        {!inFlyout && (
          <button
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
            {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </button>
        )}
      </div>
    );
  };

  const brand = (
    <a
      href="#overview"
      className="shell-brand"
      onClick={(event) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        choose("overview");
      }}
      aria-label="MikroTik MCP overview"
    >
      <span className="logo">
        <BrandMark />
      </span>
      <span className="brand">
        <b>
          MikroTik <span>MCP</span>
        </b>
        <small>{transport ? `Observability · ${transport}` : "Observability"}</small>
      </span>
    </a>
  );

  const expandedMenu = (drawer: boolean): ReactNode => (
    <div className="shell-sidebar-inner" ref={innerRef}>
      <div className="sb-top">
        {brand}
        {drawer ? (
          <button
            type="button"
            className="ib"
            aria-label="Close navigation"
            onClick={() => onMobileOpenChange(false)}
          >
            <X aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="ib"
            aria-label="Collapse sidebar"
            title={`Collapse sidebar (${shortcutLabel("B")})`}
            onClick={onToggleCollapsed}
          >
            <PanelLeft aria-hidden="true" />
          </button>
        )}
      </div>
      <button
        type="button"
        id={`${instance}-search`}
        className="sb-search"
        aria-haspopup="dialog"
        onClick={onSearch}
      >
        <Search aria-hidden="true" />
        <span className="ph">Search pages</span>
        <kbd className="kbd2">{shortcutLabel("K")}</kbd>
      </button>
      <ScrollArea className="shell-nav-scroll" viewportProps={{ ref: navigationViewport }}>
        <div className="sb-scroll">
          <section className="sec shell-pinned" aria-label="Pinned pages">
            <div className="sec-h">
              <Pin className="chev" aria-hidden="true" />
              Pinned
              <span className="n">{pins.length}</span>
            </div>
            {pins.length > 0 ? (
              <div className="nav">
                {pins.map((id) =>
                  pageRow(
                    VIEWS.find((item) => item.id === id)!,
                    true,
                  ),
                )}
              </div>
            ) : (
              <p className="sec-d shell-pin-hint">Pin your go-to pages for quick access.</p>
            )}
          </section>
          <p
            className={pinNotice.includes("unavailable") ? "sec-d shell-pin-hint" : "sr-only"}
            role="status"
          >
            {pinNotice}
          </p>
          <div className="shell-groups">
            {groups.map((group) => {
              const open = expanded.has(group.id);
              const alerting = group.views.includes("alerts") && firingCount > 0;
              return (
                <section className="sec shell-nav-group" key={group.id}>
                  <button
                    type="button"
                    className="sec-h shell-group-heading"
                    aria-label={group.label}
                    title={group.description}
                    data-active={group.id === activeGroup}
                    data-open={open}
                    aria-expanded={open}
                    aria-controls={`${instance}-${group.id}`}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <ChevronRight className="chev" aria-hidden="true" />
                    {group.label}
                    {alerting && (
                      <span className="pill-bad" aria-label={`${firingCount} alerts firing`}>
                        {firingCount}
                      </span>
                    )}
                    <span className="n shell-group-size" aria-hidden="true">
                      {group.items.length}
                    </span>
                  </button>
                  <div id={`${instance}-${group.id}`} className="shell-nav-track" hidden={!open}>
                    <p className="sec-d">{group.description}</p>
                    <div className="nav guide">{group.items.map((item) => pageRow(item))}</div>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </ScrollArea>
      <footer className="sb-foot">
        <div className="shell-instance">
          <StreamStatus mode={liveMode} />
          <span className="shell-events">
            {eventCount == null ? "Waiting for server" : `${num(eventCount)} events`}
          </span>
        </div>
        <div className="shell-server-controls">{controls}</div>
        <div className="shell-version">
          {releaseAvailable && <span className="newdot" role="img" aria-label="New release" />}
          <span>MikroTik MCP {version ? `v${version}` : "—"}</span>
          {onReleaseNotes && (
            <button type="button" className="shell-link" onClick={onReleaseNotes}>
              What's new
            </button>
          )}
        </div>
      </footer>
    </div>
  );

  if (isMobile)
    return (
      <MobileDrawer open={mobileOpen} onClose={() => onMobileOpenChange(false)}>
        {expandedMenu(true)}
      </MobileDrawer>
    );

  if (!railShown)
    return (
      <nav
        ref={asideRef}
        className="shell-sidebar sb"
        aria-label="Dashboard navigation"
        data-state="expanded"
      >
        {expandedMenu(false)}
      </nav>
    );

  const pinnedViews = pins.map((id) => VIEWS.find((item) => item.id === id)!);
  return (
    <nav
      ref={asideRef}
      className="shell-sidebar sb rail"
      aria-label="Dashboard navigation"
      data-state="collapsed"
    >
      <div className="sb-top">
        <a
          href="#overview"
          className="shell-brand logo"
          aria-label="MikroTik MCP overview"
          title="MikroTik MCP overview"
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            choose("overview");
          }}
        >
          <BrandMark />
        </a>
      </div>
      <button
        type="button"
        id={`${instance}-search`}
        className="ri"
        aria-label={`Search pages (${shortcutLabel("K")})`}
        title={`Search pages (${shortcutLabel("K")})`}
        aria-haspopup="dialog"
        onClick={onSearch}
      >
        <Search aria-hidden="true" />
      </button>
      {pinnedViews.length > 0 && (
        <>
          <span className="rsep" aria-hidden="true" />
          {pinnedViews.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="ri"
              aria-label={`${pageLabel(item)} (pinned)`}
              title={pageLabel(item)}
              aria-current={view === item.id ? "page" : undefined}
              onClick={(event) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                choose(item.id);
              }}
            >
              {renderIcon(item.id)}
              <NewFeatureBadge view={item.id} version={version} placement="icon" />
            </a>
          ))}
        </>
      )}
      <span className="rsep" aria-hidden="true" />
      <div className="rail-groups">
        {groups.map((group) => (
          <RailGroup
            key={group.id}
            group={group}
            active={group.id === activeGroup}
            alerts={group.views.includes("alerts") ? firingCount : 0}
            open={flyout === group.id}
            onOpenChange={(open) =>
              setFlyout((current) => (open ? group.id : current === group.id ? null : current))
            }
          >
            {group.items.map((item) => pageRow(item, false, true))}
          </RailGroup>
        ))}
      </div>
      <span className="rail-spacer" />
      <div className="rail-foot">
        <span
          className="ri"
          role="img"
          aria-label={
            liveMode === "off"
              ? "Stream offline"
              : `Live stream connected over ${liveMode === "ws" ? "WebSocket" : "SSE"}`
          }
          title="Dashboard event stream, not router health"
        >
          <span className="shell-dot" data-tone={liveMode === "off" ? "off" : "ok"} />
        </span>
        {compactControls}
        {onReleaseNotes && (
          <button
            type="button"
            className="ri"
            aria-label={`What's new in ${version ? `v${version}` : "this version"}`}
            title="What's new"
            onClick={onReleaseNotes}
          >
            <Sparkles aria-hidden="true" />
            {releaseAvailable && <span className="bdot" data-tone="int" />}
          </button>
        )}
      </div>
    </nav>
  );
}

/** A rail icon for one group; hover or focus shows the group's pages beside it. */
function RailGroup({
  group,
  active,
  alerts,
  open,
  onOpenChange,
  children,
}: {
  group: { id: string; label: string; description: string };
  active: boolean;
  alerts: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}): ReactNode {
  const Icon = GROUP_ICONS[group.id] ?? Layers;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const quiet = useRef(false);
  const [top, setTop] = useState(0);
  const schedule = (next: boolean, delay: number): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onOpenChange(next), delay);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // The first page row lines up with the group icon, as on the board.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const fly = flyRef.current;
    if (!open || !button || !fly) return;
    const row = fly.querySelector<HTMLElement>(".it");
    const offset = row ? row.getBoundingClientRect().top - fly.getBoundingClientRect().top : 6;
    const wanted = button.getBoundingClientRect().top - offset - 1;
    setTop(Math.max(8, Math.min(wanted, window.innerHeight - fly.offsetHeight - 8)));
  }, [open]);
  useEffect(() => {
    const fly = flyRef.current;
    if (!open || !fly || !motionAllowed()) return;
    const entrance = animate(fly, {
      opacity: [0, 1],
      x: [-6, 0],
      duration: 160,
      ease: "outQuart",
    });
    return () => {
      entrance.revert();
    };
  }, [open]);
  const links = (): HTMLElement[] => [
    ...(flyRef.current?.querySelectorAll<HTMLElement>("a.shell-nav-link") ?? []),
  ];
  const enter = (): void => {
    onOpenChange(true);
    requestAnimationFrame(() => links()[0]?.focus());
  };
  const onButtonKey = (event: ReactKeyboardEvent): void => {
    if (["Enter", " ", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      enter();
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      onOpenChange(false);
    }
  };
  const onFlyKey = (event: ReactKeyboardEvent): void => {
    const items = links();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      onOpenChange(false);
      // Back on the icon, keep the flyout closed until the next hover or focus.
      quiet.current = true;
      buttonRef.current?.focus();
    }
  };
  const label = alerts > 0 ? `${group.label}, ${alerts} alerts firing` : group.label;
  return (
    <div
      className="rail-group"
      onMouseEnter={() => schedule(true, 120)}
      onMouseLeave={() => schedule(false, 160)}
      onFocus={() => {
        window.clearTimeout(timer.current);
        if (quiet.current) quiet.current = false;
        else onOpenChange(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={active ? "ri on" : "ri"}
        aria-label={label}
        aria-expanded={open}
        aria-controls={`rail-fly-${group.id}`}
        data-active={active}
        onClick={() => (open ? enter() : onOpenChange(true))}
        onKeyDown={onButtonKey}
      >
        <Icon aria-hidden="true" />
        {alerts > 0 && <span className="bdot" />}
      </button>
      {open && (
        <div
          ref={flyRef}
          id={`rail-fly-${group.id}`}
          className="fly"
          style={{ top }}
          role="group"
          aria-label={group.label}
          onKeyDown={onFlyKey}
        >
          <div className="fly-h">
            <b>{group.label}</b>
            <small>{group.description}</small>
          </div>
          <div className="nav guide">{children}</div>
        </div>
      )}
    </div>
  );
}

/** The phone menu: a modal sheet from the left with a scrim. */
function MobileDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    if (!motionAllowed() || !panelRef.current) {
      setMounted(false);
      return;
    }
    const exit = [
      animate(panelRef.current, { x: ["0%", "-100%"], duration: 200, ease: "inQuart" }),
      animate(scrimRef.current!, {
        opacity: [1, 0],
        duration: 200,
        onComplete: () => setMounted(false),
      }),
    ];
    return () => {
      for (const animation of exit) animation.revert();
    };
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const scrollY = window.scrollY;
    const previous = {
      left: body.style.left,
      overflow: body.style.overflow,
      position: body.style.position,
      right: body.style.right,
      top: body.style.top,
    };
    Object.assign(body.style, {
      position: "fixed",
      top: `-${scrollY}px`,
      left: "0",
      right: "0",
      overflow: "hidden",
    });
    const frame = requestAnimationFrame(() => focusables(panelRef.current)[0]?.focus());
    const entrance = motionAllowed()
      ? [
          animate(panelRef.current!, { x: ["-100%", "0%"], duration: 240, ease: "outQuart" }),
          animate(scrimRef.current!, { opacity: [0, 1], duration: 200 }),
        ]
      : [];
    return () => {
      cancelAnimationFrame(frame);
      for (const animation of entrance) animation.revert();
      Object.assign(body.style, previous);
      window.scrollTo(0, scrollY);
      document.getElementById("shell-menu-toggle")?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div className="shell-drawer-root">
      <div ref={scrimRef} className="shell-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className="shell-drawer"
        inert={!open}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const items = focusables(panelRef.current);
          if (items.length === 0) {
            event.preventDefault();
            return;
          }
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <nav className="shell-sidebar sb" aria-label="Dashboard navigation" data-state="mobile">
          {children}
        </nav>
      </div>
    </div>,
    document.body,
  );
}

// ── header ───────────────────────────────────────────────────────────────────

export function ShellHeader({
  view,
  collapsed,
  mobileOpen,
  onToggleNavigation,
  onSearch,
  live,
}: {
  view: ViewId;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleNavigation: () => void;
  onSearch: () => void;
  /** The Live capsule with its operations panel. */
  live: ReactNode;
}): ReactNode {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const shadowRef = useRef<HTMLSpanElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = (): void => setScrolled(window.scrollY > 0);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  // A hairline shadow fades in once the page scrolls under the header.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (!motionAllowed()) {
      shadow.style.opacity = scrolled ? "1" : "0";
      return;
    }
    const fade = animate(shadow, {
      opacity: scrolled ? 1 : 0,
      duration: 200,
      ease: "outQuad",
    });
    return () => {
      fade.pause();
    };
  }, [scrolled]);
  const group = viewGroup(view);
  const page = VIEWS.find((item) => item.id === view) ?? VIEWS[0];
  const GroupIcon = GROUP_ICONS[group.id] ?? Layers;
  const navLabel = isMobile ? "Open navigation" : collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <header className="hd shell-header" data-scrolled={scrolled}>
      <span ref={shadowRef} className="shell-header-shadow" aria-hidden="true" />
      <button
        type="button"
        id="shell-menu-toggle"
        className="ib"
        aria-label={navLabel}
        title={`${navLabel} (${shortcutLabel("B")})`}
        aria-expanded={isMobile ? mobileOpen : !collapsed}
        onClick={onToggleNavigation}
      >
        {isMobile ? <Menu aria-hidden="true" /> : <PanelLeft aria-hidden="true" />}
      </button>
      {!isMobile && <span className="vline" aria-hidden="true" />}
      <nav className="crumb" aria-label="Breadcrumb">
        {!isMobile && <GroupIcon aria-hidden="true" />}
        <span>{group.label}</span>
        <ChevronRight className="sep" aria-hidden="true" />
        <b aria-current="page">{page.label}</b>
      </nav>
      <span className="shell-header-spacer" />
      {isMobile ? (
        <button
          type="button"
          className="ib"
          aria-label="Search pages"
          aria-haspopup="dialog"
          onClick={onSearch}
        >
          <Search aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className="hsearch" aria-haspopup="dialog" onClick={onSearch}>
          <Search aria-hidden="true" />
          <span className="ph">Search or jump to</span>
          <kbd className="kbd2">{shortcutLabel("K")}</kbd>
        </button>
      )}
      {live}
      {!isMobile && (
        <>
          <span className="vline" aria-hidden="true" />
          <ThemeToggle className="ib" />
        </>
      )}
    </header>
  );
}
