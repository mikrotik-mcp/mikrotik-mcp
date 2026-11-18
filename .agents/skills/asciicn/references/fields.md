# Writing a field

A field is the GLSL function you write for `AsciiShader`. It returns a tone for one sample point; the engine grades it, picks the glyph from the charset, colours it and draws it from a glyph atlas.

```glsl
float field(vec2 uv, vec2 res, float t) {
  // uv:  the sample centre, 0 to 1 on both axes, (0, 0) bottom left, y up
  // res: the sample grid, measured in sample rows (see below)
  // t:   seconds of motion, already multiplied by `speed`
  return uv.y; // 0 = empty cell, 1 = the densest glyph
}
```

The return value is clamped to [0, 1]. With a ramp charset (`standard`, `dense`, `blocks`, `cp437`…), the tone picks a glyph by ink coverage: 0.1 is a `.`, 0.9 is a `#` or `@`. With `braille` and `quadrants`, each dot or quadrant lights where its own sample is above `threshold`. With `edge`, the engine runs a Sobel filter over your tones and draws `- / | \` along edges.

## The `res` contract

The field is sampled on a grid finer than the glyph grid when the charset packs several dots into one glyph:

| Charset       | Samples per cell |
| ------------- | ---------------- |
| Ramps, `edge` | 1 x 1            |
| `quadrants`   | 2 x 2            |
| `braille`     | 2 x 4            |

`res.y` is the number of sample rows. `res.x` is `res.y * boxWidth / boxHeight`, so `res.x / res.y` is always the box's true aspect ratio, even though a glyph cell is about half as wide as it is tall. Two consequences:

- Measure distances in square units: `vec2 p = vec2(uv.x * res.x / res.y, uv.y);`. Circles stay round in every charset.
- `1.0 / res.y` is one sample row. Use it for line widths and finite differences. Don't use `1.0 / res.x` as "one cell", and don't assume one sample per glyph: a line one sample wide is a quarter of a Braille cell.

Write the field once and it works in every charset. Test it in `standard` and in `braille`: if it only looks right in one, it assumes a sample size.

## The rules of the language

Fields are GLSL ES 1.00 (the field pass runs on WebGL2, but in the 1.00 dialect).

- Every literal used as a float needs a decimal point: `2.0`, not `2`. `int` and `float` never mix without a cast: `float(i)`.
- Loops need constant bounds: `for (int i = 0; i < 5; i++)`. Break early with `if (float(i) >= count) break;` when the count is a uniform.
- No arrays in uniforms. Pass up to four numbers per uniform (`vec4`) and use several uniforms.
- Write helpers above `field` in the same string, prefixed with your component's name (`topoHeight`, `waveCrest`) so they never collide.
- Reserved: uniforms starting with `u_`, helpers starting with `ascii_`, and the names `field`, `colorField`, `main`, `hash21`, `snoise`, `fbm`, `spectrum`, `paletteColor`, `oklch`, `toSrgb`, `aces`.
- GLSL ES 1.00 keeps words it never uses, and none compile as names: `input`, `output`, `half`, `fixed`, `long`, `short`, `double`, `unsigned`, `public`, `static`, `extern`, `external`, `class`, `union`, `enum`, `typedef`, `template`, `goto`, `inline`, `noinline`, `volatile`, `cast`, `sizeof`, `this`, `packed`, `default`, `switch`, `interface`, `namespace`, `using`, `asm`, `flat`, `superp`, and types such as `hvec2`, `dvec3`, `fvec4` or `sampler3D`. Names starting with `gl_` or `webgl_`, or containing `__`, are reserved too. Built-in names (`dot`, `step`, `mix`, `length`, `distance`, `noise`) can't be variables either. Prefixed names avoid all of them.
- A broken field logs a compile error with the line, and the component shows its fallback. Read the console, fix the GLSL, reload.

## Built-in helpers

| Helper                                  | Returns                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `float hash21(vec2 p)`                  | A stable pseudo-random value in [0, 1). `hash21(floor(p))` gives one value per grid square. |
| `float snoise(vec2 p)`                  | 2D simplex noise in [-1, 1], feature size about 1 unit of `p`.                              |
| `float fbm(vec2 p)`                     | Four octaves of simplex noise, in [0, 1], mean 0.5.                                         |
| `vec3 spectrum(float h)`                | A saturated rainbow, red at 0 and 1. Wraps.                                                 |
| `vec4 paletteColor(float x)`            | The palette's ink colours (every entry after paper) as a ramp from 0 to 1.                  |
| `vec3 oklch(float L, float C, float h)` | An OKLCH colour, `h` in radians, as linear RGB. Pass it through `toSrgb` before returning.  |
| `vec3 toSrgb(vec3 linear)`              | Linear RGB to sRGB, clamped.                                                                |
| `vec3 aces(vec3 x)`                     | ACES filmic tone map, for bright, saturated colour that shouldn't clip.                     |

## Built-in uniforms

| Uniform             | Type  | Value                                                                                        |
| ------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `u_time`            | float | Same as `t`                                                                                  |
| `u_resolution`      | vec2  | Same as `res`                                                                                |
| `u_pointer`         | vec3  | Pointer `xy` in `uv` space, `z` = presence from 0 to 1, smoothed. 0 when the pointer is away |
| `u_pointerVelocity` | vec2  | Pointer velocity in `uv` per second                                                          |
| `u_click`           | vec3  | Last press position `xy`, `z` = seconds since it                                             |
| `u_audio`           | vec4  | Bass, mid, treble, level, each 0 to 1, from the `audio` prop (`useAudioBands`)               |
| `u_seed`            | float | The `seed` prop (default 0). Offset noise by it so two copies of a component can differ      |

Read `u_pointer` for parallax or steering: `vec2 look = (u_pointer.xy - 0.5) * u_pointer.z;`. For push, ripple and trail effects you don't need to write anything: set `interaction="repel"`, `"ripple"` or `"trail"` and the engine applies them to your tones.

## Your own uniforms

Pass anything the user should control as a uniform, never by rebuilding the string:

```tsx
<AsciiShader
  field={FIELD}
  uniforms={{ topoScale: scale, topoLines: lines, topoFocus: [0.7, 0.4] }}
