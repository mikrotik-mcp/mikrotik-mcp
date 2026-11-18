# Painted scenes

A painted scene is a full-bleed background that reads as a picture: a place, a time of day and one light, drawn as a halftone of coloured dots. Every cell is painted, including the darkest sky. This is how the landscape and city backgrounds on https://asciicn.dev/backgrounds are built. Use this file when the user asks for a background, a hero scene, a landscape, a cityscape or "a picture of X in ASCII" that should fill a section.

You build the scene; you don't pick one from the catalogue. The shipped backgrounds (`glacier-lagoon`, `balloon-valley`, `san-francisco`, `lighthouse` and the rest) are examples to borrow technique from. Install one only when it is exactly what the user asked for.

## The look

| Prop        | Value                   | Why                                                                                                   |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `charset`   | `"dots"`                | ` ·∙•⦁●`: five dot sizes after the empty cell. The two smallest are specks, for quiet sky and shadow  |
| `square`    | `true`                  | Cells as wide as tall, so dots lie on an even lattice. Without it, dots form rows and read as stripes |
| `cell`      | `7`                     | About 200 columns across 1440px. Shapes stay big; detail doesn't alias into noise                     |
| `colorMode` | `"truecolor"`           | Every dot gets its own colour from your `colorField`                                                  |
| `dither`    | `"bayer4"`              | Tones between two dot sizes mix them in a fixed pattern, so gradients don't band                      |
| `paper`     | the scene's darkest sky | The scene paints its own ground, so it looks the same in light and dark mode                          |

`square` changes the cell, not the field contract: `res.x / res.y` is still the box's true aspect, `dots` is one sample per cell, and `floor(uv * res)` is one cell. Braille and quadrants stretch on square cells, so keep `square` for round-glyph ramps.

## Step by step

### 1. Write the brief in one sentence

Place, time, one light, and what sits where: "A lake at night between snowy peaks, a full moon right of centre, its path on the water, a dark near shore bottom left." One focal light only. Pick a short palette for it (night blue, violet haze, moon cream; or cream paper, slate blue, gold) and write the colours as `vec3` constants. Fewer hues read as one picture.

### 2. Set up coordinates for every screen shape

```glsl
float aspect = res.x / res.y;
float squeeze = sqrt(clamp(1.6 / aspect, 1.0, 4.0));    // narrow boxes see more width
float portrait = 1.0 - smoothstep(0.7, 1.1, aspect);    // 0 on desktop, 1 on a phone
float halfW = 0.5 * aspect * squeeze;                   // x runs -halfW..halfW
vec2 p = vec2((uv.x - 0.5) * aspect * squeeze, uv.y);   // y 0..1, up
```

- Place features at a share of the half width (`0.55 * halfW`), not at a fixed x, so the composition holds from a phone to an ultrawide.
- Anything round (a sun, a moon, a halo, a light path) is measured with the squeeze undone: `length(vec2((p.x - c.x) / squeeze, p.y - c.y))`. Otherwise it turns oval on a phone.
- Use `portrait` to reframe for phones, not just squeeze. A hero headline sits in the middle of the screen and its buttons just below, about `uv.y` 0.38 to 0.65 on a 390x844 phone. Move the horizon and the subject below the buttons, or the light into the empty sky above the headline. On desktop keep the focal light out of the middle half of the width.

### 3. Paint far to near

Write one function that returns the colour of a point, painting layers back to front, each nearer layer over the last: sky, far range, middle layer, near layer, water, foreground, then mist. Give each layer a depth so lighting and haze know where it is.

Keep a value ladder:

- The sky is brightest near the light and the horizon and darkest overhead.
- The subject carries the brightest values after the light: lit snow, lit facades, lit ice. Dark silhouettes against a bright sky draw nothing but specks; the scene goes black.
- Each nearer layer is darker and more saturated in shadow; each farther layer is lighter, cooler and closer to the sky colour. Mix far layers toward the horizon sky colour (`mix(face, haze, 0.3)` far, `0.0` near), and every layer's foot into haze too.
- One foreground plane (a shore, a rail, a rooftop) near the frame edge gives scale. Keep it dark with a lit rim.
- In numbers: colours under about 0.15 value draw specks, 0.2 to 0.6 draw the middle dots that carry the picture, and above 0.8 draw the largest. Most of the frame should sit between 0.2 and 0.6.
- Water repeats the sky at 60 to 90 percent of its value. A black sky makes black water, and half the frame goes dead. A night scene still needs a lit sky: a cloud deck lit by the moon or the town, a glow along the horizon.
- Check the values before the colours: render once with `colorMode="mono"`, which sizes the dots by tone alone. If the shapes don't read in mono, colour won't save them.

