# Recipes

Complete components to adapt. Each one is a starting point: change the field, the charset and the props to fit what the user asked for. Imports use `@/lib/ascii`; use the project's alias.

## A shader background

A slow, theme-coloured field with the engine's look props passed through, so the user (or a Studio) can switch charset and colours, and a `handle` for export.

```tsx
"use client";

import type { AsciiSceneProps } from "@/lib/ascii";
import { AsciiShader } from "@/lib/ascii/shader";

const FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  vec2 p = vec2(uv.x * res.x / res.y, uv.y);
  float drift = fbm(p * 1.6 + vec2(t * 0.03, t * 0.01));
  float bands = 0.5 + 0.5 * sin((p.y + drift * 0.8) * 9.0 - t * 0.2);
  float tone = smoothstep(0.15, 0.95, bands * drift * 1.6) * smoothstep(0.0, 0.25, uv.y);
  return tone * tideIntensity;
}`;

export interface TideBackgroundProps extends AsciiSceneProps {
  /** How strong the pattern is, 0 to 1. Default 0.9. */
  intensity?: number;
}

export const TideBackground = ({
  intensity = 0.9,
  charset = "braille",
  colorMode = "mono",
  stillTime = 6,
  ...props
}: TideBackgroundProps) => (
  <AsciiShader
    field={FIELD}
    uniforms={{ tideIntensity: intensity }}
    charset={charset}
    colorMode={colorMode}
    stillTime={stillTime}
    {...props}
  />
);
```

Every uniform you pass must be read in the field, or the compiler drops it and the engine warns.

## A hero that clears its headline

Measure the text block and clear a rounded box around it, so the headline sits on clean ground at every width.

```tsx
"use client";

import { useEffect, useRef, useState } from "react";

import { AsciiShader } from "@/lib/ascii/shader";

const FIELD = /* glsl */ `
float heroBox(vec2 p, vec4 box, float radius) {
  vec2 centre = box.xy + box.zw * 0.5;
  vec2 d = abs(p - centre) - box.zw * 0.5 + radius;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
}

float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float rings = 0.5 + 0.5 * sin(length(p - vec2(aspect * 0.8, 0.2)) * 28.0 - t * 0.6);
  float glyphs = smoothstep(0.35, 1.0, rings) * (0.4 + 0.6 * fbm(p * 2.0 + t * 0.02));
  // heroText is the text block in the same square units, y up.
  vec4 box = vec4(heroText.x * aspect, heroText.y, heroText.z * aspect, heroText.w);
  float clear = smoothstep(0.0, 0.08, heroBox(p, box, 0.04));
  return glyphs * clear;
}`;

