# Designing a landing page around an ASCII effect

A working ASCII effect on a generic page still reads as generated. The effect has to be the page's identity, drawn from what the product is, and the page around it has to be specific, quiet and true. Do this before you write a field.

## 1. Know the product

The page is for the product in this repo, not for asciicn. asciicn is the tool you build with: don't name it on the page, and don't make the page about ASCII art.

Read the README, `package.json`, the existing pages and any copy in the repo. Write yourself a short brief:

- What the product is and who it is for, in one sentence, in the product's own words.
- The one thing a visitor should do (install, sign up, download, book).
- The facts you can use: features, platforms, prices, numbers. Only facts that are in the repo or the user's message.

If there is no product to read about, ask the user what the page is for. If nobody can answer, pick something plausible, keep it modest, and say what you picked.

## 2. Find the effect in the subject

The hero effect should be something only this product would show. Take it from the product's own world and render it in glyphs, as a field, a CPU grid, an image or a Braille trace:

| The product is about             | An ASCII effect drawn from it                                               |
| -------------------------------- | --------------------------------------------------------------------------- |
| Maps, outdoors, travel           | Braille contour lines of real-looking terrain, a route over them            |
| Audio, music, voice              | A waveform or spectrum, lines stacked like a spectrogram                    |
| Money, trading, analytics        | A price line or volume ridges, a dense band where activity is               |
| Infrastructure, uptime, networks | Packets along paths, a grid of hosts, a pulse at the incident               |
| Weather, climate, energy         | Isobars, a radar sweep, heat rising off a surface                           |
| Sleep, health, calm              | A slow breathing ring, a tide line, a night sky                             |
| Food, drink, physical goods      | The product photo itself as ASCII (`sampleToField`), steam rising in glyphs |
| Space, science, research         | A night sky, orbits, a particle trace, a slow nebula                        |
| A developer tool or API          | The product's real output in a terminal pane: its CLI, its logs, its data   |

A soft glow or drifting noise fits almost any product, which is why it says nothing about this one. Use one only as a supporting layer.

## 3. Compose the page

Spend the boldness in one place: the hero effect. Keep everything else quiet and disciplined.

**Pick the hero that fits**, not the split layout by default:

- **Full-bleed field.** The effect fills the hero and the headline sits on cleared ground (see [recipes.md](recipes.md#a-hero-that-clears-its-headline)).
- **The product shot.** A real product photo or screenshot converted to ASCII, large, with the headline beside or above it. It can resolve into the photo on hover.
- **One big number or object.** A rotating ASCII object or a Braille ring behind a real figure the product has, with the label in HTML.
- **A live demo.** A terminal pane that runs the product's real command, or an effect that responds to one control, so the page shows what the product does.

**Build the rest from the content.** A section exists because the product has something to say there, not because landing pages have one.

- Show, don't list. One wide section that shows a feature working beats three cards that name three features.
- Vary the rhythm: a wide section, then a narrow one; text left, then right. Avoid rows of identical cards.
- Use at most two or three ASCII effects on the page, each tied to content: the hero, a trace of real data, an ASCII product photo, one section break.
- One accent colour at most. The glyph ink carries the page's colour; buttons and text stay in the theme. A phosphor colour is an accent too.
- Typography carries the personality. One family is fine. Set a clear scale with weight and size, sentence case throughout.
- Keep vertical rhythm even (about `py-24` to `py-32` between sections on desktop, `py-16` on a phone) and line lengths under 80 characters.

## 4. Write true, plain copy

- The headline says what the product does for whom, in plain words. No wordplay that needs the subhead to explain it.
- The subhead adds two specifics: how it works, what you get.
- Buttons say what happens: "Download for Mac", "Start a free trial", "Read the docs".
- Use only facts from step 1. No invented stats, testimonials, customer logos, ratings or prices. If a section needs a number the product doesn't have, drop the section.

## 5. Don't ship the tells

These make a page read as generated, whatever the effect looks like:

- An all-caps, letter-spaced label above every heading, or monospace micro-labels used as decoration. ASCII invites terminal styling; use it where the product is a terminal, not as costume on every heading.
- Numbered markers (01, 02, 03) on things that aren't a sequence.
- One word in the headline set apart in italic, grey or colour; a serif display line followed by a grey second line.
- A row of three identical feature cards; a stats strip with invented numbers.
- Captions or pills laid over a visual ("Field study 01", "Signal / in motion"); a round arrow button on a card that goes nowhere.
- A fake product UI built from divs; fake testimonials; placeholder logos.
- A glowing orb or gradient in a rounded card as the whole hero.
- Em dashes, "elevate", "seamless", "unleash", "next-gen", an arrow on every link, decorative coloured dots.

## 6. Look at it as a visitor

Screenshot the whole page at 1440px and 390px, in light and dark mode. Go through every item in section 5 against the screenshots and the code, one by one, and fix each one you find; search the code for `—` and `uppercase`. Then answer honestly:

- In five seconds, can you tell what the product is and what to do next?
- Is the ASCII effect the first thing you notice, and does it belong to this product?
- Would this page be mistaken for any other product's page? If yes, the hero or the copy is generic: go back to step 2.
- Remove one element that isn't earning its place.

Then run every check in [quality.md](quality.md).
