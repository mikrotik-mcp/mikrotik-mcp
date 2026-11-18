/**
 * Chart tooltips (Kit-Data-Tooltips). Every chart, graph and diagram shows the
 * same card on hover, keyboard focus or tap: a title, rows of label and value,
 * an optional footer and at most one action.
 *
 * One layer (`ChartTipLayer`, mounted once in main.tsx) draws the card. Charts
 * call `showTip(anchor, card)` and `hideTip()`, or spread `tipProps(card)` on
 * an SVG element. Line and area charts use `LineHover` for the crosshair.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode, SVGProps } from "react";
import { createPortal } from "react-dom";
import { animate } from "animejs";
import { ChevronRight } from "lucide-react";
import { DUR, EASE, isPhone, reducedMotion } from "./motion";
import { Led } from "./listbox";
import type { Tone } from "./listbox";

export interface TipRow {
  label: ReactNode;
  value: ReactNode;
  /** Swatch colour, a CSS colour or var(): the series colour. */
  color?: string;
}

export interface TipCard {
  title: ReactNode;
  /** Small mono text after the title: "yesterday", the router name. */
  sub?: ReactNode;
  led?: Tone;
  rows: TipRow[];
  foot?: { label: ReactNode; value: ReactNode; tone?: "up" | "down" };
  action?: { label: string; icon?: ReactNode; onClick: () => void };
}

/** A point on screen (viewport px), or an element whose box the card sits beside. */
export type TipAnchor = { x: number; y: number } | Element;

type State = { card: TipCard; anchor: TipAnchor; key: number; strip?: boolean } | null;

let current: State = null;
let seq = 0;
const listeners = new Set<(s: State) => void>();
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const l of listeners) l(current);
}

/** `strip`: on a phone, a full-width strip under the anchor (the chart) instead of a card. */
export function showTip(anchor: TipAnchor, card: TipCard, opts: { strip?: boolean } = {}): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  current = { card, anchor, key: ++seq, strip: opts.strip };
  emit();
}

/** Hides after a short delay, so the pointer can reach a card with an action. */
export function hideTip(now = false): void {
  if (hideTimer) clearTimeout(hideTimer);
  const go = (): void => {
    current = null;
    emit();
  };
  if (now) go();
  else hideTimer = setTimeout(go, 140);
}

/** Props for one SVG or HTML element that shows `card` on hover, focus or tap. */
export function tipProps(card: TipCard | (() => TipCard)): {
  onPointerEnter: (e: PointerEvent<Element>) => void;
  onPointerLeave: () => void;
  onFocus: (e: { currentTarget: Element }) => void;
  onBlur: () => void;
  tabIndex: number;
  "data-tip": string;
} {
  const get = (): TipCard => (typeof card === "function" ? card() : card);
  return {
    onPointerEnter: (e) => showTip(e.currentTarget, get()),
    onPointerLeave: () => hideTip(),
    onFocus: (e) => showTip(e.currentTarget, get()),
    onBlur: () => hideTip(),
    tabIndex: 0,
    "data-tip": "true",
  };
}

/* ------------------------------------------------------------------- card */

export function TipCardView({ card }: { card: TipCard }): ReactNode {
  return (
    <>
      <div className="kit-tip-hd">
        {card.led && <Led tone={card.led} />}
        <b>{card.title}</b>
        {card.sub != null && <span>{card.sub}</span>}
      </div>
      {card.rows.map((r, i) => (
        <div key={i} className="kit-tip-row">
          {r.color && <i style={{ background: r.color }} aria-hidden="true" />}
          <span className="k">{r.label}</span>
          <b>{r.value}</b>
        </div>
      ))}
      {card.foot && (
        <div className="kit-tip-ft">
          <span>{card.foot.label}</span>
          <span data-tone={card.foot.tone}>{card.foot.value}</span>
        </div>
      )}
      {card.action && (
        <button
          type="button"
          className="kit-tip-act"
          onClick={() => {
            card.action!.onClick();
            hideTip(true);
          }}
        >
          {card.action.icon ?? <ChevronRight aria-hidden="true" />}
          {card.action.label}
        </button>
      )}
    </>
  );
}

/** Plain-text version of a card, for screen readers. */
function spoken(card: TipCard): string {
  const t = (n: ReactNode): string =>
    typeof n === "string" || typeof n === "number" ? String(n) : "";
  return [t(card.title), t(card.sub), ...card.rows.map((r) => `${t(r.label)} ${t(r.value)}`)]
    .filter(Boolean)
    .join(", ");
}

