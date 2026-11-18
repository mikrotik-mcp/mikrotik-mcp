# Putting an ASCII effect on a page

## Layering

`AsciiShader` and `AsciiGrid` fill their nearest positioned ancestor. Content goes in a sibling, above:

```tsx
<section className="relative isolate overflow-hidden">
  <HeroBackground className="absolute inset-0 -z-10" />
  <div className="relative mx-auto max-w-3xl px-6 py-32">…</div>
</section>
```

- `isolate` on the section keeps `-z-10` inside it, so the effect never slips behind the page background.
- The section needs height from its content or a `min-h-*`. A renderer takes the size it is given; zero height draws nothing.
- Round corners and borders go on the section with `overflow-hidden`, so the canvas is clipped to them.
- Renderers ignore the pointer unless `interactive` or `interaction` is set, so links and buttons above stay clickable. An interactive background still sits under content: give the content `pointer-events-none` on empty areas only if the effect should react there.

## Landing pages

Read [landing-pages.md](landing-pages.md) first. These are the placements.

- **Hero:** a full-bleed effect behind the headline. Clear the area under the text (tone near 0) and let the effect peak toward the edges or a corner. Fade it out at the bottom with `smoothstep` on `uv.y` so the next section starts clean.
- **Clearing space for text:** measure the text block and pass its box to the field as a uniform. [recipes.md](recipes.md#a-hero-that-clears-its-headline) has the component. An ellipse in `uv` is too big on desktop and too small on a phone.
- **Section break:** a band 6 to 12 rows tall: a glyph gradient, a row of box-drawing characters, or a slow wave in Braille.
- **Feature card:** a small `AsciiGrid` or shader behind the top half of a card, under the icon and title.
- **Terminal pane:** a `rounded-lg border bg-black` box with an `AsciiGrid` or a `<pre>`, wrapped in `className="dark"` so the tokens take their dark values.
- **Behind a big number or headline:** a glow or a rotating object centred behind the text. Real text stays HTML on top; never draw the headline into the field.

## Meters, traces and status

- **Traces and meters:** draw them in an `AsciiGrid` (Braille lines, `EIGHTHS_UP` bars, `blocks` for density) or as DOM text in a `<pre>`. Keep the value and the label as HTML text beside or over the glyphs.
- **Accessible names:** a trace canvas gets `role="img"` and an `aria-label` with the data in words, or a visually hidden table. A meter gets `role="meter"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`.
- **Many on one page:** at most 8 `AsciiShader` instances hold a WebGL context at once; others show their fallback until one scrolls away. Use `AsciiGrid` (Canvas2D) or DOM text for grids of small pieces.
- **Colour meaning:** status colours from the palette (`"green"`, `"orange"`, `"red"`) map to good, warning and critical. Pair colour with a glyph or label so it never carries meaning alone (`█` up, `▒` degraded, `·` no data).

## Sizing cells

`--ascii-cell` sets the glyph height for the whole page (12px by default). Override it on a wrapper for one section, or pass `cell` to one component. 10 to 12px reads as texture, 14 to 18px as deliberate ASCII art, 20px and up as large letters. Cells always snap to whole device pixels; don't scale a renderer with CSS `transform: scale()`, which blurs the glyphs.

## Next.js and server components

- Files that use `AsciiShader`, `AsciiGrid`, `useAsciiColors`, `useFrameLoop` or a canvas start with `"use client"`. A server page imports and renders them like any component.
- `AsciiPre`, `frameToText`, `mapTones` and the charset helpers run on the server too.
- Webcam and file input stay in the browser: read them with `useMediaElement` in a client component and never upload them.