/>
```

`topoScale` becomes `uniform float topoScale;`, `topoFocus` becomes `uniform vec2 topoFocus;`. They are declared for you; declaring them yourself is a compile error.

## Coordinates

```glsl
float aspect = res.x / res.y;
vec2 p = vec2(uv.x * aspect, uv.y);         // x 0..aspect, y 0..1, square units
vec2 c = (uv - 0.5) * vec2(aspect, 1.0);    // centred: (0, 0) in the middle, y -0.5..0.5
```

A point given from the top left, as CSS does (`[x, y]` with y down), converts with `vec2(x * aspect, 1.0 - y)`. Rotate with `mat2(cos(a), -sin(a), sin(a), cos(a)) * c`. To keep a pattern the same size in cells whatever the box size, scale by `res.y`: `p * res.y / 40.0` is one unit per 40 sample rows.

## Building blocks

Each returns a tone in [0, 1]. Combine with `max` (union), `min` (intersection), `*` (mask), `mix` (blend).

### Gradients and light

```glsl
float linear = uv.y;
float radial = 1.0 - smoothstep(0.0, 0.6, length(c));
float glow = exp(-dot(c, c) * 8.0);                 // larger number = tighter
float edgeFade = smoothstep(0.0, 0.35, uv.y);       // clear the bottom edge
```

Glyph ramps are coarse (10 levels in `standard`), so wide soft gradients band. Set `dither="bayer4"` to blend neighbouring glyph levels, or use `dense` (70 levels).

### Noise

```glsl
float clouds = fbm(p * 3.0 + vec2(t * 0.04, 0.0));
float ridges = 1.0 - abs(snoise(p * 2.5));
float warped = fbm(p * 2.0 + 0.6 * vec2(fbm(p * 1.5 + t * 0.03), fbm(p * 1.5 - t * 0.02)));
```

### Lines

Thin lines read best in `braille` (eight dots per glyph). Measure the distance to the line in sample rows, then turn it into a tone that is 1 on the line and 0 a sample or two away:

```glsl
float px = 1.0 / res.y;                                  // one sample row
float ring = 1.0 - smoothstep(0.0, 1.5 * px, abs(length(c) - 0.3));
float wave = 1.0 - smoothstep(0.0, 1.5 * px, abs(p.y - 0.5 - 0.1 * sin(p.x * 6.0 + t)));
```

Contour lines of a height function `h(p)`, about `width` samples wide:

```glsl
float topoLine(float h, float hx, float hy, float count, float width) {
  float v = h * count;
  float offset = abs(fract(v + 0.5) - 0.5);
  float perSample = max(length(vec2(hx - h, hy - h)) * count, 1e-4);
  float d = offset / perSample;
  return (1.0 - smoothstep(width * 0.5 - 0.5, width * 0.5 + 0.5, d)) * (1.0 - smoothstep(0.06, 0.1, offset));
}
// float h = topoHeight(p);
// float hx = topoHeight(p + vec2(1.0 / res.y, 0.0));
// float hy = topoHeight(p + vec2(0.0, 1.0 / res.y));
// return topoLine(h, hx, hy, 12.0, 1.5);
```

Use a smooth height for contour lines (one or two low-frequency `snoise` layers); raw high-frequency `fbm` breaks lines into dots.

### Shapes and shading

A flat 1.0 inside a shape draws a solid block of `@`. Shade it so the glyphs vary:

```glsl
float disc = 1.0 - smoothstep(r - 0.01, r + 0.01, length(c));
float lit = disc * mix(0.3, 1.0, smoothstep(-0.3, 0.3, c.y + c.x * 0.4));   // lit from the top right
float rim = disc * smoothstep(r * 0.6, r, length(c));                       // denser at the edge
```

For a sphere or a 3D look, compute a normal and a light (`max(dot(n, light), 0.0)`) and return the lambert term. Glyph ramps read shading very well; that is what ASCII art is good at.

### Columns

Per-column motion uses the glyph grid, not the sample grid. Step in whole cells: `floor(uv.x * columns)`, where `columns` is `res.x` divided by the charset's samples per cell across (1 for ramps). Pass `columns` as a uniform when the charset can change, or keep per-column effects on a ramp charset such as `katakana`.

## Motion

- Drift by adding `t * speed` to coordinates: speeds of 0.01 to 0.08 units per second read as calm.
- Pulse with `1.0 + 0.05 * sin(t * 0.4)`.
- Avoid `hash21` of anything with `t` in it: every glyph changes every frame and the effect flickers. For glyphs that change on purpose (falling glyphs, glitches), quantise time first: `hash21(vec2(column, floor(t * 8.0)))`.
- `stillTime` sets the frame shown under reduced motion. Pick one where the composition looks finished.

## Colour

`colorField` is an optional second function. It returns the colour of the glyph in a cell; `field` still decides which glyph. Setting it makes `truecolor` the default colour mode, and `ansi16` snaps its output to 16 terminal colours.

```tsx
const FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  vec2 c = (uv - 0.5) * vec2(res.x / res.y, 1.0);
  return exp(-pow(abs(length(c) - 0.3), 2.0) * 900.0);
}`;

const COLOR_FIELD = /* glsl */ `
vec3 colorField(vec2 uv, vec2 res, float t) {
  vec2 c = (uv - 0.5) * vec2(res.x / res.y, 1.0);
  return toSrgb(oklch(0.75, 0.15, atan(c.y, c.x) + t * 0.3));
}`;

<AsciiShader
  field={FIELD}
  colorField={COLOR_FIELD}
  charset="braille"
  className="absolute inset-0"
/>;
```

