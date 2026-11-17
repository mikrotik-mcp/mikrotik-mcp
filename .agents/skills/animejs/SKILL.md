---
name: animejs
description: Motion for the observability dashboard with anime.js v4 (the `animejs` package). Use when adding or changing animation in ui/ — entrances, list staggers, number tickers, SVG line drawing, scroll reveals, timelines, springs, or draggable UI — and when deciding whether a UI change needs motion at all.
---

# anime.js v4 in this project

`animejs@4` is a dev dependency (the dashboard is bundled by Vite). Docs: https://animejs.com/documentation. The API below was checked against `node_modules/animejs/dist/modules/index.d.ts`. When the docs and the types disagree, the types win.

## Decide first: does this need motion?

Motion has to tell the user something: where an element came from, what changed, or that something is in progress. Skip it when it is only decoration.

- Keep UI motion short: 120–240 ms for hovers and small state changes, 240–400 ms for entrances. Use `ease: 'outQuart'`, `'outExpo'` or a spring. Never `linear` for UI, except for progress indicators.
- Animate only `transform` (`x`, `y`, `scale`, `rotate`) and `opacity`. Never animate width, height, top or left on large lists.
- Respect `prefers-reduced-motion`. Every scope gets a `reduceMotion` query (see below).
- Use CSS `transition` for plain hover and focus colors. Use anime.js for sequences, staggers, values (numbers, SVG paths) and anything driven from JS.
- `motion/react` is already used by the beui components. Leave those as they are. Use anime.js for new imperative or sequenced motion, and do not mix both on one element.

## Imports

Named imports only, from the package root:

```ts
import { animate, createScope, createTimeline, stagger, spring, utils, svg, onScroll } from "animejs";
```

Other exports: `createTimer`, `createAnimatable`, `createDraggable`, `createLayout`, `splitText`, `scrambleText`, `createSpring`, `cubicBezier`, `steps`, `waapi`, `eases`.

## React pattern: always use a scope

A scope ties every animation to a root element. `revert()` on unmount removes the animations and their inline styles, so React StrictMode double mounts stay clean.

```tsx
import { useEffect, useRef } from "react";
import { animate, createScope, stagger, type Scope } from "animejs";

export function DeviceList({ items }: { items: Device[] }) {
  const root = useRef<HTMLUListElement>(null);
  const scope = useRef<Scope | null>(null);

  useEffect(() => {
    scope.current = createScope({
      root,
      mediaQueries: { reduceMotion: "(prefers-reduced-motion: reduce)" },
    }).add((self) => {
      const reduce = self?.matches.reduceMotion;
      animate("li", {
        opacity: [0, 1],
        y: reduce ? 0 : [8, 0],
        duration: reduce ? 0 : 320,
        delay: stagger(30),
        ease: "outQuart",
      });
    });
    return () => scope.current?.revert();
  }, [items.length]);

  return <ul ref={root}>{/* … */}</ul>;
}
```

Selectors inside `.add()` resolve inside `root` only. To trigger animation from an event handler, register a method: `self.add("pulse", (id) => animate(...))`, then call `scope.current?.methods.pulse(id)`.

## Recipes

- **Number ticker** (traffic, counts): animate a plain object and write the value in `onUpdate`. Round with `utils.round(v, 0)`. Show tabular numbers.
- **Sequenced entrance**: `createTimeline({ defaults: { ease: "outQuart", duration: 280 } }).add(a, {...}).add(b, {...}, "-=180")`.
- **SVG line draw** (topology links, sparklines): `animate(svg.createDrawable(path), { draw: ["0 0", "0 1"], duration: 600 })`.
- **Scroll reveal**: `animate(el, { opacity: [0, 1], autoplay: onScroll({ enter: "bottom top" }) })`.
- **Spring** for press or drop feedback: `ease: spring({ bounce: 0.2, duration: 300 })`.

## Colors and values

Animate CSS variables from the design system, not hex values. Read a token with `getComputedStyle(el).getPropertyValue("--success")`. Hard-coded hex in TSX strings fails `tests/observability-ui.spec.ts`.
