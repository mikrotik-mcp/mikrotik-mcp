# Dashboard film

A 60-second, 1920 × 1080, 30 fps silent product motion film using the project's orange identity and a slate-blue dashboard stage. It covers all eight current navigation categories; the renderer checks coverage against the real navigation catalog.

This is an **illustrated product tour**, not a screen recording or a redesign of the dashboard itself. The simplified interfaces and values are synthetic. Client addresses use documentation-only ranges. No router or production API is accessed. No music, voice-over, external imagery or private configuration is included.

## Outputs

- `dashboard-film.mp4`: H.264, yuv420p, fast-start web playback.
- `storyboard.png`: the ten keyframes in narrative order.
- `00-intro.png` through `09-outro.png`: full-resolution chapter stills.
- `manifest.json`: timing, format, provenance and covered pages.
- `chapters.vtt`: chapter track.

## Playback in the project README

The root README uses a GitHub-hosted video attachment URL on its own paragraph for inline playback.
A repository MP4 link is a file/download link, not an embedded player, and GitHub strips raw HTML
`<video>` tags. When replacing the film, upload the new MP4 as a GitHub attachment and update that
standalone URL. Keep the [web player](https://mikrotik-mcp.usestrict.dev/motion/index.html) and
repository download link as fallbacks; never copy an expiring media redirect URL into the README.

## Reproduce

From the repository root, with Bun, installed development dependencies and FFmpeg (`libx264`) available:

```sh
bun --no-env-file scripts/render-dashboard-film.ts --check
bun --no-env-file scripts/render-dashboard-film.ts --preview
bun --no-env-file scripts/render-dashboard-film.ts --render
```

The renderer refuses to overwrite an existing MP4. Move the prior export aside before rendering again. Preview PNGs, the manifest and chapter track are regenerated. Frames are streamed directly into FFmpeg instead of filling the disk with intermediate files.

Typography uses locally installed Avenir Next, Helvetica Neue or Arial; glyph shape can differ between platforms. Output should be visually reviewed after changing fonts or copy. The film is self-contained and does not depend on the live service.

## Narrative

| Time  | Chapter              | Focus                                 |
| ----- | -------------------- | ------------------------------------- |
| 00:00 | Introduction         | One connected view                    |
| 00:06 | Monitoring           | Health, flow evidence, activity       |
| 00:12 | Network              | Routers, topology, Wi-Fi, routing     |
| 00:18 | Users & VPN          | Clients, sessions, accounting         |
| 00:24 | Diagnostics          | Paths, packets, preserved evidence    |
| 00:30 | Security             | Incidents, exposure, policy scenarios |
| 00:36 | Router configuration | Preview and explicit review           |
| 00:42 | Backup & recovery    | Snapshots, vaults, rehearsal          |
| 00:48 | MCP workspace        | Memory, tools and permissions         |
| 00:54 | Closing              | Understand. Then act.                 |
