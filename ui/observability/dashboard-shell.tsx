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
import { animate } from "animejs";
import { Select } from "./kit/select";
import { PaneDivider, usePaneSize } from "./pane-divider";
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
      <path d="M5 6l7 7 7-7M12 13v6" />
      <circle cx="12" cy="13" r="2.2" fill="currentColor" />
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

/** "Live · WebSocket", "Live · SSE" or "Stream offline", with a live LED. */
export function StreamStatus({ mode }: { mode: LiveMode }): ReactNode {
  return (
    <span
      className="shell-stream"
      data-connected={mode !== "off"}
      title="Dashboard event stream, not router health"
    >
      <span
        className="shell-dot"
        data-tone={mode === "off" ? "off" : "ok"}
        data-live={mode !== "off" || undefined}
        aria-hidden="true"
      />
      <span className="shell-stream-label">
        {mode === "off" ? "Stream offline" : `Live · ${mode === "ws" ? "WebSocket" : "SSE"}`}
      </span>
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
  /** Unused by the sidebar itself: the header's button collapses it. Kept for callers. */
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
    mobileOpen = false,
    onSearch,
  } = props;
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const instance = isMobile ? "mobile-nav" : "desktop-nav";
  const sidebar = usePaneSize("mt-navigation-width", 280, 224, 384);
  const navigationViewport = useRef<HTMLDivElement>(null);
  const [pins, setPins] = useState(() => readNavigationPins());
  const [pinNotice, setPinNotice] = useState("");
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
  const [section, setSection] = useState({ view, id: activeGroup });
  // Back/forward, pinned shortcuts and palette navigation all reveal the destination.
  if (section.view !== view) setSection({ view, id: activeGroup });
  const groups = navigationGroups("");
  const currentSection = groups.find((group) => group.id === section.id)!;

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
  }, [view, collapsed, isMobile, mobileOpen]);

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

  // The digit keys 1 to 9 open the pinned pages, in the order of the board.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1];
      const id = digit ? pins[Number(digit) - 1] : undefined;
      if (!id) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector("[role=dialog][data-state=open], [role=menu], [role=listbox]"))
        return;
      event.preventDefault();
      setSection({ view: id, id: viewGroup(id).id });
      onNavigate(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pins, onNavigate]);

  const choose = (id: ViewId): void => {
    setSection({ view: id, id: viewGroup(id).id });
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
  const pageLabel = (item: (typeof VIEWS)[number]): string => {
    const release = newFeatureRelease(item.id, version);
    return release ? `${item.label} · New in v${release}` : item.label;
  };

  const pageRow = (item: (typeof VIEWS)[number], inFlyout = false): ReactNode => {
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
          <span className="shell-page-icon" aria-hidden="true">
            {renderIcon(item.id)}
          </span>
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
            }}
          >
            {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </button>
        )}
      </div>
    );
  };

  /** One row of the pinned board: its number key, the page, its group, its live number. */
  const pinnedRow = (item: (typeof VIEWS)[number], index: number): ReactNode => {
    const release = newFeatureRelease(item.id, version);
    const active = view === item.id;
    const note =
      item.id === "alerts" && firingCount > 0
        ? { text: `${firingCount} firing`, tone: "bad" }
        : item.id === "feed" && feedCount > 0
          ? { text: feedCount > 999 ? "999+" : String(feedCount), tone: "ok" }
          : null;
    return (
      <div className="shell-nav-row" key={item.id}>
        <a
          href={`#${item.id}`}
          className="it shell-nav-link shell-pin"
          data-pinned
          data-active={active || undefined}
          aria-current={active ? "page" : undefined}
          aria-label={release ? pageLabel(item) : undefined}
          aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            choose(item.id);
          }}
        >
          {renderIcon(item.id)}
          <kbd className="shell-pin-key" aria-hidden="true">
            {index < 9 ? index + 1 : "·"}
          </kbd>
          <span className="shell-pin-text">
            <span className="lbl">{item.label}</span>
            <span className="shell-pin-group">{viewGroup(item.id).label}</span>
          </span>
          <span className="shell-nav-badges">
            <NewFeatureBadge view={item.id} version={version} />
            {note && (
              <span className="shell-pin-note" data-tone={note.tone}>
                <span className="shell-pin-led" data-tone={note.tone} aria-hidden="true" />
                {note.text}
              </span>
            )}
          </span>
        </a>
        <button
          type="button"
          className="shell-pin-toggle"
          aria-label={`Unpin ${item.label}`}
          aria-pressed
          title={`Unpin ${item.label}`}
          onClick={() => {
            togglePin(item.id);
            // Removing a shortcut must not strand focus on an unmounted control.
            document.getElementById(`${instance}-search`)?.focus();
          }}
        >
          <PinOff aria-hidden="true" />
        </button>
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
        <b>MikroTik MCP</b>
        <small>{transport ? `Observability · ${transport}` : "Observability"}</small>
      </span>
    </a>
  );

  const expandedMenu = (drawer: boolean): ReactNode => (
    <div className="shell-sidebar-inner" id={`${instance}-content`}>
      <div className="sb-top">
        {brand}
        {drawer && (
          <button
            type="button"
            className="ib"
            aria-label="Close navigation"
            onClick={() => onMobileOpenChange(false)}
          >
            <X aria-hidden="true" />
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
        <span className="ph">Jump to a page</span>
        <kbd className="kbd2">{shortcutLabel("K")}</kbd>
      </button>
      <div className="shell-section-switch">
        <div className="shell-section-caption">
          <label htmlFor={`${instance}-section`}>Browse section</label>
          {firingCount > 0 && currentSection.id !== "monitoring" && (
            <a
              href="#alerts"
              aria-label={`${firingCount} alerts firing`}
              onClick={(event) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                choose("alerts");
              }}
            >
              {firingCount} firing
            </a>
          )}
        </div>
        <Select
          id={`${instance}-section`}
          label="Browse section"
          className="shell-section-select"
          value={currentSection.id}
          onChange={(id) => {
            setSection({ view, id });
            if (navigationViewport.current) navigationViewport.current.scrollTop = 0;
          }}
          options={groups.map((group) => {
            const Icon = GROUP_ICONS[group.id] ?? Layers;
            return {
              value: group.id,
              label: group.label,
              icon: <Icon aria-hidden="true" />,
              meta: group.items.length,
            };
          })}
        />
      </div>
      <ScrollArea className="shell-nav-scroll" viewportProps={{ ref: navigationViewport }}>
        <div className="sb-scroll">
          <section
            className="shell-nav-group shell-section-pages"
            aria-label={currentSection.label}
          >
            <div className="nav">{currentSection.items.map((item) => pageRow(item))}</div>
          </section>
          {pins.length > 0 && (
            <section className="sec shell-pinned" aria-label="Pinned pages">
              <div className="ngl">
                Pinned
                <span className="shell-pin-keys">
                  {pins.length === 1 ? "press 1" : `press 1 to ${Math.min(pins.length, 9)}`}
                </span>
              </div>
              <div className="nav">
                {pins.map((id, index) =>
                  pinnedRow(
                    VIEWS.find((item) => item.id === id)!,
                    index,
                  ),
                )}
              </div>
            </section>
          )}
          <p
            className={pinNotice.includes("unavailable") ? "sec-d shell-pin-hint" : "sr-only"}
            role="status"
          >
            {pinNotice}
          </p>
        </div>
      </ScrollArea>
      <footer className="sb-foot">
        <div className="shell-instance">
          <StreamStatus mode={liveMode} />
          <span
            className="shell-events"
            title={eventCount == null ? "Waiting for the server" : "Events recorded"}
          >
            {eventCount == null ? "—" : num(eventCount)}
            <span className="sr-only"> events</span>
          </span>
        </div>
        <div className="shell-server-controls">{controls}</div>
        <div className="shell-version">
          <span
            className="shell-dot"
            data-tone="int"
            data-live={releaseAvailable || undefined}
            {...(releaseAvailable
              ? { role: "img", "aria-label": "New release" }
              : { "aria-hidden": true })}
          />
          <span title={version ? `MikroTik MCP v${version}` : undefined}>
            {version ? `v${version}` : "—"}
          </span>
          {onReleaseNotes && (
            <button
              type="button"
              className="shell-link"
              onClick={() => {
                if (drawer) onMobileOpenChange(false);
                onReleaseNotes();
              }}
            >
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

  if (!collapsed)
    return (
      <nav
        style={{ width: sidebar.size }}
        className="shell-sidebar sb"
        aria-label="Dashboard navigation"
        data-state="expanded"
      >
        {expandedMenu(false)}
        <PaneDivider pane={sidebar} label="Resize navigation" controls="desktop-nav-content" />
      </nav>
    );

  const pinnedViews = pins.map((id) => VIEWS.find((item) => item.id === id)!);
  return (
    <nav className="shell-sidebar sb rail" aria-label="Dashboard navigation" data-state="collapsed">
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
          <div className="rail-groups" role="group" aria-label="Pinned pages">
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
          </div>
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
            {group.items.map((item) => pageRow(item, true))}
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
          <div className="nav">{children}</div>
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
      <nav className="crumb" aria-label="Breadcrumb">
        {!isMobile && (
          <>
            <GroupIcon aria-hidden="true" />
            <span>{group.label}</span>
            <span className="sep" aria-hidden="true">
              /
            </span>
          </>
        )}
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
      {!isMobile && <ThemeToggle className="ib box" />}
    </header>
  );
}
