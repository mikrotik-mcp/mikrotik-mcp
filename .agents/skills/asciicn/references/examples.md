# Examples

Components built on the engine. They are references, not a menu: install one when it is exactly what the user asked for, and otherwise write your own and borrow technique from the closest one. Each installs as plain source into `components/asciicn/<name>.tsx`, so you can read its field or grid code. Install one with:

```bash
npx shadcn@latest add https://asciicn.dev/r/<name>.json
```

Each docs page (the `.md` link) has usage, every prop and in-context examples. Read the installed source for the field, the charset choice and the technique.

## City backgrounds

- `dubai`: Dubai at dusk from the desert in dots: the Burj Khalifa rising far above a cluster of towers in blue haze, its stepped spire gold in the last light, over rose and amber dunes under a gold-to-blue sky. Docs: https://asciicn.dev/docs/backgrounds/dubai.md
- `hong-kong`: Victoria Harbour at blue hour in coloured dots: lit towers climbing to the misty ridge of Victoria Peak, the Bank of China Tower and Two IFC, long reflections and a red-sailed junk under a magenta to deep blue sky. Docs: https://asciicn.dev/docs/backgrounds/hong-kong.md
- `london`: Westminster at dusk in dots, modelled in 3D: the floodlit Elizabeth Tower with its clock faces glowing, the Palace of Westminster receding along the river to the Victoria Tower, Westminster Bridge and its lamps, and the Thames mirroring it all under a pale gold to slate sky. Docs: https://asciicn.dev/docs/backgrounds/london.md
- `miami`: Ocean Drive at nightfall in dots: art deco hotels with soft neon on their stepped parapets, palms in silhouette, the glass towers of Brickell in blue haze and a bay holding the neon in broken reflections. Docs: https://asciicn.dev/docs/backgrounds/miami.md
- `new-york`: Manhattan at dusk across the East River: the Empire State Building's lit spire, the Chrysler crown and One World Trade Center against an amber-to-blue sky, with soft window light, broken reflections and a slow ferry. Docs: https://asciicn.dev/docs/backgrounds/new-york.md
- `paris`: Paris at blue hour, built in 3D and printed in dots: the Seine runs between stone quays and Haussmann blocks to the Eiffel Tower, lit gold from within, its reflection broken by slow ripples. Docs: https://asciicn.dev/docs/backgrounds/paris.md
- `rio`: Rio de Janeiro at dusk from the water in dots: Sugarloaf beside Morro da Urca with one cable car crossing, Christ the Redeemer pale on Corcovado, and the lamps of Copacabana curving along the shore under a gold to violet sky. Docs: https://asciicn.dev/docs/backgrounds/rio.md
- `san-francisco`: The Golden Gate Bridge at blue hour in halftone dots: Art Deco towers in International Orange catching the last light, fog rolling under the deck and over the Marin Headlands, city lights on the far shore and the bay mirroring the afterglow. Docs: https://asciicn.dev/docs/backgrounds/san-francisco.md
- `sydney`: Sydney Harbour at blue hour in halftone dots: the Opera House's sails catching a warm glow, the Harbour Bridge with its lamps lit, the city in cool haze and the harbour mirroring them under a peach afterglow. Docs: https://asciicn.dev/docs/backgrounds/sydney.md
- `tokyo`: Tokyo at night in coloured dots, built in 3D: the Tokyo Skytree in pale blue light over a dense city that runs to the horizon, with neon on the near streets, Tokyo Tower small in the distance and a moonlit Mount Fuji under a teal sky. Docs: https://asciicn.dev/docs/backgrounds/tokyo.md

## Painted landscapes

- `balloon-valley`: Early morning over a river valley in halftone dots on cream: cool blue hills fading into haze, pale gold mist, a river catching the low sun and hot-air balloons at different depths. Docs: https://asciicn.dev/docs/landscapes/balloon-valley.md
- `canyon-river`: A desert canyon in late golden hour from a high rim: sunlit terracotta walls with blue shadows step back to glowing buttes while a river winds below, mirroring the blue sky. Docs: https://asciicn.dev/docs/landscapes/canyon-river.md
- `glacier-lagoon`: Icebergs glowing blue-white on a glassy lagoon below a glacier and dark peaks, under a midnight sun sitting gold and rose on the horizon. Docs: https://asciicn.dev/docs/landscapes/glacier-lagoon.md
- `lighthouse`: A lighthouse on a rocky headland at blue hour, its lamp glowing amber over a calm sea, painted in halftone dots. Docs: https://asciicn.dev/docs/landscapes/lighthouse.md
- `redwood-light`: A redwood forest in early morning: giant trunks fading into blue-green haze, golden light shafts slanting onto a fern floor, and slow motes drifting in the light. Docs: https://asciicn.dev/docs/landscapes/redwood-light.md
- `rice-terraces`: Flooded rice terraces at a fresh dawn: silver-blue fields between dark earthen banks with lit grassy tops, mist in the valley and far ridges fading into haze. Docs: https://asciicn.dev/docs/landscapes/rice-terraces.md

