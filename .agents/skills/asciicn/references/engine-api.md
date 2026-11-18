# Engine API

The engine installs as plain source. When this file and the code disagree, the code wins: read `lib/ascii/index.ts` and the file named in each section.

- `@/lib/ascii` (item `ascii-core`): CPU side. Charsets, palettes, frames, cell metrics, `AsciiGrid`, `mapTones`, theme and motion hooks. No WebGL.
- `@/lib/ascii/shader` (item `ascii-shader`): `AsciiShader`, the WebGL2 glyph renderer.
- `@/lib/ascii/export` (item `ascii-export`): files. See [export.md](export.md).

## Look props

Both renderers, and every component and background, take the same look props (`AsciiLook` in `lib/ascii/look.ts`):

| Prop            | Type                                                          | What it does                                                                                                                                    |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `charset`       | `CharsetName`                                                 | Which glyphs draw the tones. See [charsets.md](charsets.md)                                                                                     |
| `chars`         | `string`                                                      | A custom ramp from empty to dense, such as `" .oO@"`. Wins over `charset`                                                                       |
| `colorMode`     | `"mono" \| "truecolor" \| "ansi16" \| "duotone" \| "palette"` | How glyphs are coloured                                                                                                                         |
| `phosphor`      | `"p1" \| "p3" \| "ibm" \| "blueprint"`                        | `mono`: a CRT screen colour instead of `--ascii-ink`                                                                                            |
| `ramp`          | `RampName \| string[]`                                        | `duotone`: a named ramp or `#rrggbb` stops, dark to bright                                                                                      |
| `ansi`          | `"vga" \| "xterm"`                                            | `ansi16`: which 16-colour table. Default `"vga"`                                                                                                |
| `grade`         | `{ brightness, contrast, gamma, saturation }`                 | Tone grading before the glyph is chosen                                                                                                         |
| `invert`        | `boolean`                                                     | Dense glyphs for dark tones. Use for dark-on-light art                                                                                          |
| `threshold`     | `number`                                                      | Braille and quadrants: the tone that lights a dot. Default 0.5                                                                                  |
| `edgeThreshold` | `number`                                                      | `edge`: Sobel strength that draws `- / \| \`. Default 0.22                                                                                      |
| `dither`        | `"none" \| "bayer2" \| "bayer4" \| "bayer8" \| "blue-noise"`  | Ordered dithering between glyph levels, for smooth gradients with few glyphs                                                                    |
| `background`    | `"paper" \| "transparent"`                                    | `"transparent"` draws glyphs only, so the page shows between them                                                                               |
| `square`        | `boolean`                                                     | Cells as wide as tall (`cell` sets both sides), so `dots` lies on an even lattice. Braille and quadrants stretch on it. Default `false`         |
| `fx`            | `PostFx`                                                      | CRT effects, each 0 to 1: `scanlines`, `bloom`, `curvature`, `glitch`, `flicker`, `vignette`. `CRT_FX` is a full preset, `NO_FX` turns them off |

Shared runtime props: `cell` (glyph cell height in CSS px, default `--ascii-cell`), `speed` (time multiplier, default 1), `animate` (`false` holds a still frame), `fps` (cap), `stillTime` (seconds drawn when motion is off or reduced), `fallback` (shown until the first frame) and `handle` (a ref filled with an `AsciiHandle` for export).

## AsciiShader

`lib/ascii/shader.tsx`. A client component that fills its positioned parent.

```tsx
"use client";

import { AsciiShader } from "@/lib/ascii/shader";

const FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0);
  return smoothstep(0.45, 0.0, length(p)) * (0.75 + 0.25 * sin(t));
}`;

export const Glow = () => (
  <AsciiShader field={FIELD} charset="braille" className="absolute inset-0" />
);
```