/* ------------------------------------------------------------------ layer */

const GAP = 12;

function place(
  anchor: TipAnchor,
  w: number,
  h: number,
  strip = false,
): { x: number; y: number; phone: boolean } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (strip && anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 8, phone: true };
  }
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    // Beside the element, on the right; flip left or above when it does not fit.
    let x = r.right + GAP;
    let y = r.top + r.height / 2 - h / 2;
    if (x + w > vw - 8) x = r.left - GAP - w;
    if (x < 8) {
      x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
      y = r.top - GAP - h;
      if (y < 8) y = r.bottom + GAP;
    }
    return { x, y: Math.min(Math.max(8, y), vh - h - 8), phone: false };
  }
  let x = anchor.x + GAP * 2;
  if (x + w > vw - 8) x = anchor.x - GAP * 2 - w;
  const y = Math.min(Math.max(8, anchor.y - h / 2), vh - h - 8);
  return { x: Math.max(8, x), y, phone: false };
}

/** Mount once, near the app root. */
export function ChartTipLayer(): ReactNode {
  const [state, setState] = useState<State>(current);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  useEffect(() => {
    listeners.add(setState);
    const away = (): void => hideTip(true);
    // A card whose chart left the page (navigation, re-render) goes too.
    const gone = (): void => {
      if (current && current.anchor instanceof Element && !current.anchor.isConnected)
        hideTip(true);
    };
    window.addEventListener("scroll", away, true);
    window.addEventListener("hashchange", away);
    window.addEventListener("pointermove", gone, { passive: true });
    const timer = setInterval(gone, 500);
    return () => {
      listeners.delete(setState);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("hashchange", away);
      window.removeEventListener("pointermove", gone);
      clearInterval(timer);
    };
  }, []);

  // Glide to the new spot; fade in the first time.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      shown.current = false;
      return;
    }
    if (!state) return;
    if (state.strip && state.anchor instanceof Element)
      el.style.width = `${state.anchor.getBoundingClientRect().width}px`;
    else el.style.width = "";
    const { x, y } = place(state.anchor, el.offsetWidth, el.offsetHeight, state.strip);
    if (!shown.current || reducedMotion()) {
      el.style.transform = `translate(${x}px, ${y}px)`;
      if (!reducedMotion()) animate(el, { opacity: [0, 1], duration: DUR.quick, ease: EASE.enter });
      shown.current = true;
      return;
    }
    animate(el, { translateX: x, translateY: y, duration: DUR.base, ease: EASE.spring });
  }, [state]);

  if (!state) return null;
  return createPortal(
    <div
      ref={ref}
      className="kit-ctip"
      data-strip={state.strip || undefined}
      role="tooltip"
      onPointerEnter={() => {
        if (hideTimer) clearTimeout(hideTimer);
      }}
      onPointerLeave={() => hideTip()}
    >
      {state.strip ? <StripView card={state.card} /> : <TipCardView card={state.card} />}
      <span className="sr-only" aria-live="polite">
        {spoken(state.card)}
      </span>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------- LineHover */

export interface LineHoverProps {
  /** The chart's viewBox size; the overlay draws in the same space. */
  width: number;
  height: number;
  /** x and y (in viewBox units) of each point of the main series. */
  points: readonly [number, number][];
  /** The card for point i. */
  card: (i: number) => TipCard;
  /** Accessible name for the focusable chart, e.g. "Calls over 24 hours". */
  label: string;
  /** Width of the highlighted band around the point, in viewBox units. */
  band?: number;
  /** Marks drawn on top of the dot, e.g. a failed-call dot at index i. */
  extra?: (i: number) => ReactNode;
  color?: string;
}

/**
 * Crosshair, band and dot that snap to the nearest point, with the shared card.
 * Put it inside the chart's <svg>, after the series. Arrow keys step through
 * points when the chart has focus; on a phone a tap shows the card under the
 * chart instead of over it.
 */
export function LineHover({
  width,
  height,
  points,
  card,
  label,
  band = 32,
  extra,
  color = "var(--sig)",
}: LineHoverProps): ReactNode {
  const [i, setI] = useState<number | null>(null);
  const rect = useRef<SVGRectElement>(null);
  const dot = useRef<SVGGElement>(null);
  // A chart stretched with preserveAspectRatio="none" would squash the dot; undo it.
  const ratio = useRef(1);
  const measure = (): DOMRect => {
    const r = rect.current!.ownerSVGElement!.getBoundingClientRect();
    const sx = r.width / width;
    const sy = r.height / height;
    ratio.current = sx > 0 && sy > 0 ? sy / sx : 1;
    return r;
  };

  const nearest = (clientX: number): number => {
    const r = rect.current!.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * width;
    let best = 0;
    for (let k = 1; k < points.length; k++)
      if (Math.abs(points[k]![0] - x) < Math.abs(points[best]![0] - x)) best = k;
    return best;
  };
  const show = (k: number): void => {
    setI(k);
    const svg = rect.current!.ownerSVGElement!;
    const r = measure();
    if (isPhone()) {
      showTip(svg, card(k), { strip: true });
      return;
    }
    const [px, py] = points[k]!;
    showTip({ x: r.left + (px / width) * r.width, y: r.top + (py / height) * r.height }, card(k));
  };
  const clear = (): void => {
    setI(null);
    hideTip();
  };

  // The dot glides between points.
  const last = useRef<number | null>(null);
  useLayoutEffect(() => {
    const g = dot.current;
    if (!g || i == null) {
      last.current = null;
      return;
    }
    const [x, y] = points[i]!;
    const sc = `scale(${ratio.current} 1)`;
    if (last.current == null || reducedMotion())
      g.setAttribute("transform", `translate(${x} ${y}) ${sc}`);
    else {
      const from = points[last.current]!;
      const st = { x: from[0], y: from[1] };
      animate(st, {
        x,
        y,
        duration: DUR.base,
        ease: EASE.enter,
        onUpdate: () => g.setAttribute("transform", `translate(${st.x} ${st.y}) ${sc}`),
      });
    }
    last.current = i;
  }, [i, points]);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End")
      return;
    e.preventDefault();
    const n = points.length;
    const k =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? n - 1
          : Math.min(
              n - 1,
              Math.max(
                0,
                (i ?? (e.key === "ArrowLeft" ? n : -1)) + (e.key === "ArrowLeft" ? -1 : 1),
              ),
            );
    const r = measure();
    setI(k);
    const [px, py] = points[k]!;
    showTip({ x: r.left + (px / width) * r.width, y: r.top + (py / height) * r.height }, card(k));
  };

  const x = i == null ? 0 : points[i]![0];
  return (
    <>
      {i != null && (
        <g pointerEvents="none" className="kit-line-hover">
          <rect x={x - band / 2} y={0} width={band} height={height} rx={8} fill="var(--glass-2)" />
          <line
            x1={x}
            x2={x}
            y1={0}
            y2={height}
            stroke={color}
            strokeOpacity={0.5}
            strokeDasharray="3 4"
          />
          {extra?.(i)}
          <g ref={dot}>
            <circle r={9} fill={color} opacity={0.18} />
            <circle r={4.5} fill="var(--surface-2)" stroke={color} strokeWidth={2} />
          </g>
        </g>
      )}
      <rect
        ref={rect}
        x={0}
        y={0}
        width={width}
        height={height}
        fill="transparent"
        tabIndex={0}
        role="img"
        aria-label={label}
        className="kit-line-hit"
        onPointerMove={(e) => {
          if (e.pointerType !== "touch") show(nearest(e.clientX));
        }}
        onPointerDown={(e) => {
          if (e.pointerType === "touch") show(nearest(e.clientX));
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch") clear();
        }}
        onBlur={clear}
        onKeyDown={onKey}
      />
    </>
  );
}

/** On a phone the values sit in a strip under the chart. */
function StripView({ card }: { card: TipCard }): ReactNode {
  return (
    <div className="kit-tip-strip">
      <span className="t">{card.title}</span>
      {card.rows.map((r, k) => (
        <span key={k} className="r">
          {r.color && <i style={{ background: r.color }} aria-hidden="true" />}
          <b>{r.value}</b>
          <span>{typeof r.label === "string" ? r.label.toLowerCase() : r.label}</span>
        </span>
      ))}
    </div>
  );
}

/** SVG props helper: a hit target that shows a card (for bars, nodes, arcs). */
export function TipTarget({
  card,
  children,
  ...rest
}: { card: TipCard | (() => TipCard); children?: ReactNode } & SVGProps<SVGGElement>): ReactNode {
  return (
    <g {...rest} {...tipProps(card)} className={`kit-tip-target ${rest.className ?? ""}`}>
      {children}
    </g>
  );
}
