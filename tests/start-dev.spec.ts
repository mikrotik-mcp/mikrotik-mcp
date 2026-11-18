/// <reference types="bun" />
/** `bun run start:dev` rebuilds the dashboard only when its source is newer than the build. */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { uiIsStale } from "../scripts/start-dev";

test("the UI is stale when the page is missing or older than a source file", () => {
  const dir = mkdtempSync(join(tmpdir(), "start-dev-"));
  const source = join(dir, "ui", "observability");
  mkdirSync(source, { recursive: true });
  const file = join(source, "main.tsx");
  const page = join(dir, "observability.html");
  writeFileSync(file, "");
  expect(uiIsStale(join(dir, "ui"), page)).toBe(true);

  writeFileSync(page, "");
  utimesSync(file, new Date(1000), new Date(1000));
  utimesSync(page, new Date(2000), new Date(2000));
  expect(uiIsStale(join(dir, "ui"), page)).toBe(false);

  utimesSync(file, new Date(3000), new Date(3000));
  expect(uiIsStale(join(dir, "ui"), page)).toBe(true);
});
