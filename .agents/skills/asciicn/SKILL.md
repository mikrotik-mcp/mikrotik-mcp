---
name: asciicn
description: Build ASCII art, ANSI art and text-mode visuals with the asciicn engine (lib/ascii, a WebGL2 glyph shader and Canvas2D grids) in a React or shadcn/ui app. Use when the user wants ASCII, ANSI, Braille, CP437, PETSCII, katakana, halftone glyphs, a terminal or CRT look, an ASCII background, hero, painted landscape or city scene, halftone dots, 3D object, terminal window, meter, card, loader, text effect, or image/video/webcam to ASCII, or a .txt/.ans/.svg/.png/.webm export, or when code imports lib/ascii or components/asciicn.
---

# asciicn

asciicn is an ASCII engine. It draws pictures with real glyphs: a tone from 0 (empty) to 1 (full) becomes a character from a charset, coloured by a colour mode, on a grid of cells that snap to whole device pixels. You build the effect the user asked for on top of it. The asciicn components and backgrounds are examples of what the engine draws, not a menu. Install one only when it is exactly what the user asked for. Otherwise write your own, and borrow technique from the closest example's source.

The engine has two renderers that share one set of look props:

- **`AsciiShader`** (`@/lib/ascii/shader`, registry item `ascii-shader`): WebGL2. You write a GLSL `field` that returns a tone per sample; the GPU picks glyphs from a glyph atlas. For anything that moves or varies per cell: backgrounds, city skylines, glows, noise, fog, water.
- **`AsciiGrid`** (`@/lib/ascii`, registry item `ascii-core`): Canvas2D. You write a `draw` function that fills a frame of glyphs on the CPU, directly or through `mapTones`. For things you compute in JavaScript: 3D meshes, simulations, terminal panes, sampled images and video, text layouts.

## 1. Set up the engine