- Same arguments and uniforms as `field`. Return `vec3` RGB or `vec4` RGBA in [0, 1].
- `field` and `colorField` compile into one shader. Shared geometry goes in a helper; the engine keeps one copy of a helper that appears word for word in both strings.
- `oklch` gives even, controllable hues; `spectrum` is fully saturated and goes thin on white (yellow and cyan vanish). Mix in theme ink for light mode: `mix(spectrum(h), paletteColor(0.0).rgb, 0.25)`.
- Without `colorField`, `palette` mode maps tone to the palette and `duotone` to the ramp.
- To paint a whole picture (a landscape or a city), paint the colour first and read the tone back from it, in one cached function both fields call. [scenes.md](scenes.md) shows how.

| Colour                            | GLSL body                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Hue across the box                | `return toSrgb(oklch(0.72, 0.14, uv.x * 6.2832));`                                            |
| Hue around a centre               | `return spectrum(atan(c.y, c.x) / 6.2832);`                                                   |
| Theme colours along x             | `return paletteColor(uv.x).rgb;` with `palette={["--ascii-paper", "--chart-1", "--chart-2"]}` |
| Fire: dark red to white by height | `return aces(vec3(3.0, 1.2, 0.4) * tone);` with the tone from a shared helper                 |
| Fade out instead of thinning      | `return vec4(spectrum(uv.x), smoothstep(0.0, 0.3, uv.y));`                                    |

## Tuning the look

- Too busy behind text: multiply the tone (`* 0.6`) or clear it under the text with `smoothstep` on `uv`.
- Glyphs too uniform: widen the tone range. A field that sits between 0.4 and 0.6 draws one or two glyphs; stretch it with `smoothstep(0.3, 0.7, x)` or `grade={{ contrast: 1.4 }}`.
- Too dark in light mode: sparse charsets read faint on white. Try `blocks`, a bigger `cell`, or `invert`.
- Want a bolder look: `cell={16}` to `cell={20}`. Fine texture: 10 to 12.
