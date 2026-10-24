/**
 * Conservative source-line union for Vitest (Node) and Bun-native integration tests.
 * Vitest defines the complete TypeScript source denominator. Bun can only add a hit
 * to a source file and line already present in that denominator; its different
 * instrumentation cannot silently add or remove coverable lines.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

type Hits = Map<string, Map<number, number>>;
const root = resolve(import.meta.dir, "..");

function parseLcov(source: string): Hits {
  const files: Hits = new Map();
  let current: Map<number, number> | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const raw = line.slice(3);
      const path = isAbsolute(raw) ? relative(root, raw) : raw;
      current = files.get(path) ?? new Map<number, number>();
      files.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [lineNo, count] = line.slice(3).split(",").map(Number);
      if (!Number.isSafeInteger(lineNo) || lineNo < 1 || !Number.isSafeInteger(count) || count < 0)
        throw new Error(`Invalid LCOV source line: ${line}`);
      current.set(lineNo, (current.get(lineNo) ?? 0) + count);
    }
  }
  return files;
}

const [vitest, bun, summary] = await Promise.all([
  readFile(resolve(root, "coverage/lcov.info"), "utf8"),
  readFile(resolve(root, ".cache/bun-native-coverage/lcov.info"), "utf8"),
  readFile(resolve(root, "coverage/coverage-summary.json"), "utf8").then(
    (json) =>
      JSON.parse(json) as {
        total: { lines: { total: number; covered: number } };
      },
  ),
]);
const primary = parseLcov(vitest);
const supplemental = parseLcov(bun);
let total = 0;
let vitestCovered = 0;
let bunOnly = 0;
let fileCount = 0;
for (const [file, lines] of primary) {
  if (!/^src\/.*\.ts$/.test(file) || file.endsWith(".d.ts")) continue;
  fileCount++;
  for (const [lineNo, count] of lines) {
    total++;
    if (count > 0) vitestCovered++;
    else if ((supplemental.get(file)?.get(lineNo) ?? 0) > 0) bunOnly++;
  }
}
if (fileCount === 0 || supplemental.size === 0)
  throw new Error("One or both source coverage reports are empty.");
if (total !== summary.total.lines.total || vitestCovered !== summary.total.lines.covered)
  throw new Error("Vitest LCOV and JSON summary disagree; refusing to report combined coverage.");

const covered = vitestCovered + bunOnly;
const percent = (covered / total) * 100;
process.stdout.write(`src line coverage: ${covered}/${total} (${percent.toFixed(3)}%)\n`);
process.stdout.write(
  `Vitest: ${vitestCovered}; additional Bun-native lines: ${bunOnly}; source files: ${fileCount}\n`,
);
process.stdout.write(
  "Only canonical Vitest source lines count; UI and declaration files are not in the denominator.\n",
);
if (process.argv.includes("--check") && percent <= 90) process.exitCode = 1;
