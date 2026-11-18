# Quality checks

Run every check before calling an effect done. Each is something you can see or measure.

## Glyphs

- Individual glyphs read at 100% zoom. Zoom into a screenshot: you see characters, not a blur, not pixel dots, not a flat block.
- Glyphs are crisp at device pixel ratio 1, 2 and 3, and after browser zoom. A blurry result means the canvas is scaled by CSS or the cell isn't whole device pixels; let the renderer size itself.
- The effect uses more than two or three glyphs. A field stuck between two tones draws a flat pattern; widen its range or raise `grade.contrast`.
- Shapes are round where they should be (aspect corrected with `res.x / res.y`) and look right in both `standard` and `braille`.
- The box has the intended size at 1440px and 390px wide, with no horizontal scroll at 390px.
- Light and dark mode both look intentional. Toggle the `.dark` class to check; the media query alone doesn't change a shadcn theme.

## Text and contrast

- Text over glyphs has 4.5:1 contrast against the densest glyphs behind it, or sits on cleared ground or its own panel.
- Real text stays real: headings, labels and values are HTML, selectable and read by screen readers. Never draw copy into a canvas.

## Motion and accessibility

- With `prefers-reduced-motion: reduce`, the renderer root has `data-state="static"` and shows a finished frame (`stillTime`). Emulate it: `agent-browser set media dark reduced-motion`, Playwright `page.emulateMedia({ reducedMotion: "reduce" })`, or DevTools Rendering.
- Offscreen and in a hidden tab, the root reports `data-state="paused"`.
- Decorative canvases are `aria-hidden` (the renderers set it by default). Data visuals have an accessible name with the value.
- Nothing flashes more than three times a second. Glyphs that change every frame at random (`hash21` with raw `t`) flicker; quantise time.
- Controls you add (charset pickers, export buttons) are keyboard reachable with a visible focus ring.

## Performance

- At most 8 `AsciiShader`s are live at a time. Use `AsciiGrid` or DOM text for many small pieces.
- The `field` string is a module-level constant; changing values go through `uniforms`.
- Keep fields cheap: `fbm` is four noise calls, and Braille samples eight points per glyph. A field calling `fbm` a dozen times can drop frames on a phone at small cell sizes.
- `AsciiGrid` draw functions allocate nothing per frame: create tone fields and arrays once per size and reuse them.
- Images and video are sampled at grid size, never at full camera resolution.

## Console

- No compile errors, `uniform … skipped` warnings, or WebGL context-lost messages.
- No hydration warnings: client-only values (theme colours, sizes, `Math.random`) are read in effects or hooks, not during render.

## Checking state in a browser

```js
[...document.querySelectorAll("[data-state]")].map((el) => el.dataset.state);
// "running" on screen, "static" under reduced motion, "paused" offscreen, "fallback" when nothing drew
```