### 4. Shape natural forms with light, not outlines

- Silhouettes come from noise at two scales: `fbm(x * f)` for the mass, `1.0 - abs(snoise(...))` for sharper peaks. Nothing in nature is a straight edge, an even repeat or a stripe.
- Shade a face by the silhouette's normal against the light: `normal = normalize(vec2(-slope, 1.0))`, `lit = smoothstep(0.1, 0.8, dot(normal, toLight))`. Measure the slope over a window that widens below the crest and at an x that wanders with noise, or lit and shadow faces split on vertical lines.
- Break faces with ribs down the fall line (noise stretched along y), a snow line or strata, and a rim of light along crests that face the light.
- More detail near, less far. Far layers are soft shapes in haze.
- Size things in cells. At `cell` 7 a 900px-tall box has about 128 rows, so one row is about 0.008 of `uv.y`. A shape needs 8 or more cells across to read as a shape; a point of light needs 1 to 3. Draw a town as a few big houses with lit windows, not a grid of tiny ones.
- Built things (houses, quays, boats) can have straight edges, but vary them: stagger rows, leave gaps, vary heights and roofs, and switch windows on per window with a hash.

### 5. Light, reflections and air

- The light is a disc, a tight halo (`exp(-r * r * 260.0)`) and a wide glow (`exp(-r * 3.0)`). Clouds near it pick up its colour; clouds away from it stay dark.
- Water mirrors the scene: call your above-water function at `vec2(p.x + wobble, 2.0 * horizon - p.y)`, darken and cool it, and grow the ripple wobble toward the viewer. A light path is a column of glints under the light that widens toward the viewer.
- A lamp or a window lights what is near it. Add `lampColour * exp(-r * 9.0)` to the walls, quays and hulls around it, not only a glow in the air.
- A dark object on dark ground vanishes. Put it in front of light (a reflection, a glowing sky, a lamp's streak on the water) or give it a lit edge.
- Mist is a thin band of `fbm` along the horizon or a valley floor, drifting slowly.

### 6. Turn colour into dots

`field` and `colorField` compile into one shader and run for the same sample, one after the other. Paint once in a shared function, cache the result, and return the tone from `field` and the colour from `colorField`:

- Tone comes from the colour's value, so dot size and colour always agree.
- Quiet darks: below a low value, push the colour toward a shade just above the paper and shrink the tone, so dark sky and shadow read as air (specks, some empty cells), not a field of visible dots.
- Lift dark ink colours (`col / peak * pow(peak, 0.6)`): small dots read darker than the colour they carry.
- Pin the focal light to a full dot (`tone = max(tone, smoothstep(0.82, 0.92, value))`), or it dithers between the two largest dots.
- An `intensity` uniform (0 to 1) dims the whole scene and quiets an ellipse in the middle most, for a headline.

On a light paper (a cream dawn, a white sky), take the tone from the distance to the paper colour instead, so near-paper sky is the faintest dots:

```glsl
float inkAmount = length((col - PAPER) * vec3(1.0, 1.15, 0.85));
float tone = clamp(0.05 + 0.88 * pow(min(inkAmount / 0.8, 1.0), 1.1), 0.0, 1.0);
```

### 7. Motion

Slow and sparse: drifting cloud and mist (0.004 to 0.015 units a second), ripples and glints on water, a faint star twinkle with `sin`, a slow glow pulse (`1.0 + 0.05 * sin(t * 0.3)`), at most one or two slow movers. No rain, beams, searchlights, lightning, fireworks or pointer reactions. Never `hash` anything with raw `t` in it: it flickers. Pick `stillTime` so the reduced-motion frame looks finished.

### 8. Wrap it in a component

Props: `intensity` (default 1), the look props passed through with the defaults above, `square` (default `true`), `paper` (default: the scene's own in `truecolor`, `ansi16` and `duotone`; the theme's otherwise), a `fallback` gradient in the scene's colours, and `stillTime`. Keep `field` a module-level constant; anything the user tweaks goes through `uniforms`.

## Starter scene

A complete, working scene: a moonlit lake between snowy peaks. Copy it, rename the `lake` prefix to your own everywhere (including the `lakeIntensity` key in `uniforms`, which must match the GLSL name), then replace the sky, the layers and the water with your subject. It follows every step above.

Write the GLSL by [the rules in fields.md](fields.md#the-rules-of-the-language): float literals with a decimal point, constant loop bounds, and no reserved words as names. Short local names such as `flat`, `input`, `output`, `half` or `fixed` don't compile; the console names the line.

```tsx
"use client";

import type { AsciiColor, AsciiSceneProps, ColorMode } from "@/lib/ascii";
import { AsciiShader } from "@/lib/ascii/shader";

// A moonlit lake between hills: the starter scene from the painted scenes
// guide. The scene is painted in colour first; the tone (dot size) is read
// back from that colour, so size and colour always agree.
const SCENE = `
// Set once per sample by lakeColor and read by every layer.
float lakeT;
float lakeHorizon;
float lakeHalfW;
float lakeScale;
float lakeSqueeze;
vec2 lakeMoon;

// A stable random value per cell. hash21 repeats every 50 whole cells.
float lakeHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// Deep blue overhead, dusty violet at the horizon, a cool glow around the
// moon, thin cloud lit only near it, and sparse stars high up.
vec3 lakeSky(vec2 p, vec2 cellId) {
  float h = clamp((p.y - lakeHorizon) / (1.0 - lakeHorizon), 0.0, 1.0);
  vec3 col = mix(vec3(0.44, 0.38, 0.58), vec3(0.13, 0.14, 0.3), smoothstep(0.0, 0.35, h));
  col = mix(col, vec3(0.04, 0.05, 0.12), smoothstep(0.3, 1.0, h));
  // Undo the phone squeeze so the moon and its halo stay round.
  float r = length(vec2((p.x - lakeMoon.x) / lakeSqueeze, p.y - lakeMoon.y));
  col += vec3(0.2, 0.21, 0.3) * exp(-r * 3.0);
  col += vec3(0.5, 0.5, 0.56) * exp(-r * r * 260.0);
  float streak = fbm(vec2(p.x * 1.1 - lakeT * 0.006, p.y * 9.0));
  float cloud = smoothstep(0.55, 0.75, streak) * smoothstep(0.04, 0.16, h) * (1.0 - smoothstep(0.45, 0.65, h));
  vec3 cloudCol = mix(vec3(0.1, 0.1, 0.2), vec3(0.62, 0.6, 0.7), exp(-r * 5.0));
  col = mix(col, cloudCol, cloud * 0.7);
  float star = step(0.994, lakeHash(cellId)) * smoothstep(0.35, 0.7, h);
  col += vec3(0.6, 0.62, 0.7) * star * (0.6 + 0.4 * sin(lakeT * 0.7 + lakeHash(cellId + 3.0) * 40.0));
  float disc = 1.0 - smoothstep(0.034, 0.04, r);
  return mix(col, vec3(1.0, 0.96, 0.86), disc);
}

// The top of layer i (0 the far snow range, 1 wooded hills, 2 the near
// shore) above the horizon. Two noise scales, so no edge is straight and
// no two peaks match.
float lakeRidge(float x, float i) {
  float freq = 1.1 + i * 0.6;
  float n = fbm(vec2(x * freq + i * 7.3, i * 3.1));
  float ridged = 1.0 - abs(snoise(vec2(x * freq * 0.8, i + 9.0)));
  float height = mix(0.26, 0.07, i * 0.5) * mix(n, ridged, mix(0.6, 0.2, i * 0.5)) * lakeScale;
  // The near layer dips under the water in the middle and right, so it
  // frames the lake instead of crossing it.
  float near = step(1.5, i) * smoothstep(-0.1, 0.5, x / lakeHalfW);
  return lakeHorizon + mix(0.01, -0.03, i * 0.5) + height - near * 0.12;
}

vec3 lakeAbove(vec2 p, vec2 cellId) {
  vec3 col = lakeSky(p, cellId);
  vec3 haze = lakeSky(vec2(p.x, lakeHorizon + 0.03), cellId) * 0.8;
  // Far to near: each nearer layer paints over the ones behind it.
  for (int k = 0; k < 3; k++) {
    float i = float(k);
    float top = lakeRidge(p.x, i);
    if (p.y < top) {
      // Shade by the silhouette's normal against the moon. Below the crest
      // the slope is read over a wider window at a wandering x, so faces
      // spread into broad planes split by crooked ridges, not vertical
      // lines; ribs down the fall line break them up.
      float below = top - p.y;
      float xs = p.x + below * 0.5 * snoise(vec2(below * 5.0, p.x * 3.0 + i));
      float e = 0.01 + below * 0.8;
      float slope = (lakeRidge(xs + e, i) - lakeRidge(xs - e, i)) / (2.0 * e);
      vec2 normal = normalize(vec2(-slope, 1.0));
      vec2 toMoon = normalize(lakeMoon - vec2(p.x, top));
      float rib = snoise(vec2(p.x * 22.0, below * 3.0 + i));
      float lit = smoothstep(0.1, 0.8, dot(normal, toMoon) + 0.25 * rib);
      // Each nearer layer is darker: moonlit snow far, woods, then rock.
      vec3 shade = mix(vec3(0.12, 0.13, 0.27), vec3(0.03, 0.035, 0.08), i * 0.5);
      vec3 light = mix(vec3(0.78, 0.8, 0.92), vec3(0.2, 0.23, 0.3), i * 0.5);
      // Snow lies near the crests and gives way to dark rock below.
      float snow = 1.0 - smoothstep(0.03, 0.1, below + 0.03 * rib);
      light = mix(light * 0.35, light, mix(snow, 1.0, i * 0.5));
      vec3 face = mix(shade, light, lit);
      // A rim of moonlight along every crest on the lit side.
      face = mix(face, vec3(0.7, 0.72, 0.82), smoothstep(0.01, 0.0, below) * lit * 0.5);
      // Atmospheric perspective: far layers and every layer's foot sink
      // into the haze.
      float far = mix(0.3, 0.0, i * 0.5);
      far = mix(far, 1.0, 0.4 * (1.0 - smoothstep(0.0, 0.05, p.y - lakeHorizon)));
      col = mix(face, haze, far);
    }
  }
  return col;
}

vec3 lakeWater(vec2 p, vec2 cellId) {
  float depth = (lakeHorizon - p.y) / lakeHorizon;
  // Mirror about the horizon, wobbled by ripples that grow toward the viewer.
  float wob = (0.002 + 0.01 * depth) * sin(p.y * 220.0 / (0.25 + depth) + lakeT * 0.5 + 2.0 * snoise(vec2(p.x * 2.0, p.y * 10.0)));
  vec3 col = lakeAbove(vec2(p.x + wob, 2.0 * lakeHorizon - p.y), cellId);
  col = col * vec3(0.6, 0.66, 0.8) * mix(0.95, 0.55, depth) + vec3(0.02, 0.03, 0.07);
  // The moon's path: glints in a column that widens toward the viewer.
  float dx = abs(p.x - lakeMoon.x) / lakeSqueeze;
  float width = 0.012 + 0.07 * depth;
  float column = exp(-dx * dx / (width * width));
  float glint = smoothstep(0.35, 0.85, snoise(vec2(p.x * 26.0, p.y * 130.0 + lakeT * 0.25)));
  col += vec3(0.9, 0.86, 0.72) * column * (0.12 + glint) * mix(1.0, 0.55, depth);
  return col;
}

vec3 lakeColor(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  // Narrow boxes squeeze x, so a phone still sees the hills and the moon.
  lakeSqueeze = sqrt(clamp(1.6 / aspect, 1.0, 4.0));
  float portrait = 1.0 - smoothstep(0.7, 1.1, aspect);
  lakeT = t;
  lakeHalfW = 0.5 * aspect * lakeSqueeze;
  // On a phone the headline fills the middle: the horizon and the hills
  // drop below the buttons and the moon rises into the sky above the text.
  lakeHorizon = mix(0.4, 0.2, portrait);
  lakeScale = mix(1.0, 0.7, portrait);
  lakeMoon = vec2(0.55 * lakeHalfW, mix(lakeHorizon + 0.3, 0.8, portrait));
  vec2 p = vec2((uv.x - 0.5) * aspect * lakeSqueeze, uv.y);
  vec2 cellId = floor(uv * res);

  vec3 col = p.y >= lakeHorizon ? lakeAbove(p, cellId) : lakeWater(p, cellId);

  // A dark near shore in the bottom left: the foreground plane.
  float shore = 0.12 + 0.05 * fbm(vec2(p.x * 3.0, 5.0)) - 0.3 * smoothstep(-0.9, 0.2, p.x / lakeHalfW);
  if (p.y < shore) {
    float rocks = 0.5 + 0.5 * snoise(vec2(p.x * 14.0, p.y * 9.0));
    col = mix(vec3(0.03, 0.035, 0.07), vec3(0.12, 0.12, 0.2), rocks * 0.5);
    col = mix(col, vec3(0.4, 0.4, 0.5), smoothstep(0.012, 0.0, shore - p.y) * 0.6);
  }

  // Low mist drifting along the far shore.
  float band = exp(-pow((p.y - lakeHorizon - 0.01) / 0.025, 2.0));
  float mist = smoothstep(0.4, 0.7, fbm(vec2(p.x * 1.5 - t * 0.012, p.y * 12.0))) * band;
  return mix(col, vec3(0.42, 0.4, 0.54), mist * 0.6);
}

// field and colorField run in the same shader pass, so the second call for
// a sample reads the cached result instead of painting the scene again.
vec2 lakeCacheUv = vec2(-1.0);
float lakeCacheT = -1.0;
vec4 lakeCacheValue = vec4(0.0);

vec4 lakeScene(vec2 uv, vec2 res, float t) {
  if (uv == lakeCacheUv && t == lakeCacheT) {
    return lakeCacheValue;
  }
  vec3 col = clamp(lakeColor(uv, res, t), 0.0, 1.0);
  float peak = max(col.r, max(col.g, col.b));
  // Value counts saturated colour as mid-tone, so blue shadow still draws.
  float value = max(dot(col, vec3(0.3, 0.55, 0.15)), 0.7 * peak);
  float tone = 0.1 + 0.9 * pow(value, 1.2);
  // The focal light draws full dots, not a dithered mix of the two largest.
  tone = max(tone, smoothstep(0.82, 0.92, value));
  // Small dots read darker than the light they stand for: lift dark ink.
  vec3 ink = col / max(peak, 1e-3) * pow(peak, 0.6);
  // Quiet darks: the faintest specks, in a colour just above the paper.
  float quiet = 1.0 - smoothstep(0.08, 0.28, value);
  ink = mix(ink, vec3(0.11, 0.12, 0.2), quiet * 0.55);
  tone *= 1.0 - 0.35 * quiet;
  // Below full intensity the middle band, where a headline sits, quiets most.
  float k = lakeIntensity;
  vec2 c = vec2((uv.x - 0.5) * res.x / res.y / 0.55, (uv.y - 0.52) / 0.15);
  float middle = exp(-dot(c, c)) * (1.0 - k);
  tone *= mix(0.72, 1.0, k) * (1.0 - 0.45 * middle);
  ink *= mix(0.5, 1.0, k) * (1.0 - 0.6 * middle);
  lakeCacheUv = uv;
  lakeCacheT = t;
  lakeCacheValue = vec4(ink, tone);
  return lakeCacheValue;
}
`;

const FIELD = `${SCENE}
float field(vec2 uv, vec2 res, float t) {
  return lakeScene(uv, res, t).a;
}
`;

const COLOR_FIELD = `${SCENE}
vec3 colorField(vec2 uv, vec2 res, float t) {
  return lakeScene(uv, res, t).rgb;
}
`;

// The scene paints its own night, so modes that use its colours keep this
// paper in light and dark themes alike.
const NIGHT = "#070a14";
const PAINTED: ReadonlySet<ColorMode> = new Set<ColorMode>([
  "truecolor",
  "ansi16",
  "duotone",
]);

export interface MoonLakeProps extends Omit<AsciiSceneProps, "interactive"> {
  /** How strongly it draws, from 0 (faint, for text on top) to 1. Default 1. */
  intensity?: number;
  /** Square cells, for an even lattice of dots. Default `true`. */
  square?: boolean;
  /** Paper behind the dots. Default: the scene's night in painted modes. */
  paper?: AsciiColor;
}

export const MoonLake = ({
  charset = "dots",
  colorMode = "truecolor",
  cell = 7,
  square = true,
  dither = "bayer4",
  stillTime = 6,
  intensity = 1,
  paper,
  ...props
}: MoonLakeProps) => (
  <AsciiShader
    field={FIELD}
    colorField={COLOR_FIELD}
    uniforms={{ lakeIntensity: Math.min(1, Math.max(0, intensity)) }}
    charset={charset}
    colorMode={colorMode}
    paper={paper ?? (PAINTED.has(colorMode) ? NIGHT : undefined)}
    cell={cell}
    square={square}
    dither={dither}
    stillTime={stillTime}
    fallback={<div className="absolute inset-0 bg-[#070a14]" />}
    {...props}
  />
);
```

To look at it while you work, render it full-bleed behind a sample headline, the way a hero would use it:

```tsx
<section className="relative isolate flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center text-white">
  <MoonLake intensity={0.75} className="absolute inset-0 -z-10" />
  <h1 className="max-w-xl text-4xl font-medium sm:text-6xl">Your headline</h1>
  <p className="text-white/75">A line of supporting copy.</p>
  <div className="flex gap-3">
    <a className="rounded-full bg-white px-5 py-2 text-black">Primary</a>
    <a className="rounded-full border border-white/30 px-5 py-2">Secondary</a>
  </div>
</section>
```

## Do and don't

| Do                                                                        | Don't                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Paint every cell; let the darkest areas be specks in a near-paper colour  | Leave flat empty paper, or cover sky and shadow in bright, even dots       |
| Save the largest, brightest dots for the light, its reflection, lit edges | Draw the whole subject at full size; texture then flattens the depth       |
| Make far layers smaller, lower in contrast and closer to the sky colour   | Give every depth the same dot size and contrast                            |
| Shade faces lit and shadowed, with ribs, ledges and ragged edges          | Flat uniform faces, stair-step contours, evenly spaced stripes             |
| Keep the middle of the frame calm, and expose `intensity`                 | Put the light, a bright edge or busy detail behind the headline            |
| Reframe for portrait so the subject sits beside the headline              | Let a phone crop hide the subject behind the text                          |
| Measure round things with the squeeze undone                              | Draw a sun or moon in squeezed units (it turns oval on a phone)            |
| Use your own `hash` for per-cell randomness over large areas              | Rely on `hash21` of whole cells over wide areas: it repeats every 50 cells |
| Size shapes in cells: 8 or more across for anything that must read        | Tiny features that blur into a grid or alias into noise                    |
| Give the sky and water mid-tones, even at night                           | A black sky over black water, so half the frame is empty                   |
| Keep landmarks true to their real silhouette and proportions              | Draw a landmark as an icon with one flat, bright face                      |
| Calm motion that a still frame survives                                   | Rain, beams, lightning, flicker, pointer effects                           |

## Check it

1. Screenshot at 1440x900 and at 390x844, bare and behind a sample headline and two buttons. Look at each honestly: can you name the place in a second? Is there one clear light? Do far layers sit back? Is the middle calm behind the text?
2. Zoom into a crop at 2x or more. You see round dots of several sizes on an even lattice, not stripes, not blur, not a flat block.
3. On the phone, the subject is recognisable beside the text, the light is round, and nothing bright sits behind the buttons.
4. Emulate `prefers-reduced-motion: reduce`: the root reports `data-state="static"` and the `stillTime` frame looks finished.
5. Toggle the site's light and dark themes: a painted scene looks the same in both, because it paints its own paper.
6. The console shows no `[ascii-shader]` compile errors or WebGL warnings. A compile error names the line; a black box with the fallback means the field didn't compile.
7. Then hold it to [quality.md](quality.md).

If it looks weak, the cause is usually one of: too dark (the subject has no bright values; check in `mono`), half empty (a black sky and black water), too small (features under 8 cells), too busy (dark areas aren't quiet), flat (no lit and shadow faces, no haze by depth), or diagrammatic (straight edges, even repeats).

## Going further: a real 3D scene

The shipped backgrounds paint 2D layers, which is enough for most scenes. For a scene that must hold up to close inspection (a city with depth, a canyon you look into), raymarch it in the same `field`: model terrain and buildings as height fields and signed distance functions, cast rays from a camera with a field of view placed where a photographer would stand, light faces from the normal, march toward the light for cast shadows, reflect water by tracing the mirrored ray (`reflect(rd, normal)` with a slight ripple in the normal), and add fog that thickens exponentially with distance toward the sky colour. Keep it to 64 to 128 steps with bounding boxes, and animate only what moves on top of static geometry. The dot look, the tone mapping, the calm centre and the checks above all stay the same.
