import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, Search } from "lucide-react";
import { animate, createScope, spring } from "animejs";
import { navigationGroups, viewGroup, VIEWS } from "./navigation";
import type { ViewId } from "./navigation";
import { readRecentPages } from "./recent-pages";
import { motionAllowed, REDUCE_MOTION, shortcutLabel } from "./dashboard-shell";

export interface PaletteAction {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

type Row =
  | { key: string; kind: "page" | "recent"; view: ViewId; section: string }
  | { key: string; kind: "action"; action: PaletteAction; section: string };

function words(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Wraps every searched word found in `text` in <mark>. */
function highlight(text: string, terms: string[]): ReactNode {
  if (!terms.length) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return parts.map((part, index) =>
    terms.includes(part.toLowerCase()) ? (
      <mark key={index}>{part}</mark>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function sentence(sub: string): string {
  return /^[A-Z][a-z]/.test(sub) ? sub[0].toLowerCase() + sub.slice(1) : sub;
}

/** Ctrl/⌘ K: jump to any page or run one of a few shell actions. */
export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  renderIcon,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: ViewId) => void;
  renderIcon: (view: ViewId) => ReactNode;
  actions: PaletteAction[];
}): ReactNode {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <PaletteDialog
      onClose={() => onOpenChange(false)}
      onNavigate={onNavigate}
      renderIcon={renderIcon}
      actions={actions}
    />,
    document.body,
  );
}

function PaletteDialog({
  onClose,
  onNavigate,
  renderIcon,
  actions,
}: {
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  renderIcon: (view: ViewId) => ReactNode;
  actions: PaletteAction[];
}): ReactNode {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent] = useState(() => readRecentPages());
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const terms = words(query);

  const pages = useMemo(() => navigationGroups(query).flatMap((group) => group.items), [query]);
  const rows: Row[] = useMemo(
    () => [
      ...pages.map((page) => ({
        key: `page-${page.id}`,
        kind: "page" as const,
        view: page.id,
        section: "Pages",
      })),
      ...recent.map((id) => ({
        key: `recent-${id}`,
        kind: "recent" as const,
        view: id,
        section: "Recent",
      })),
      ...actions.map((action) => ({
        key: `action-${action.id}`,
        kind: "action" as const,
        action,
        section: "Actions",
      })),
    ],
    [pages, recent, actions],
  );
  const current = Math.min(active, rows.length - 1);

  // Focus goes back where it came from when the palette closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => opener?.focus?.({ preventScroll: true });
  }, []);

  // Scrim fades in, the palette scales up from 0.98.
  useEffect(() => {
    const scope = createScope({ root: rootRef, mediaQueries: { reduceMotion: REDUCE_MOTION } }).add(
      (self) => {
        if (self?.matches.reduceMotion) return;
        animate(".shell-scrim", { opacity: [0, 1], duration: 160, ease: "outQuad" });
        animate(".pal", { opacity: [0, 1], scale: [0.98, 1], duration: 180, ease: "outQuart" });
      },
    );
    return () => scope.revert();
  }, []);

  // The selected row's highlight slides between results.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const marker = highlightRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (!list || !marker) return;
    if (!row) {
      marker.style.opacity = "0";
      return;
    }
    marker.style.opacity = "1";
    marker.style.height = `${row.offsetHeight}px`;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 8;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 8;
    if (!placed.current || !motionAllowed()) {
      placed.current = true;
      marker.style.transform = `translateY(${row.offsetTop}px)`;
      return;
    }
    animate(marker, { y: row.offsetTop, ease: spring({ bounce: 0.1, duration: 200 }) });
  }, [current, rows]);

  const run = (row: Row | undefined, newTab = false): void => {
    if (!row) return;
    if (row.kind === "action") {
      onClose();
      row.action.run();
      return;
    }
    if (newTab) {
      window.open(`#${row.view}`, "_blank", "noopener");
      return;
    }
    onClose();
    onNavigate(row.view);
  };

  let previousSection = "";
  return (
    <div ref={rootRef} className="shell-palette-root">
      <div className="shell-scrim" aria-hidden="true" onClick={onClose} />
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="Search pages and actions"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Tab") {
            // The search field is the only stop; arrows move through results.
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        <div className="pal-in">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search pages and actions"
            aria-expanded="true"
            aria-controls="shell-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={rows[current] ? `shell-palette-${rows[current].key}` : undefined}
            placeholder="Search pages and actions"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!rows.length) return;
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((current + step + rows.length) % rows.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(rows[current], event.ctrlKey || event.metaKey);
              }
            }}
          />
          <kbd className="kbd2">Esc</kbd>
        </div>
        <div ref={listRef} id="shell-palette-list" className="pal-g" role="listbox">
          <span ref={highlightRef} className="pal-hl" aria-hidden="true" />
          {pages.length === 0 && (
            <div className="shell-nav-empty" role="status">
              <strong>No matching pages</strong>
              <span>Try “flows”, “backup” or “router”.</span>
            </div>
          )}
          {rows.map((row, index) => {
            const heading = row.section !== previousSection;
            previousSection = row.section;
            const selected = index === current;
            const page = row.kind === "action" ? null : VIEWS.find((item) => item.id === row.view)!;
            return (
              <Fragment key={row.key}>
                {heading && (
                  <span className="label" role="presentation" data-first={index === 0}>
                    {row.section}
                  </span>
                )}
                <div
                  id={`shell-palette-${row.key}`}
                  className={selected ? "pal-r on" : "pal-r"}
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onMouseMove={() => {
                    if (!selected) setActive(index);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => run(row, event.ctrlKey || event.metaKey)}
                >
                  {row.kind === "action" ? row.action.icon : renderIcon(row.view)}
                  <span className="pal-t">
                    {row.kind === "action"
                      ? row.action.label
                      : highlight(page!.label, row.kind === "page" ? terms : [])}
                  </span>
                  {page && (
                    <span className="sub">
                      {row.kind === "page"
                        ? highlight(`${viewGroup(page.id).label} · ${sentence(page.sub)}`, terms)
                        : viewGroup(page.id).label}
                    </span>
                  )}
                  <span className="r">
                    {row.kind === "action"
                      ? row.action.shortcut && <kbd className="kbd2">{row.action.shortcut}</kbd>
                      : selected && (
                          <>
                            <CornerDownLeft aria-hidden="true" />
                            Open
                          </>
                        )}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="pal-f" aria-hidden="true">
          <span>
            <kbd className="kbd2">↑</kbd>
            <kbd className="kbd2">↓</kbd>
            Move
          </span>
          <span>
            <kbd className="kbd2">↵</kbd>
            Open
          </span>
          <span>
            <kbd className="kbd2">{shortcutLabel("↵")}</kbd>
            Open in new tab
          </span>
          <span className="pal-count">
            {terms.length
              ? `${pages.length} ${pages.length === 1 ? "page matches" : "pages match"}`
              : `${pages.length} pages`}
          </span>
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {terms.length ? `${pages.length} ${pages.length === 1 ? "page" : "pages"} found` : ""}
        </span>
      </div>
    </div>
  );
}
