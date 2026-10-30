# Documentation migration report

Completed locally on 2026-10-30 for the v6.10.0 source tree.

## Delivered

- Redesigned the homepage and documentation articles, with grouped navigation, search, light/dark themes, responsive layouts and full-page screenshot enlargement.
- Published 286 local documentation pages: 43 reviewed dashboard guides, operational guides, generated references and a clearly labelled historical archive.
- Generated all 983 tools across 155 modules, all 42 prompt definitions and all 18 top-level configuration blocks from their source catalogs/loaders. `bun run gen` and the existing release hook regenerate these references.
- Reviewed all dashboard guides against their UI and backend paths. `coverage.json` records the source paths for each review. Guides explain controls, fields, filters, confirmations, caching and meaningful limitations.
- Expanded Connecting clients with 27 app/group setup sections, client-specific examples, official sources and shared-service guidance. Corrected HTTP session and legacy SSE limitations against the implementation.
- Saved 58 full-page captures: 43 main pages plus 15 tabs/dialogs. IPs, snapshot/backup names and AAA/OpenVPN usernames are blurred in the capture DOM. Actual JPEG dimensions match all capture records. Contact-sheet review covered all images; detailed review included AAA and OpenVPN live/history views. OCR found no readable IPv4 or known username candidates; this is supplementary evidence, not a general privacy guarantee.
- Mapped all 73 legacy documents to their new destinations before deleting `docs-old`. `migration-map.json` retains original hashes and destination paths. Historical proposals and test reports remain in the archive, rather than being presented as current feature guarantees.
- Reduced the root README from 1,115 lines to roughly 80, retaining setup, navigation, the dashboard film, security guidance and license. Longer instructions now live in the website.
- Added documentation coverage/link/anchor checks and a CI production build. Removed the copied template's unused OpenAPI packages and updated generation/CI paths.

## Validation

- `bun run gen`: passed.
- Reference regeneration after commit formatting: passed; `gen:docs` formats the generated configuration and prompt guides as well as the tool reference, leaving no tracked output drift.
- `cd docs && bun run check:docs --complete`: passed; no pending dashboard detail reviews, all checked internal links and anchors resolve.
- `cd docs && bun run types:check`: passed.
- `cd docs && bun run build`: passed; 577 static routes, including documentation and social cards.
- Root `bun run test:types` and `bun run lint`: passed.
- Focused catalog and screenshot-privacy tests: 20 passed. Privacy test rerun after the lint adjustment: passed.
- Pre-commit validation: root types and lint passed; 36 focused catalog, screenshot-privacy and service-probe tests passed. The full 4,850-test run initially had three ASN-label failures from the unrelated working-tree data edit and one local socket test blocked by the execution environment; that socket test passed when rerun with local networking permitted. The three ASN failures remain outside this documentation change.
- Connecting clients: all internal anchors resolve; 13 JSON/YAML examples parse; desktop and 390px mobile layouts were checked after the production rebuild.
- Browser: rebuilt homepage, light/dark switching, documentation search, screenshot enlargement, desktop layout and 390px mobile guide/sidebar verified. No browser console errors were observed in these checks.

## Limits and follow-up

- The site was validated locally at `http://localhost:4000`; no production deployment or push was performed. Configure `SITE_URL` when publishing. Individual third-party AI apps were not all installed and connected during this documentation review.
- Two upstream Fumadocs/Tailwind CSS optimizer warnings remain for the standard `::highlight(fd-search)` selector. The build succeeds and search works.
- Screenshots show the available local environment, including empty/not-configured states. They are not evidence that every router operation or third-party MCP App host was tested. No router configuration was changed for documentation.
- An existing Drift Guard issue was identified: the promotion control submits the old baseline ID. The guide documents the limitation and the safer fresh-snapshot workflow; changing that runtime behavior is outside this documentation task.
- The unrelated existing change to `src/data/iran-asns.json` was left untouched.
