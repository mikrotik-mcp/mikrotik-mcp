# MikroTik MCP documentation website

A Bun/Next.js/Fumadocs site with operational guides, all dashboard pages and a generated tool, configuration and prompt reference.

## Develop

From the repository root, install dependencies with `bun install --frozen-lockfile`, then:

```sh
cd docs
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:4000`. The documentation preview does not start an MCP server or change router settings.

## Validate and build

From the repository root, `bun run gen` regenerates release schemas and the website references. Then, inside `docs/`:

```sh
bun run check:docs --complete
bun run types:check
bun run build
bun run start --port 4000
```

The checker covers all dashboard views, tool names, prompt names, configuration blocks, Markdown links/anchors and screenshot capture records. CI runs these checks and a production build.

## Deploy

Deploy this repository as a Next.js application with **Root Directory = docs**. Install both the root and documentation dependencies when regenerating references; deploy from a revision where generated files are up to date. Set `SITE_URL` to the actual public documentation origin; Vercel's production origin is used when available. Do not point canonical metadata at an unverified domain.

For a self-hosted deployment, use the build/start commands above behind your HTTPS reverse proxy. No production deployment is performed by the local preview command.

## Content and screenshots

- `content/docs/guides/`: setup, operations and contributor guides.
- `content/docs/dashboard/`: every dashboard page, including controls and limitations.
- `content/docs/reference/`, `guides/config-schema.md`, `guides/prompt-catalog.md`: generated contracts; edit source instead.
- `content/docs/archive/`: historical plans and reports, explicitly not current feature promises.
- `coverage.json`: page-level source review evidence.
- `migration-map.json`: destinations and original hashes for the retired documentation.
- `public/screenshots/`, `screenshot-capture.json`: full-page previews and dimensions.

Before saving a new screenshot, apply `scripts/screenshot-privacy.js` to the capture-only DOM with the current snapshot/backup names and AAA/OpenVPN usernames. It masks IPs, those names and matching fields without changing stored data. Capture the full page, inspect the resulting pixels, and update the capture record. Never commit unmasked originals or the private-name input files. The focused regression test is `tests/documentation-screenshot-privacy.spec.ts` at the repository root.

OCR is a supplementary privacy check, not proof that every private string is hidden. Keep descriptions and privacy inputs current when screens change.
