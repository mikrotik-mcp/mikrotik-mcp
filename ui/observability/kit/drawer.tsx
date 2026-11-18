/**
 * Row details drawer (Kit-Data-Drawer). Every table opens a row's details here:
 * from the right, without a scrim, so the table stays usable beside it.
 *
 * Parts: next/previous row (J / K), pin, full record and close; status, title
 * and meta; chips; tabs; and actions in the footer. Width drags from 400 to
 * 720 px and is remembered. On a phone it is a full-height sheet: swipe down
 * to close, left or right for the next row.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ExternalLink, Pin, PinOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DUR, drawerIn, isPhone, reducedMotion, sheetIn, swapIn } from "./motion";
import { Kbd, Led } from "./listbox";
import type { Tone } from "./listbox";
import { animate } from "animejs";

export interface DrawerTab {
  id: string;
  label: ReactNode;
  count?: ReactNode;
  content: ReactNode;
}

export interface RowDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name: "Call details: dashboard_files". */
  label: string;
  status?: { tone: Tone; label: ReactNode };
  title: ReactNode;
  /** One line under the title: time · router · transport. */
  meta?: ReactNode;
  /** Small chips under the meta: risk, id, duration. */
  chips?: ReactNode;
  /** Next/previous row in the table. */
  nav?: { index: number; total: number; onPrev?: () => void; onNext?: () => void };
  /** A key that changes when the row changes, to slide the new content in. */
  rowKey?: string | number;
  tabs?: DrawerTab[];
  tab?: string;
  onTab?: (id: string) => void;
  /** Body when there are no tabs. */
  children?: ReactNode;
  /** Footer: buttons on the left, the main action on the right. */
  actions?: ReactNode;
  primary?: ReactNode;
  onOpenFull?: () => void;
  /** Remembers the width under this key. */
  storageKey?: string;
}

const MIN = 400;
const MAX = 720;

function readWidth(key?: string): number {
  if (!key) return 480;
  try {
    const n = Number(localStorage.getItem(`kit-drawer-w:${key}`));
    return n >= MIN && n <= MAX ? n : 480;
  } catch {
    return 480;
  }
}

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