## 3D and scenes

- `ascii-donut`: A lit, ray-marched torus spinning in glyphs, with specular highlights, a rim light and drag to spin. Docs: https://asciicn.dev/docs/scenes/ascii-donut.md
- `ascii-globe`: A lit, rotating planet in glyphs with a day and night terminator, ocean glints, an atmosphere, markers and arcs. Docs: https://asciicn.dev/docs/scenes/ascii-globe.md
- `black-hole`: A black hole seen close to edge-on: a thin disk lensed over and under a black shadow, a sharp photon ring and slow streaks flowing round. Docs: https://asciicn.dev/docs/scenes/black-hole.md
- `cyber-skull`: A rotating low-poly skull in glyphs, lit to tones with edge-glyph wireframe, a hinged jaw, glowing eyes and a scan band. Docs: https://asciicn.dev/docs/scenes/cyber-skull.md
- `dna-helix`: A rotating double helix in glyphs, with lit backbones that pass in front of each other and base-pair rungs coloured by base. Docs: https://asciicn.dev/docs/scenes/dna-helix.md
- `mountain-dusk`: Layered ridgelines fading into evening haze, with a setting sun, a rising moon, stars coming out, the odd shooting star and mist in the valleys. Docs: https://asciicn.dev/docs/scenes/mountain-dusk.md
- `ocean-waves`: A moonlit sea in glyphs, with swells rolling in, foam that breaks into lighter glyphs on the crests, a glittering moon path and slow clouds. Docs: https://asciicn.dev/docs/scenes/ocean-waves.md
- `retro-computer`: A vintage workstation in glyphs: a CRT on a desktop unit and a keyboard, its screen typing a live session in real characters. Docs: https://asciicn.dev/docs/scenes/retro-computer.md
- `server-rack`: A data-centre rack in box-drawing glyphs, with drive LEDs that flicker in busy spells, a slow heartbeat, port lights and light pulses running along the fibres. Docs: https://asciicn.dev/docs/scenes/server-rack.md
- `synthwave-sun`: An outrun grid rolling toward a sliced setting sun, between a wireframe ridge and under a glowing horizon. Docs: https://asciicn.dev/docs/scenes/synthwave-sun.md
- `torus-knot`: A lit 3D torus knot tumbling in glyphs, with p and q windings, a breaks-at-crossings outline and drag to turn. Docs: https://asciicn.dev/docs/scenes/torus-knot.md

## Shaders and fields

- `ember`: A low, slow fire in glyphs: flames rise from the bottom edge and break into smoke, while single sparks drift up on the wind. Docs: https://asciicn.dev/docs/fields/ember.md
- `ionize`: Electric blue plasma ribbons: thin, bright and tightly twisted, drawn in Braille dots. Docs: https://asciicn.dev/docs/fields/ionize.md
- `nebula`: Cosmic gas drawn in glyphs: warped clouds with bright filaments, dark dust lanes and a few stars. Every seed is a different nebula. Docs: https://asciicn.dev/docs/fields/nebula.md
- `prism`: Layered glass folds in violet and teal, drawn in glyphs. Each seed bends the ribbons differently and shifts both hues. Docs: https://asciicn.dev/docs/fields/prism.md
- `satin`: Deep magenta satin: a few wide folds that turn slowly and catch the light along their edges, in ANSI shade blocks. Docs: https://asciicn.dev/docs/fields/satin.md
- `seed-field`: Any string drawn as a field of glyphs: folded ribbons of light or warped gas, each seed with its own OKLCH palette, shape and motion. The base of Prism, Ionize, Squall, Satin and Nebula.
- `squall`: Stormy bands of teal and slate that churn and fold across the box, in the classic ASCII ramp. Docs: https://asciicn.dev/docs/fields/squall.md

## Media and filters

- `ascii-canvas`: A glyph pad you paint with the pointer: ink spreads, curls and fades into glowing trails, and clicks send ripples that bend them. Docs: https://asciicn.dev/docs/images/ascii-canvas.md
- `ascii-image`: Any photo redrawn in live glyphs, with every charset and colour mode, auto levels and a pointer spotlight. Docs: https://asciicn.dev/docs/images/ascii-image.md
- `ascii-logo`: An SVG or PNG logo redrawn in crisp glyphs, with shimmer, scan and reveal animations. Docs: https://asciicn.dev/docs/images/ascii-logo.md
- `ascii-portrait`: A face redrawn in fine Braille glyphs, graded for skin and shadow, with contour strokes, a develop reveal and a before/after split with the photo. Docs: https://asciicn.dev/docs/images/ascii-portrait.md
- `ascii-reveal`: An image that resolves out of glyphs: cells lock in and hand over to the real photo along a sweep, on view, on hover or on cue. Docs: https://asciicn.dev/docs/images/ascii-reveal.md
- `ascii-video`: Video, a dropped file or the webcam sampled into glyphs at up to 60 fps, with audio-reactive contrast and jitter. Docs: https://asciicn.dev/docs/images/ascii-video.md
- `avatar`: An avatar drawn in glyphs: initials set over a lit disc of Braille dots, or a photo sampled into a glyph portrait, with a status glyph and overlapping groups. Docs: https://asciicn.dev/docs/images/avatar.md

