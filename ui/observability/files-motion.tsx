/**
 * Motion for the Files page, on the kit timings (kit/motion.ts). Every helper
 * runs inside an anime.js scope that is reverted on cleanup, and does nothing
 * with reduced motion.
 */
import { animate, createScope, stagger } from "animejs";
import type { RefObject } from "react";
import { useEffect } from "react";
import { DUR, EASE, STAGGER, STAGGER_MAX, reducedMotion } from "./kit";

/** Children matching `selector` rise 8 px and fade in, STAGGER ms apart. */
export function rise(root: HTMLElement | null, selector: string, delay = 0): () => void {
  if (!root || reducedMotion()) return () => {};
  const items = [...root.querySelectorAll<HTMLElement>(selector)].slice(0, STAGGER_MAX * 2);
  if (items.length === 0) return () => {};
  const scope = createScope({ root }).add(() => {
    animate(items, {
      opacity: [0, 1],
      translateY: [8, 0],
      duration: DUR.slow,
      delay: stagger(STAGGER, { start: delay }),
      ease: EASE.enter,
    });
  });
  return () => scope.revert();
}

/** Runs `rise` when one of `deps` changes. */
export function useRise(
  ref: RefObject<HTMLElement | null>,
  selector: string,
  deps: readonly unknown[],
): void {
  useEffect(
    () => rise(ref.current, selector),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names the triggers
    deps,
  );
}

/** A dialog card scales up from 0.97 and fades in. */
export function popInDialog(card: HTMLElement | null): () => void {
  if (!card || reducedMotion()) return () => {};
  const scope = createScope({ root: card }).add(() => {
    animate(card, {
      opacity: [0, 1],
      scale: [0.97, 1],
      translateY: [6, 0],
      duration: DUR.slow,
      ease: EASE.enter,
    });
  });
  return () => scope.revert();
}

/** Counts the text of `el` from `from` to `to`. */
export function count(
  el: HTMLElement | null,
  from: number,
  to: number,
  format: (n: number) => string = (n) => Math.round(n).toLocaleString("en-US"),
): () => void {
  if (!el) return () => {};
  if (reducedMotion() || from === to) {
    el.textContent = format(to);
    return () => {};
  }
  const state = { v: from };
  const scope = createScope({ root: el }).add(() => {
    animate(state, {
      v: to,
      duration: DUR.draw,
      ease: EASE.enter,
      onUpdate: () => {
        el.textContent = format(state.v);
      },
    });
  });
  return () => {
    scope.revert();
    el.textContent = format(to);
  };
}
