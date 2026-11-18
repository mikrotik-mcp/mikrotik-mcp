/**
 * The panel's motion system (Kit-Data-Motion): one set of timings and curves,
 * and the helpers the kit, charts and pages share. Every animation is skipped
 * with reduced motion, leaving only opacity and colour.
 */
import { animate, spring, stagger } from "animejs";

/** Timing tokens, in ms. */
export const DUR = {
  /** Press feedback. */
  instant: 80,
  /** Hover, focus, colour (usually CSS transitions). */
  quick: 140,
  /** Menus, tooltips, tabs, pills, row swaps. */
  base: 220,
  /** Drawers, dialogs, page sections entering. */
  slow: 320,
  /** Chart lines and rings drawing in, number tickers. */
  draw: 700,
} as const;

/** Gap between items entering, and the most items that get one. */
export const STAGGER = 24;
export const STAGGER_MAX = 12;

/** Curves. `spring` settles with a tiny overshoot; `back` lands with a nudge. */
export const EASE = {
  enter: "outQuart",
  exit: "inQuad",
  back: "outBack(1.2)",
  spring: spring({ bounce: 0.18, duration: DUR.slow }),
} as const;

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Below this width, menus and pickers open as a bottom sheet. */
export const PHONE_QUERY = "(max-width: 640px)";

export function isPhone(): boolean {
  return typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;
}

/** A floating surface grows from its anchor; its rows rise in one after another. */
export function popIn(panel: HTMLElement, rows?: Iterable<HTMLElement>): () => void {
  if (reducedMotion()) return () => {};
  const motion = [
    animate(panel, { opacity: [0, 1], scale: [0.96, 1], duration: 180, ease: EASE.enter }),
  ];
  const list = rows ? [...rows].slice(0, 14) : [];
  if (list.length > 0)
    motion.push(
      animate(list, {
        opacity: [0, 1],
        translateY: [4, 0],
        duration: 200,
        delay: stagger(18, { start: 40 }),
        ease: EASE.enter,
      }),
    );
  return () => {
    for (const m of motion) m.revert();
  };
}

/** A sheet slides up from the bottom edge. */
export function sheetIn(panel: HTMLElement): () => void {
  if (reducedMotion()) return () => {};
  const a = animate(panel, { translateY: ["100%", "0%"], duration: 240, ease: EASE.enter });
  return () => {
    a.revert();
  };
}

/** A drawer slides in from the right with a soft spring. */
export function drawerIn(panel: HTMLElement): () => void {
  if (reducedMotion()) {
    const a = animate(panel, { opacity: [0, 1], duration: DUR.instant });
    return () => {
      a.revert();
    };
  }
  const a = animate(panel, { translateX: ["100%", "0%"], ease: EASE.spring });
  return () => {
    a.revert();
  };
}

/** New content replaces old in place: it slides 12 px from `dir` and fades in. */
export function swapIn(el: HTMLElement, dir: 1 | -1 = 1): void {
  if (reducedMotion()) return;
  animate(el, { opacity: [0, 1], translateY: [12 * dir, 0], duration: DUR.base, ease: EASE.enter });
}

/**
 * Page entrance: the direct children of `root` (header, KPI row, panels) rise
 * 8 px and fade in, in reading order, STAGGER ms apart.
 */
export function enter(root: HTMLElement | null, selector = ":scope > *"): () => void {
  if (!root || reducedMotion()) return () => {};
  const items = [...root.querySelectorAll<HTMLElement>(selector)].slice(0, STAGGER_MAX);
  if (items.length === 0) return () => {};
  const a = animate(items, {
    opacity: [0, 1],
    translateY: [8, 0],
    duration: DUR.slow,
    delay: stagger(STAGGER),
    ease: EASE.enter,
  });
  return () => {
    a.revert();
  };
}

/** A row that just arrived: slides down and flashes teal, fading over 1.2 s. */
export function arrive(row: HTMLElement): void {
  if (reducedMotion()) return;
  animate(row, { opacity: [0, 1], translateY: [-8, 0], duration: DUR.base, ease: EASE.enter });
  row.dataset.kitNew = "true";
  setTimeout(() => {
    delete row.dataset.kitNew;
  }, 1200);
}

/** Counts a number up or down to its new value. */
export function tick(
  el: HTMLElement,
  from: number,
  to: number,
  format: (n: number) => string = (n) => Math.round(n).toLocaleString("en-US"),
): () => void {
  if (reducedMotion() || from === to) {
    el.textContent = format(to);
    return () => {};
  }
  const state = { v: from };
  const a = animate(state, {
    v: to,
    duration: DUR.draw,
    ease: EASE.enter,
    onUpdate: () => {
      el.textContent = format(state.v);
    },
  });
  return () => {
    a.pause();
    el.textContent = format(to);
  };
}

/** Moves the highlight bar behind the active row. */
export function glide(bar: HTMLElement, row: HTMLElement | null): void {
  if (!row) {
    bar.style.opacity = "0";
    return;
  }
  const to = { translateY: row.offsetTop, height: row.offsetHeight };
  if (reducedMotion() || bar.style.opacity !== "1") {
    bar.style.transform = `translateY(${to.translateY}px)`;
    bar.style.height = `${to.height}px`;
    bar.style.opacity = "1";
    return;
  }
  animate(bar, { ...to, duration: 160, ease: EASE.enter });
}

/** A short horizontal shake for a field that failed validation. */
export function shake(el: HTMLElement): void {
  if (reducedMotion()) return;
  animate(el, { translateX: [0, 4, -4, 3, -2, 0], duration: 320, ease: "outQuad" });
}

/** Draws a check mark's stroke. */
export function drawCheck(path: SVGPathElement | null): void {
  if (!path || reducedMotion()) return;
  animate(path, { strokeDashoffset: [20, 0], duration: 180, ease: EASE.enter });
}