| Prop           | What it does                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `field`        | GLSL: `float field(vec2 uv, vec2 res, float t)` returning a tone in [0, 1]. See [fields.md](fields.md)          |
| `colorField`   | GLSL: `vec3 colorField(vec2 uv, vec2 res, float t)` (or `vec4`) returning RGB 0..1 for `truecolor` and `ansi16` |
| `uniforms`     | `{ name: number \| [x, y] \| [x, y, z] \| [x, y, z, w] }`, declared for you. Names must not start with `u_`     |
| `palette`      | Paper then inks, as token names or CSS colours. Used by `colorMode="palette"`                                   |
| `ink`, `paper` | Mono overrides                                                                                                  |
| `interaction`  | `"none" \| "repel" \| "ripple" \| "trail"`: what the pointer does to the field                                  |
| `audio`        | Audio bands from `useAudioBands` (`lib/ascii/audio.ts`), read as `u_audio`, or `null`                           |
| `seed`         | A number read as `u_seed`, for seeded variations. Default 0                                                     |
| look props     | All of the table above                                                                                          |

Default `colorMode` is `truecolor` when `colorField` is set, otherwise `palette` (paper to ink). Keep the `field` string a module-level constant and pass changing values through `uniforms`; a new string recompiles the shader.

`data-state` on the root reports `running`, `paused` (offscreen or hidden tab), `static` (reduced motion or `animate={false}`) or `fallback` (no WebGL2, or a compile error, which is logged with the line).

## AsciiGrid

`lib/ascii/grid.tsx`. A Canvas2D grid of glyphs drawn by a function you write, at device resolution, theme-aware, paused offscreen, one still frame under reduced motion.

```tsx
"use client";

import { AsciiGrid } from "@/lib/ascii";
import type { AsciiGridDrawContext } from "@/lib/ascii";

const draw = ({ frame, columns, rows, time }: AsciiGridDrawContext) => {
  const message = "SYSTEM READY";
  const x = Math.floor((columns - message.length) / 2);
  frame.write(x, Math.floor(rows / 2), message);
  frame.put(
    x + message.length + 1,
    Math.floor(rows / 2),
    time % 1 < 0.5 ? "█" : " "
  );
};

export const Ready = () => (
  <AsciiGrid draw={draw} className="absolute inset-0" />
);
```

`draw(ctx)` runs every frame while animating, once for a still frame, and again on resize. `ctx` holds:

- `frame`: a `MutableFrame`, cleared to spaces before each draw. `put(x, y, glyph, rgba?)`, `write(x, y, text, rgba?)`, `fillRect(x, y, w, h, glyph, rgba?)`, `get(x, y)`. Out-of-bounds writes are ignored, so you never need to clip. Row 0 is the top.
- `columns`, `rows`: the grid size for the current box and cell.
- `time` (seconds, scaled by `speed`), `delta` (seconds since the last draw, 0 when still).
- `pointer`: `{ x, y, inside, down }` in cell units, when `interactive` is set.
- `metrics`: the measured `CellMetrics`.

Props: `draw`, `cell`, `ink`, `paper` (default `"transparent"`), `colored` (per-glyph colour; set it when you pass `rgba` or use a colour mode), `speed`, `animate`, `fps` (default 30), `stillTime`, `interactive`, `fallback`, `handle`.

### Tones to glyphs on the CPU

For anything with a tone per point (3D shading, a heightmap, a simulation), fill a `ToneField` and let `mapTones` choose glyphs. It handles every charset, sub-cell sampling and colour mode the same way the GPU does.

```ts
import {
  createToneField,
  fillToneField,
  mapTones,
  resolveCharset,
} from "@/lib/ascii";

// Inside draw:
const charset = resolveCharset("braille");
const field = createToneField(columns, rows, charset); // columns*2 by rows*4 samples for Braille
fillToneField(field, (u, v) =>
  /* u, v in [0, 1], v = 0 at the TOP */ Math.max(
    0,
    1 - Math.hypot(u - 0.5, v - 0.5) * 2
  )
);
mapTones(field, columns, rows, { charset, colorMode: "mono" }, frame);
```

`fillToneField`'s callback may return a tone or `[tone, r, g, b]` (0..255) when the field was created with `{ color: true }`. `mapTones(field, columns, rows, options, into?)` writes into `into` (pass `ctx.frame`) and takes `charset`, `chars`, `grade`, `invert`, `threshold`, `edgeThreshold`, `dither`, `colorMode`, `ramp`, `ansi` and `palette` (paper to ink, as `[r, g, b]` bytes).

