# Coverage audit — October 24, 2026

## Current milestone: source-only line coverage above 90%

At the user's request, the current coverage scope is **TypeScript files under
`src` only**; `ui` is temporarily out of scope. Declaration files are excluded.
All 405 source files remain in the denominator, including unimported modules.
Offline handler, dashboard-route, transport and native SQLite tests do not write
to a live router.

| Metric     |     Source-only baseline |        Latest Vitest run |
| ---------- | -----------------------: | -----------------------: |
| Lines      | 58.71% (14,215 / 24,210) | 86.50% (20,942 / 24,210) |
| Statements | 56.03% (15,793 / 28,182) | 82.91% (23,366 / 28,182) |
| Functions  |   57.99% (2,706 / 4,666) |   82.53% (3,851 / 4,666) |
| Branches   | 50.49% (10,555 / 20,905) | 73.94% (15,458 / 20,905) |

Vitest alone cannot load the Bun-native SQLite stores. The additional **46 Bun
integration tests** exercise those stores in their actual runtime, including
migrations, locks, retention, persistence after reopen, and error handling.
The conservative line union uses the Vitest LCOV report as the complete source
denominator. It adds a Bun hit only where the same file and source line exist in
Vitest's report but have zero Vitest hits. It never sums percentages or changes
the denominator:

| Source lines                         |                         Count |
| ------------------------------------ | ----------------------------: |
| Covered by Vitest                    |                        20,942 |
| Additional lines covered only by Bun |                           849 |
| **Covered by either runner**         | **21,791 / 24,210 (90.008%)** |

The reproducible `bun run test:coverage:combined` command runs both suites and
fails if this source-line union does not exceed 90%. Its LCOV parser checks the
Vitest JSON totals and refuses empty inputs. The latest run passed **4,826 tests
in 374 Vitest files**, **46 tests in 21 Bun files**, typecheck, and lint. This
achieves the requested **source line** milestone, not 90% statements, functions,
branches, UI, or the historical combined `src` + `ui` scope.

The combined-scope measurements below are historical and are intentionally not
compared numerically with the source-only milestone.

## Historical combined-scope status: the overall >90% target is not achieved

This is a partial improvement, not completion of the requested coverage target.
The measured scope is the MCP source and UI (`src/**/*.ts`, `ui/**/*.{ts,tsx}`),
including unimported files. Only declaration files are explicitly excluded.
The separate Raycast extension, maintenance scripts and website assets are outside
this report. No production code was excluded to inflate coverage.

| Metric     | Baseline |  After | Covered / total after |
| ---------- | -------: | -----: | --------------------: |
| Lines      |   47.89% | 56.73% |       20,031 / 35,308 |
| Statements |   46.19% | 54.41% |       22,183 / 40,770 |
| Functions  |   45.32% | 51.99% |         4,479 / 8,615 |
| Branches   |   43.60% | 49.39% |       16,539 / 33,486 |

The baseline is the first successful full-scope measurement after repairing the
coverage provider mismatch, before adding the new tests. Initially no trustworthy
report could run: Vite+ embeds Vitest 5.0.1, but coverage-v8 was pinned to 5.0.5.
The provider is now pinned to 5.0.1. Instrumentation caused two 5-second timeouts
with unrestricted workers; four workers and a coverage-only 15-second timeout
produced a passing run. Ordinary test-run settings are unchanged.

## Verification and next boundaries

- `bun run test:coverage:combined` is the source-line milestone gate. It runs
  Vitest and Bun natively, then checks their conservative line union with
  `scripts/report-combined-coverage.ts`. Both reports must exist and the Vitest
  LCOV/JSON totals must agree.
- `bun run test:coverage:check` remains a separate, stricter gate requiring
  **90.01% in every Vitest metric**. It is not claimed to pass; line coverage in
  Vitest alone is 86.50%, and branches are 73.94%. The existing strict threshold
  was not lowered to manufacture a pass.
- The 90.008% combined line result is very close to the threshold. Future
  changes should add scenario coverage rather than rely on rounding. The largest
  remaining Vitest gap is dashboard request dispatch; branch and function
  coverage need independent work. UI is explicitly outside this source-only
  milestone.
- Tests use fixtures or temporary SQLite databases. No live-router mutation was
  performed. Generated HTML/LCOV/JSON reports are local artifacts.

## Reproduce

```sh
bun install --frozen-lockfile
bun run test:coverage:combined
bun run test:types
bun run lint
```

Open `coverage/index.html` for Vitest's per-file detail. The Vitest machine
reports are `coverage/coverage-summary.json` and `coverage/lcov.info`; Bun's
native LCOV report is `.cache/bun-native-coverage/lcov.info`.