export const Hero = () => {
  const section = useRef<HTMLElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<[number, number, number, number]>([
    0, 0, 0, 0,
  ]);

  useEffect(() => {
    const measure = () => {
      const outer = section.current?.getBoundingClientRect();
      const inner = text.current?.getBoundingClientRect();
      if (!(outer && inner && outer.width && outer.height)) {
        return;
      }
      // uv space: x and width over the section width, y up from the bottom.
      setBox([
        (inner.left - outer.left) / outer.width,
        (outer.bottom - inner.bottom) / outer.height,
        inner.width / outer.width,
        inner.height / outer.height,
      ]);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (section.current) {
      observer.observe(section.current);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={section} className="relative isolate overflow-hidden">
      <AsciiShader
        field={FIELD}
        uniforms={{ heroText: box }}
        charset="standard"
        className="absolute inset-0 -z-10"
      />
      <div
        ref={text}
        className="relative mx-auto max-w-2xl px-6 py-32 text-center"
      >
        <h1 className="text-5xl font-semibold tracking-tight">
          Ship logs you can read
        </h1>
        <p className="text-muted-foreground mt-4 text-lg">
          One sentence about the product.
        </p>
      </div>
    </section>
  );
};
```

## A spinning object on the CPU

A torus shaded with a light, drawn into an `AsciiGrid` through `mapTones`. The same pattern draws any 3D mesh, heightmap or simulation: compute a tone per sample, then map.

```tsx
"use client";

import { useRef } from "react";

import {
  AsciiGrid,
  createToneField,
  mapTones,
  resolveCharset,
} from "@/lib/ascii";
import type { AsciiGridDrawContext, CharsetName, ToneField } from "@/lib/ascii";

export interface SpinningTorusProps {
  /** Glyph set. Default `"standard"`. */
  charset?: CharsetName;
  /** Cell height in CSS px. Default `--ascii-cell`. */
  cell?: number;
  className?: string;
}

export const SpinningTorus = ({
  charset = "standard",
  cell,
  className,
}: SpinningTorusProps) => {
  const fieldRef = useRef<ToneField | null>(null);
  const depthRef = useRef(new Float32Array(0));

  const draw = ({
    frame,
    columns,
    rows,
    time,
    metrics,
  }: AsciiGridDrawContext) => {
    const set = resolveCharset(charset);
    const [gx, gy] = set.grid;
    let field = fieldRef.current;
    if (!field || field.width !== columns * gx || field.height !== rows * gy) {
      field = createToneField(columns, rows, set);
      fieldRef.current = field;
      depthRef.current = new Float32Array(field.tones.length);
    }
    field.tones.fill(0);
    const depth = depthRef.current;
    depth.fill(0);
    const a = time * 0.7;
    const b = time * 0.4;
    // Sample aspect: cells are metrics.width wide and metrics.height tall.
    const aspect =
      (field.width * metrics.width) /
      gx /
      ((field.height * metrics.height) / gy);
    for (let theta = 0; theta < 6.283; theta += 0.04) {
      for (let phi = 0; phi < 6.283; phi += 0.015) {
        const circle = 2 + Math.cos(theta);
        const x0 = circle * Math.cos(phi);
        const y0 = Math.sin(theta);
        const z0 = circle * Math.sin(phi);
        const y = y0 * Math.cos(a) - z0 * Math.sin(a);
        const z1 = y0 * Math.sin(a) + z0 * Math.cos(a);
        const x = x0 * Math.cos(b) - z1 * Math.sin(b);
        const z = 6 + x0 * Math.sin(b) + z1 * Math.cos(b);
        const inv = 1 / z;
        const u = 0.5 + (x * inv * 1.4) / aspect;
        const v = 0.5 - y * inv * 1.4;
        const sx = Math.floor(u * field.width);
        const sy = Math.floor(v * field.height);
        if (sx < 0 || sy < 0 || sx >= field.width || sy >= field.height) {
          continue;
        }
        const i = sy * field.width + sx;
        if (inv > (depth[i] ?? 0)) {
          depth[i] = inv;
          const nx = Math.cos(theta) * Math.cos(phi);
          const ny = Math.sin(theta);
          const light = Math.max(0, nx * 0.5 + ny * 0.7 + 0.3);
          field.tones[i] = 0.15 + 0.85 * light;
        }
      }
    }
    mapTones(field, columns, rows, { charset: set }, frame);
  };

  return (
    <AsciiGrid draw={draw} cell={cell} stillTime={1.2} className={className} />
  );
};
```

## A Braille trace

A line through a list of values: a waveform, a CPU trace in a terminal pane, the height profile of a route. Two dots across and four down per glyph make the line four times sharper than one glyph per point. Draw it with `brailleChar`, and keep the numbers in HTML.

```tsx
"use client";

import { AsciiGrid, BRAILLE_DOT_BITS, brailleChar } from "@/lib/ascii";
import type { AsciiGridDrawContext } from "@/lib/ascii";

export interface BrailleTraceProps {
  /** Values in any range; the trace scales to min and max. */
  data: readonly number[];
  /** Text equivalent for screen readers, such as "Requests per minute, last hour: 120 to 340". */
  label: string;
  className?: string;
}

export const BrailleTrace = ({ data, label, className }: BrailleTraceProps) => {
  const draw = ({ frame, columns, rows }: AsciiGridDrawContext) => {
    const width = columns * 2;
    const height = rows * 4;
    const masks = new Uint8Array(columns * rows);
    const min = Math.min(...data);
    const span = Math.max(...data) - min || 1;
    const yAt = (x: number) => {
      const t = (x / (width - 1)) * (data.length - 1);
      const i = Math.floor(t);
      const value =
        (data[i] ?? 0) +
        ((data[i + 1] ?? data[i] ?? 0) - (data[i] ?? 0)) * (t - i);
      return Math.round((1 - (value - min) / span) * (height - 1));
    };
    for (let x = 0; x < width; x += 1) {
      const y0 = yAt(x);
      const y1 = x + 1 < width ? yAt(x + 1) : y0;
      // Fill the vertical gap so steep segments stay connected.
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
        const cell = Math.floor(y / 4) * columns + Math.floor(x / 2);
        masks[cell] =
          (masks[cell] ?? 0) | (BRAILLE_DOT_BITS[y % 4]?.[x % 2] ?? 0);
      }
    }
    masks.forEach((mask, i) => {
      if (mask) {
        frame.put(i % columns, Math.floor(i / columns), brailleChar(mask));
      }
    });
  };

  return (
    <AsciiGrid
      draw={draw}
      animate={false}
      role="img"
      aria-hidden={false}
      aria-label={label}
      className={className}
    />
  );
};
```

## A bar meter

Eighth blocks give a progress bar eight steps per cell. This one is plain DOM text, so it renders on the server and reads in a screen reader.

```tsx
import { eighthsBar } from "@/lib/ascii";

export const UsageMeter = ({
  value,
  label,
}: {
  value: number;
  label: string;
}) => (
  <div className="font-mono text-sm">
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{Math.round(value * 100)}%</span>
    </div>
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="bg-muted/40 text-ascii-ink whitespace-pre leading-none"
    >
      {eighthsBar(value, 32)}
    </div>
  </div>
);
```

## A terminal pane

Box-drawing frame, a typed line and a blinking cursor, in a phosphor colour. Wrap it in `dark` so it stays a dark screen on a light page.

```tsx
"use client";

import { AsciiGrid, BOX, PHOSPHORS } from "@/lib/ascii";
import type { AsciiGridDrawContext } from "@/lib/ascii";

const LINES = [
  "$ deploy --prod",
  "building...      done in 4.2s",
  "uploading...     12 files",
  "live at https://example.com",
];

const draw = ({ frame, columns, rows, time }: AsciiGridDrawContext) => {
  const box = BOX.rounded;
  frame.write(0, 0, box.tl + box.h.repeat(columns - 2) + box.tr);
  for (let y = 1; y < rows - 1; y += 1) {
    frame.put(0, y, box.v);
    frame.put(columns - 1, y, box.v);
  }
  frame.write(0, rows - 1, box.bl + box.h.repeat(columns - 2) + box.br);
  // Type one character every 40ms, line by line.
  let budget = Math.floor(time * 25);
  LINES.forEach((line, i) => {
    const shown = line.slice(0, Math.max(0, budget));
    budget -= line.length;
    frame.write(2, 1 + i, shown);
    if (budget < 0 && budget > -line.length - 1 && time % 1 < 0.5) {
      frame.put(2 + shown.length, 1 + i, "█");
    }
  });
};

export const DeployTerminal = () => (
  <div className="dark relative h-40 rounded-lg bg-neutral-950">
    <AsciiGrid
      draw={draw}
      ink={PHOSPHORS.p1.ink}
      stillTime={10}
      className="absolute inset-0"
    />
  </div>
);
```

Each phosphor in `PHOSPHORS` has an `ink` and the near-black `paper` of its glass; pass `paper={PHOSPHORS.p1.paper}` to paint the glass instead of the wrapper.

## An image as ASCII

Sample an image into a tone field each frame (or once, for a still), then map it. The same code takes a `<video>` or a webcam `MediaStream`.

```tsx
"use client";

import { useRef } from "react";

import {
  AsciiGrid,
  autoLevels,
  mapTones,
  sampleToField,
  useMediaElement,
} from "@/lib/ascii";
import type {
  AsciiGridDrawContext,
  CharsetName,
  ColorMode,
  ToneField,
} from "@/lib/ascii";

export interface AsciiPhotoProps {
  src: string;
  /** What the photo shows, for screen readers. */
  alt: string;
  /** Default `"standard"`. */
  charset?: CharsetName;
  /** Default `"truecolor"`. */
  colorMode?: ColorMode;
  className?: string;
}

export const AsciiPhoto = ({
  src,
  alt,
  charset = "standard",
  colorMode = "truecolor",
  className,
}: AsciiPhotoProps) => {
  const { element } = useMediaElement(src);
  const fieldRef = useRef<ToneField | undefined>(undefined);

  const draw = ({ frame, columns, rows, metrics }: AsciiGridDrawContext) => {
    if (!element) {
      return;
    }
    const field = sampleToField(element, {
      aspect: (columns * metrics.width) / (rows * metrics.height),
      charset,
      columns,
      fit: "cover",
      into: fieldRef.current,
      rows,
    });
    fieldRef.current = field;
    autoLevels(field);
    mapTones(
      field,
      columns,
      rows,
      { charset, colorMode, grade: { contrast: 1.2 } },
      frame
    );
  };

  return (
    <AsciiGrid
      draw={draw}
      colored={colorMode !== "mono"}
      animate={false}
      role="img"
      aria-hidden={false}
      aria-label={alt}
      className={className}
    />
  );
};
```

`useMediaElement(source)` takes a URL, a `Blob` (a file the user picked) or a `MediaStream`, and returns `{ element, kind, error }`; show a message when `error` is set. `into` reuses the field between frames, and `aspect` tells the sampler the box's real shape so the image isn't stretched. For video, leave `animate` on so each frame resamples; for a webcam, pass the stream from `navigator.mediaDevices.getUserMedia({ video: true })`, set `mirror: true`, and stop its tracks on unmount. Frames never leave the browser.

## A full background with colour, CRT and the pointer

Combine a `field`, a `colorField`, CRT effects and pointer parallax into a full animated piece. For a background that is a picture of a place (a landscape, a city), follow [scenes.md](scenes.md) instead: the city and landscape backgrounds are painted halftone scenes with calm motion and no pointer response.

```tsx
"use client";

import { CRT_FX } from "@/lib/ascii";
import type { AsciiSceneProps } from "@/lib/ascii";
import { AsciiShader } from "@/lib/ascii/shader";

const SHARED = /* glsl */ `
float duneHeight(vec2 p, float t) {
  return 0.35 + 0.12 * snoise(vec2(p.x * 1.4 + t * 0.05, 3.0)) + 0.05 * snoise(vec2(p.x * 5.0, t * 0.1));
}`;

const FIELD = /* glsl */ `${SHARED}
float field(vec2 uv, vec2 res, float t) {
  vec2 p = vec2(uv.x * res.x / res.y, uv.y);
  p.x += (u_pointer.x - 0.5) * 0.15 * u_pointer.z;     // parallax
  float h = duneHeight(p, t);
  float ground = smoothstep(h + 1.5 / res.y, h, p.y) * (0.45 + 0.5 * (h - p.y + 0.3));
  vec2 sun = vec2(res.x / res.y * 0.7, 0.62);
  float glow = exp(-dot(p - sun, p - sun) * 30.0);
  return max(ground, glow);
}`;

const COLOR_FIELD = /* glsl */ `${SHARED}
vec3 colorField(vec2 uv, vec2 res, float t) {
  vec2 p = vec2(uv.x * res.x / res.y, uv.y);
  float sky = smoothstep(0.2, 1.0, uv.y);
  vec3 sand = toSrgb(oklch(0.62, 0.11, 0.9));
  vec3 dusk = toSrgb(oklch(0.55, 0.16, 5.2));
  return p.y < duneHeight(p, t) ? sand : mix(sand, dusk, sky);
}`;

export const DuneBackground = ({
  charset = "dense",
  fx = CRT_FX,
  stillTime = 4,
  ...props
}: AsciiSceneProps) => (
  <AsciiShader
    field={FIELD}
    colorField={COLOR_FIELD}
    charset={charset}
    fx={fx}
    stillTime={stillTime}
    interaction="none"
    {...props}
  />
);
```

`SHARED` appears word for word in both strings, so the engine compiles it once.