Reuse the field across frames: create it once per size (keep it in a ref and recreate when `columns` or `rows` change), and refill it each frame.

## Charset helpers

`lib/ascii/charsets.ts`:

- `CHARSETS`, `CHARSET_NAMES`, `resolveCharset(charset, chars?)` returns `{ id, label, kind, glyphs, grid }`. `kind` is `"ramp"`, `"braille"`, `"quadrants"` or `"edge"`; `grid` is the samples per cell (`[2, 4]` for Braille).
- `rampChar(charset, tone)`: the glyph for a tone on a ramp charset.
- `brailleChar(mask)` with `BRAILLE_DOT_BITS[row][col]` (row 0..3, col 0..1): build a Braille glyph dot by dot, for traces, waveforms and plots.
- `quadrantChar(mask)`, `QUADRANT_GLYPHS`; `edgeChar(gx, gy)` (y down) picks `-`, `/`, `|` or `\`.
- `EIGHTHS_UP` (` ▁▂▃▄▅▆▇█`) and `EIGHTHS_RIGHT` (` ▏▎▍▌▋▊▉█`): bars with eighth-cell precision. `eighthsBar(value, width)` returns a horizontal bar string for `value` in [0, 1].
- `SHADES` (` ░▒▓█`), `BOX` (`ascii`, `light`, `heavy`, `double`, `rounded`, each with `tl tr bl br h v x`), `SPINNERS`.

## Colour helpers

`lib/ascii/palettes.ts` and `lib/ascii/color.ts`:

- `PHOSPHORS`, `RAMPS`, `ANSI16.vga`, `ANSI16.xterm`, `sampleRamp(stops, t)`, `hexToRgb`, `rgbToHex`, `nearestIndex(rgb, palette)` (OKLab distance), `luma`, `gradeTone`, `gradeRgb`.
- `cssColor(name)`: `"green"` to `var(--ascii-color-green, …)`, `"--chart-1"` to `var(--chart-1)`.
- `useAsciiColors(ref, names?)`: resolves token names (default paper and ink) to concrete RGBA on the client and re-renders when the theme changes. Returns `null` until mounted. `resolveColor(css)`, `subscribeToTheme(callback)` for non-React code.
- `seriesColor(color, i)`, `SERIES_COLORS`: `color` if set, otherwise the i-th named colour in a fixed order, for telling several lines apart.

## Cell metrics

`lib/ascii/measure.ts`: `measureCell({ cell, font, dpr })` returns `{ width, height, deviceWidth, deviceHeight, dpr, fontSize, font }`. The cell height is `cell`; the width is the font's advance; both snap to whole device pixels so glyphs stay sharp. `gridSize(metrics, width, height)` gives `{ columns, rows }`. `readCell(el)` and `readFont(el)` read `--ascii-cell` and `--ascii-font`. `DEFAULT_CELL` is 12.

## Motion hooks

`lib/ascii/motion.ts`: `useFrameLoop((time, delta) => …, { target, enabled, fps, stillTime })` drives your own loop with the same rules as the renderers (pause offscreen and in hidden tabs, one frame under reduced motion). `usePrefersReducedMotion()`, `useInView(ref)`, `useDocumentVisible()`.

## Static art

`AsciiPre` (`lib/ascii/pre.tsx`) renders an `AsciiFrame` as a `<pre>`, with colour runs as spans. It works in server components, emails and RSS. For a fixed banner, a plain `<pre aria-label="…">` with the text is fine too. `frameToText(frame)` and `frameLines(frame)` turn a frame into strings.

For a CPU renderer that needs the CRT look, `CrtOverlay` (`lib/ascii/crt.tsx`) approximates `fx` in CSS over a canvas or DOM text.

## Sampling images and video

`sampleToField(source, { columns, rows, charset, fit, mirror, crop, aspect, into })` (`lib/ascii/sample.ts`) reads an image, video, canvas or webcam frame into a `ToneField` with colour, area-averaged per sample. `autoLevels(field)` stretches its tones to the full range. `useMediaElement(urlOrBlobOrStream)` loads an `<img>` or `<video>` and returns `{ element, kind, error }`. Then `mapTones` as above. [recipes.md](recipes.md#an-image-as-ascii) has the full component.