Find the engine: `lib/ascii/index.ts`, under the `lib` alias in `components.json` (imports below use `@/lib/ascii`; use the project's alias). If it is missing, install it:

```bash
npx shadcn@latest add https://asciicn.dev/r/ascii-core.json https://asciicn.dev/r/ascii-shader.json https://asciicn.dev/r/ascii-export.json
```

That also installs `ascii-tokens`: the CSS variables `--ascii-ink`, `--ascii-paper`, `--ascii-cell`, `--ascii-font`, `--ascii-glow` and `--ascii-color-<name>`, written into the project's global CSS and mapped to the shadcn `--primary` and `--background`. The engine needs React 19 and Tailwind CSS v4.

If `lib/ascii` exists but lacks something this skill names (TypeScript says a prop such as `colorField` or `charset` doesn't exist on `AsciiShader`, or `lib/ascii/grid.tsx` is missing), replace the engine. This keeps the project's `lib/utils.ts` (`yes n` answers no to every overwrite question):

```bash
rm -rf lib/ascii && yes n | npx shadcn@latest add https://asciicn.dev/r/ascii-core.json https://asciicn.dev/r/ascii-shader.json https://asciicn.dev/r/ascii-export.json
```

Don't use `--overwrite`: it also replaces `lib/utils.ts`. If the project edited files inside `lib/ascii`, tell the user before replacing them.

Done when `lib/ascii/index.ts`, `lib/ascii/grid.tsx` and `lib/ascii/shader.tsx` exist and the global CSS defines `--ascii-ink`.

## 2. Pick the technique

| The user wants                                                                              | Use                                                                   | Read                                                  |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| A background or hero that is a picture: a landscape, a city, a place at a time of day       | `AsciiShader`, `field` + `colorField`, `dots`, `square`, `truecolor`  | [scenes.md](references/scenes.md)                     |
| A surface whose tone varies per cell or moves: gradients, noise, fog, water, nebulae, glows | `AsciiShader` with a GLSL `field`                                     | [fields.md](references/fields.md)                     |
| Many hues at once: a rainbow, a sunset, a hue per shape                                     | `AsciiShader` with a `field` and a `colorField`, `truecolor` mode     | [fields.md](references/fields.md#colour)              |
| Something you compute in JavaScript: a 3D mesh, particles, a simulation, a game of life     | `AsciiGrid` + `createToneField` + `mapTones`                          | [engine-api.md](references/engine-api.md#asciigrid)   |
| A waveform, a line of values, a meter or a progress bar                                     | `AsciiGrid` writing glyphs (`eighthsBar`, Braille, `BOX`) or DOM text | [recipes.md](references/recipes.md#a-braille-trace)   |
| A terminal pane, boxed panel, status line or log                                            | `AsciiGrid` with `frame.write` and `BOX`, or a `<pre>`                | [recipes.md](references/recipes.md#a-terminal-pane)   |
| A photo, logo, video or webcam as ASCII                                                     | `sampleToField` into `mapTones` on an `AsciiGrid`                     | [recipes.md](references/recipes.md#an-image-as-ascii) |
| Static ASCII art that must render on the server or in an email                              | `AsciiPre` (a `<pre>` of a frame), or plain text in a `<pre>`         | [engine-api.md](references/engine-api.md#static-art)  |
| A file: `.txt`, `.ans`, `.svg`, `.png`, `.webm`                                             | `ascii-export`                                                        | [export.md](references/export.md)                     |

Then choose a charset and a colour mode for the picture with [charsets.md](references/charsets.md). The charset is the biggest single decision: Braille for fine lines and wireframes, blocks or quadrants for solid shapes, `standard` or `dense` for photos, katakana for signage, `edge` for outlines, `dots` for halftone pictures. `dots` has five dot sizes (` ·∙•⦁●`); the two smallest are specks, so dark areas can stay quiet. Pair it with the `square` look prop: cells as wide as tall, so the dots lie on an even lattice instead of rows. Braille and quadrants stretch on square cells, so keep `square` for round-glyph ramps.

The examples in [examples.md](references/examples.md) (written when the skill is installed; if it's missing, read https://asciicn.dev/.well-known/agent-skills/asciicn/references/examples.md) are references. If the user asked for exactly one of them, install it. If not, write your own: read the closest example's source for its field or draw function, then build what the user described. Never swap the request for an example that is merely nearby, and never guess at an example's props; read its docs page or source.

Done when every visual in the request has a renderer, a charset and a colour mode.

## 3. Build it

If the effect is for a landing page, or a section of one, read [landing-pages.md](references/landing-pages.md) before anything else. If it is a background scene (a place, a landscape, a city), follow [scenes.md](references/scenes.md) step by step and start from its starter scene; it covers framing for phones, the calm centre behind a headline and how to check the result. A good effect on a generic page still looks generated: the page has to be about the product, and the effect has to come from it.

1. Read the reference for your technique, and [recipes.md](references/recipes.md) for complete components to adapt.
2. Write the component in its own file with `"use client"` (both renderers are client components; `AsciiPre` renders on the server).
3. Give it typed props for what the user would tweak (charset, colour, speed, intensity, value), with defaults that already look good. Pass the engine's look props through (`charset`, `chars`, `colorMode`, `phosphor`, `ramp`, `fx`, `cell`, `speed`, `animate`) and accept a `handle` so the frame can be exported.
4. Place it with [placement.md](references/placement.md): a renderer fills a positioned parent (`absolute inset-0`), and content sits in a sibling above it.
5. Colour it with [theme.md](references/theme.md): token names (`"ink"`, `"blue"`, `--chart-1`) so it follows light and dark.

Done when the component renders the requested look with no `[ascii-shader]` or WebGL errors in the console.

## 4. Check it in a browser

Open the page and look at it. Screenshot it at desktop and phone widths (1440x900 and 390x844; a background scene also behind a sample headline and buttons), in light and dark mode, and once with reduced motion (`prefers-reduced-motion: reduce`). Zoom into a screenshot: you must see individual glyphs. Hold it to [quality.md](references/quality.md).

Done when every check in quality.md passes. A screenshot of a flat block, an empty box or blurry glyphs means the field returns the wrong range, the parent has no size, or the cell isn't snapped: fix it and look again.

## Rules for every effect

- Draw glyphs, never pixels. Every visual is characters from a charset (or DOM text). No dots on a canvas, no CSS gradients standing in for glyphs.
- A field returns a continuous tone in [0, 1]: 0 empty, 1 the densest glyph. Write smooth math (`smoothstep`, `exp`, `mix`) and let the engine pick glyphs.
- `uv` runs 0 to 1 with y up. `res.x / res.y` is the box's true aspect ratio, so multiply x by it before measuring distances. Braille samples 2x4 per cell and quadrants 2x2, so never assume one sample per glyph: use `1.0 / res.y` for one sample row.
- Paint with theme colours (`"ink"`, palette names, `--css-variables`). Phosphors, ramps and literal colours are for when the user asks for a terminal look or specific colours.
- Text sits on clear ground. Fade the tone toward 0 behind headings, or give the text its own panel. Text contrast stays at 4.5:1 or better.
- Motion is slow. Choose `stillTime` so the reduced-motion frame looks finished. Decorative canvases are `aria-hidden`; data visuals have a text equivalent.