export function RowDrawer({
  open,
  onClose,
  label,
  status,
  title,
  meta,
  chips,
  nav,
  rowKey,
  tabs,
  tab,
  onTab,
  children,
  actions,
  primary,
  onOpenFull,
  storageKey,
}: RowDrawerProps): ReactNode {
  const ref = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readWidth(storageKey));
  const [pinned, setPinned] = useState(false);
  const [phone, setPhone] = useState(false);
  const [ownTab, setOwnTab] = useState(tabs?.[0]?.id ?? "");
  const activeTab = tab ?? ownTab;
  const setTab = (id: string): void => (onTab ? onTab(id) : setOwnTab(id));

  useLayoutEffect(() => {
    if (open) setPhone(isPhone());
  }, [open]);

  // Slide in when opened.
  useEffect(() => {
    if (!open || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    return phone ? sheetIn(ref.current) : drawerIn(ref.current);
  }, [open, phone]);

  // New row: content slides in from the direction you moved.
  const lastIndex = useRef(nav?.index);
  useEffect(() => {
    if (!open || !body.current) return;
    const dir = nav && lastIndex.current != null && nav.index < lastIndex.current ? -1 : 1;
    lastIndex.current = nav?.index;
    swapIn(body.current, dir);
  }, [rowKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only on a new row

  // Esc closes; J/K (and ↑/↓ with Alt) move between rows.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector("[role=dialog][data-state=open], [role=menu]")) return;
      if (e.key === "Escape" && !typing()) {
        e.preventDefault();
        onClose();
      } else if ((e.key === "j" || e.key === "J") && !typing() && !e.metaKey && !e.ctrlKey)
        nav?.onNext?.();
      else if ((e.key === "k" || e.key === "K") && !typing() && !e.metaKey && !e.ctrlKey)
        nav?.onPrev?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, nav, onClose]);

  // Pinned: the page makes room for the drawer.
  useEffect(() => {
    const root = document.documentElement;
    if (open && pinned && !phone) {
      root.style.setProperty("--kit-drawer-dock", `${width}px`);
      root.dataset.kitDocked = "true";
    } else {
      root.style.removeProperty("--kit-drawer-dock");
      delete root.dataset.kitDocked;
    }
    return () => {
      root.style.removeProperty("--kit-drawer-dock");
      delete root.dataset.kitDocked;
    };
  }, [open, pinned, width, phone]);

  // Drag the left edge to resize.
  const drag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent): void =>
      setWidth(Math.min(MAX, Math.max(MIN, startW + (startX - ev.clientX))));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((w) => {
        try {
          if (storageKey) localStorage.setItem(`kit-drawer-w:${storageKey}`, String(w));
        } catch {
          /* storage unavailable */
        }
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Phone swipes: down closes, left/right moves.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: ReactPointerEvent): void => {
    if (phone && e.pointerType === "touch") swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onTouchEnd = (e: ReactPointerEvent): void => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
      const el = ref.current;
      if (el && !reducedMotion())
        animate(el, {
          translateY: "100%",
          duration: DUR.base,
          ease: "inQuad",
          onComplete: onClose,
        });
      else onClose();
    } else if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy))
      (dx < 0 ? nav?.onNext : nav?.onPrev)?.();
  };

  if (!open) return null;
  const current = tabs?.find((t) => t.id === activeTab) ?? tabs?.[0];
  return createPortal(
    <aside
      ref={ref}
      className={cn("kit-drawer", phone && "kit-drawer-phone")}
      style={phone ? undefined : { width }}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
      onPointerDown={onTouchStart}
      onPointerUp={onTouchEnd}
    >
      {!phone && (
        <div
          className="kit-drawer-edge"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize details"
          onPointerDown={drag}
        />
      )}
      <header className="kit-drawer-hd">
        {phone && <span className="grab" aria-hidden="true" />}
        <div className="kit-drawer-nav">
          {nav && (
            <>
              <button
                type="button"
                className="kit-ib"
                aria-label="Previous row"
                disabled={!nav.onPrev}
                onClick={nav.onPrev}
              >
                <ChevronUp aria-hidden="true" />
              </button>
              <button
                type="button"
                className="kit-ib"
                aria-label="Next row"
                disabled={!nav.onNext}
                onClick={nav.onNext}
              >
                <ChevronDown aria-hidden="true" />
              </button>
              <span className="pos">
                {nav.index + 1} of {nav.total.toLocaleString("en-US")}
              </span>
              {!phone && (
                <>
                  <Kbd>J</Kbd>
                  <Kbd>K</Kbd>
                </>
              )}
            </>
          )}
          <span className="sp" />
          {!phone && (
            <button
              type="button"
              className="kit-ib"
              aria-label={pinned ? "Unpin details" : "Pin details"}
              aria-pressed={pinned}
              onClick={() => setPinned((p) => !p)}
            >
              {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
            </button>
          )}
          {onOpenFull && !phone && (
            <button
              type="button"
              className="kit-ib"
              aria-label="Open full record"
              onClick={onOpenFull}
            >
              <ExternalLink aria-hidden="true" />
            </button>
          )}
          <button type="button" className="kit-ib" aria-label="Close details" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        {status && (
          <p className="kit-drawer-st" data-tone={status.tone}>
            <Led tone={status.tone} />
            {status.label}
          </p>
        )}
        <h2 className="kit-drawer-title">{title}</h2>
        {meta != null && <p className="kit-drawer-meta">{meta}</p>}
        {chips != null && <div className="kit-drawer-chips">{chips}</div>}
      </header>
      {tabs && tabs.length > 1 && (
        <div className="kit-drawer-tabs" role="tablist" aria-label="Details">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === current?.id}
              data-on={t.id === current?.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="c">{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      <div
        ref={body}
        className="kit-drawer-body"
        role={tabs && tabs.length > 1 ? "tabpanel" : undefined}
      >
        {current ? current.content : children}
      </div>
      {(actions != null || primary != null) && (
        <footer className="kit-drawer-ft">
          {actions}
          <span className="sp" />
          {primary}
        </footer>
      )}
    </aside>,
    document.body,
  );
}

/** Key–value list for a drawer's overview tab. */
export function DetailList({
  items,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean }[];
}): ReactNode {
  return (
    <dl className="kit-kv">
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt>{it.label}</dt>
          <dd className={it.mono ? "m" : undefined}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A labelled block in a drawer: "INPUT · 2 lines". */
export function DetailBlock({
  label,
  aside,
  children,
}: {
  label: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="kit-dblock">
      <div className="kit-dcap">
        <span>{label}</span>
        {aside != null && <span>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** Duration against a reference such as the tool's p95. */
export function DurationBar({
  ms,
  ref95,
  format = (n) => `${Math.round(n)} ms`,
}: {
  ms: number;
  ref95?: number | null;
  format?: (n: number) => string;
}): ReactNode {
  const max = Math.max(ms, ref95 ?? 0) * 1.6 || 1;
  return (
    <div className="kit-dur">
      <div className="t">
        <span>Duration</span>
        <b>{format(ms)}</b>
      </div>
      <div className="tr" aria-hidden="true">
        <i style={{ width: `${Math.min(100, (ms / max) * 100)}%` }} />
        {ref95 != null && <u style={{ left: `${Math.min(100, (ref95 / max) * 100)}%` }} />}
      </div>
      {ref95 != null && (
        <div className="t">
          <span>{ms <= ref95 ? "faster than this tool’s p95" : "slower than this tool’s p95"}</span>
          <span className="p95">p95 {format(ref95)}</span>
        </div>
      )}
    </div>
  );
}
