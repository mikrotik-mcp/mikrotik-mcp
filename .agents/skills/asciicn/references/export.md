# Export

`ascii-export` (`lib/ascii/export.ts`) turns what a renderer drew into files. When this file and the code disagree, the code wins.

## Get the frame

Every renderer and component takes a `handle` ref. The engine fills it with an `AsciiHandle`:

```tsx
"use client";

import { useRef } from "react";

import type { AsciiHandle } from "@/lib/ascii";
import { copyText, toText } from "@/lib/ascii/export";

export const Exportable = () => {
  const handle = useRef<AsciiHandle | null>(null);
  const copy = () => {
    const frame = handle.current?.capture();
    if (frame) {
      void copyText(toText(frame, { trimEnd: true }));
    }
  };
  return (
    <div className="relative h-80">
      <MyBackground handle={handle} className="absolute inset-0" />
      <button type="button" onClick={copy} className="relative">
        Copy as text
      </button>
    </div>
  );
};
```

`handle.current` has `capture()` (the current `AsciiFrame`: `columns`, `rows`, `glyphs`, `colors`), `canvas`, `colors()` (the resolved ink and paper) and `metrics()` (the `CellMetrics`). The GPU renderer reads back the glyphs it drew, so exported text is exactly what is on screen.

## Formats

| Function                                                          | Returns            | Notes                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toText(frame, { trimEnd })`                                      | `string`           | Plain text, one line per row                                                                                                                            |
| `toAnsi(frame, { mode, ansi, ink, paper, background })`           | `string`           | ANSI escape codes. `mode: "truecolor"` (24-bit, default) or `"ansi16"` (snapped to `ansi`: `vga` or `xterm`). Save as `.ans`, or `cat` it in a terminal |
| `toSvg(frame, { metrics, ink, paper, font, shapes })`             | `string`           | Blocks, shades, Braille, box lines and dots become vector shapes (`shapes`, default true); other glyphs are text                                        |
| `toPng(handleOrFrameOrCanvas, { scale, ink, paper, cell, font })` | `Promise<Blob>`    | A handle without `scale` saves the live canvas, CRT effects included; otherwise the frame is re-rendered                                                |
| `recordCanvas(canvas, { durationMs, fps, mimeType })`             | `Promise<Blob>`    | Records the live canvas. `createRecorder(canvas, options)` gives a start/stop recorder for a button                                                     |
| `pickVideoType()`, `videoExtension(type)`                         | `string`           | The first video type the browser can record (WebM first, MP4 in Safari) and its extension                                                               |
| `downloadBlob(blob, name)`, `downloadText(text, name)`            | `void`             | Saves a file                                                                                                                                            |
| `copyText(text)`                                                  | `Promise<boolean>` | Clipboard; resolves `false` when the browser refuses                                                                                                    |

`handle.current.colors()` returns the ink and paper on screen as CSS colours; pass them to `toSvg` and `toPng` so the file matches the theme. `toAnsi` needs `#rrggbb` strings or `[r, g, b]` bytes: convert a CSS colour with `resolveColor` (RGBA from 0 to 1) and scale by 255.

## Static art on the server

`frameToText(frame)` and `AsciiPre` work without a browser, so a frame computed with `createToneField` and `mapTones` can be rendered into a server component, an email, a README or an RSS feed.

## Checks

- Export from a frame that has finished drawing: call `capture()` after the first frame (the root's `data-state` is no longer `fallback`).
- Recording needs `MediaRecorder` and `canvas.captureStream`. Show the record button only when `pickVideoType()` returns a type, and name the file with `videoExtension(type)`: Safari may record MP4 instead of WebM.
- `.ans` files read correctly in terminals that support the chosen mode. Use `ansi16` for maximum compatibility.