## Text and typography

- `ascii-countdown`: A launch countdown in big glyph digits that scramble as they change. Docs: https://asciicn.dev/docs/text/ascii-countdown.md
- `ascii-marquee`: A ticker framed in box-drawing rules that steps one glyph at a time, with bullet separators, coloured price changes and an optional second row in reverse. Docs: https://asciicn.dev/docs/text/ascii-marquee.md
- `ascii-text`: Display type drawn as ASCII art in any charset, with an optional decode, scan or wipe reveal, while the real text stays in the page. Docs: https://asciicn.dev/docs/text/ascii-text.md
- `glitch-text`: Text that glitches in short bursts, with slices jumping sideways, letters swapped for block and box glyphs and a colour split, then snaps back clean. Docs: https://asciicn.dev/docs/text/glitch-text.md
- `glyph-rain`: Falling glyphs gather into a message, then fade and form again. Docs: https://asciicn.dev/docs/text/glyph-rain.md
- `scramble-text`: Text whose characters cycle through katakana, braille, CP437, PETSCII or symbol glyphs and settle left to right, without moving the layout. Docs: https://asciicn.dev/docs/text/scramble-text.md
- `typewriter-text`: Terminal typing with uneven keystrokes, a block, underscore or bar cursor, an optional prompt and backspacing through a list of phrases. Docs: https://asciicn.dev/docs/text/typewriter-text.md

## Terminal and UI

- `ascii-badge`: A status badge set in glyphs, such as [ OK ], < beta > or ┤ v2 ├, with tones from the palette, a fixed width for aligned columns and an optional live dot. Docs: https://asciicn.dev/docs/interface/ascii-badge.md
- `ascii-box`: A box-drawing frame that wraps any content and snaps to the glyph cell grid, with labels in its borders and a shade-glyph shadow. Docs: https://asciicn.dev/docs/interface/ascii-box.md
- `ascii-button`: A real button set in glyphs: a box-drawing frame around a label row that inverts like a terminal selection, with a spinner while loading. Docs: https://asciicn.dev/docs/interface/ascii-button.md
- `ascii-card`: A card framed in box-drawing glyphs, with its title set into the top border and an optional glyph glow lighting it from an edge or a corner. Docs: https://asciicn.dev/docs/interface/ascii-card.md
- `ascii-glow`: A glowing aura drawn in glyphs, falling off through any charset from an edge, a corner or any point, for heroes and cards.
- `ascii-tabs`: Tabs drawn as box-drawing folder tabs or a sliding glyph underline, with arrow-key navigation and a roving tab stop. Docs: https://asciicn.dev/docs/interface/ascii-tabs.md
- `divider`: A horizontal or vertical rule drawn in box-drawing glyphs or a repeating glyph pattern, with an optional label or ornament. Docs: https://asciicn.dev/docs/interface/divider.md
- `empty-state`: A box-drawing line drawing (an inbox, a search, a folder or an unplugged cable) with a title, a description and an action, for views with nothing in them yet. Docs: https://asciicn.dev/docs/interface/empty-state.md
- `glyph-trail`: A layer where the pointer paints glyphs that burn bright, cool through the charset and drift away like smoke, with a slow wanderer when nobody draws. Docs: https://asciicn.dev/docs/interface/glyph-trail.md
- `kbd-shortcut`: Keyboard shortcuts drawn as box-drawing keycaps, with Mac and PC labels and caps that press down while the visitor holds the keys. Docs: https://asciicn.dev/docs/interface/kbd-shortcut.md
- `loader`: A loading indicator drawn in glyphs: a spinner from six glyph sequences, walking dots, an eighth-block wave or a Braille comet. Docs: https://asciicn.dev/docs/interface/loader.md
- `not-found`: A 404 page whose code is drawn in sand: gusts wear its edges and grains drift downwind and settle, over a terminal line that echoes the missing path. Docs: https://asciicn.dev/docs/interface/not-found.md
- `progress-bar`: A progress bar drawn in eighth-block glyphs, exact to an eighth of a cell, with stacked parts, step segments and an indeterminate comet. Docs: https://asciicn.dev/docs/interface/progress-bar.md
- `skeleton`: Loading placeholders for text, blocks and avatars made of shade glyphs, with a band of denser glyphs that sweeps across the page. Docs: https://asciicn.dev/docs/interface/skeleton.md
- `status-dot`: A one-glyph status indicator for online, busy, offline and error, with a distinct shape per state and a ping, turn or flash in glyphs. Docs: https://asciicn.dev/docs/interface/status-dot.md
- `terminal-window`: A terminal window framed in box-drawing glyphs that plays a scripted session: typed commands, streamed output, spinners, block progress bars and coloured ok, warn and error lines. Docs: https://asciicn.dev/docs/interface/terminal-window.md
