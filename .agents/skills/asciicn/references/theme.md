# Theme and colour

## The tokens

`ascii-tokens` writes these into the project's global CSS, in `:root` and `.dark`:

| Variable               | Default                    | What it controls                                                  |
| ---------------------- | -------------------------- | ----------------------------------------------------------------- |
| `--ascii-ink`          | `var(--primary)`           | Glyph colour in `mono`, and the top of the default palette        |
| `--ascii-paper`        | `var(--background)`        | The surface behind the glyphs                                     |
| `--ascii-cell`         | `12px`                     | Glyph cell HEIGHT in CSS px. The width follows the font's advance |
| `--ascii-font`         | the project mono font      | The font glyphs are drawn in                                      |
| `--ascii-glow`         | about 0.35 light, 0.9 dark | Bloom strength, 0 to 1                                            |
| `--ascii-color-<name>` | tuned per theme            | `blue`, `purple`, `green`, `pink`, `orange`, `red`, `grey`        |

Tailwind gets matching utilities from `@theme inline`: `text-ascii-ink`, `bg-ascii-paper`, `text-ascii-blue` and so on.

## Naming colours in props

Every colour prop takes an `AsciiColor`:

- A palette name: `"ink"`, `"blue"`, `"purple"`, `"green"`, `"pink"`, `"orange"`, `"red"`, `"grey"`. These win over the CSS keywords they share.
- A CSS variable name: `"--chart-1"`, `"--ascii-paper"`.
- Any CSS colour: `"var(--accent)"`, `"oklch(0.7 0.15 272)"`, `"#fff"`.

Prefer names and variables. They follow light and dark mode and a site palette switch on the next frame without a reload; literal colours don't.

## Palettes

`palette` is paper first, then inks from faint to strong:

```tsx
<AsciiShader
  field={FIELD}
  colorMode="palette"
  palette={["--ascii-paper", "--chart-5", "--chart-1"]}
/>
```

Two entries (paper, ink) cover most effects. Three to five give depth: the faint ink colours sparse glyphs, the strong ink colours dense ones. For several lines or labels, give each its own colour with `seriesColor(undefined, i)` or the palette names.

## Light and dark

Dark mode comes from the `.dark` class on `<html>`. The renderers watch that class and the `--ascii-*` variables and redraw when they change. To check dark mode in a browser, toggle the class (`document.documentElement.classList.toggle("dark")`); the media query alone doesn't change shadcn themes.

- Glyphs are thin. Keep 4.5:1 between ink and paper, like body text.
- Bloom (`fx.bloom`, scaled by `--ascii-glow`) reads in dark mode and washes out in light mode. Components should read `--ascii-glow` rather than a fixed bloom.
- A section that must always be dark (a terminal, a phosphor screen) wraps itself in `className="dark"` so the tokens take their dark values there.

## Overriding for one section

```tsx
<section style={{ "--ascii-ink": "var(--chart-2)", "--ascii-cell": "16px" } as React.CSSProperties}>
```

Everything inside draws in the new colour and cell size. Type the style as `React.CSSProperties & Record<"--ascii-ink" | "--ascii-cell", string>` if the project forbids casts.
